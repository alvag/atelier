import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentBackend, BackendSession, ToolCall, ToolCallResult } from "./backend.ts";
import { Channel } from "./channel.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	describeError,
	errorEvent,
	type SubagentTag,
	ZERO_USAGE,
} from "./events.ts";
import { CONTEXT_BYTES, createMemoryTool, findSecret, MEMORY_TOOL, type MemoryPort } from "./memory/index.ts";
import type { CompletedFeature } from "./odd/tracker.ts";
import { FEATURE_TOOL, OddTracker, PHASE_TOOL } from "./odd/tracker.ts";
import { loadProjectInstructions, type ProjectInstructions } from "./project-instructions.ts";
import { MEMORY_RULES, ODD_RULES, RISK_RULES } from "./prompt.ts";
import { type ReviewHost, type ReviewOptions, SessionReview, type Spent } from "./review/session-review.ts";
import { RISK_TOOL } from "./review/tool.ts";
import { boundReport, createTaskTool, type SubagentDefinition, TASK_TOOL } from "./subagents/definitions.ts";
import { SANDBOX_OFF, Sandbox } from "./tools/sandbox.ts";
import {
	type ToolContext,
	type ToolDefinition,
	type ToolGate,
	ToolInputError,
	type ToolOutcome,
} from "./tools/types.ts";

type TurnEvent = AtelierEventBody & SubagentTag;

/** Tools a subagent never gets: delegation and the ODD document belong to the parent. */
const PARENT_ONLY = new Set([TASK_TOOL, FEATURE_TOOL, PHASE_TOOL, MEMORY_TOOL, RISK_TOOL]);

export interface ApprovalRequest {
	callId: string;
	command: string;
	/** Why the agent asks to run the command outside the sandbox; present only for that request. */
	reason?: string;
	/** `--yes` does not answer this one: the user must. */
	always?: boolean;
}

export interface SessionOptions {
	backend: AgentBackend;
	cwd: string;
	model?: string;
	tools: readonly ToolDefinition[];
	systemPromptAppend?: string;
	/**
	 * Skips approval for the tool calls that run sandboxed (`--yes`). Never for what a tool says
	 * must always be asked: a command outside the sandbox, or any command when there is no sandbox.
	 */
	autoApprove?: boolean;
	/** Turns the sandbox off for this session (`--no-sandbox`): `bash` runs unsandboxed, every command asks, and the verifier gets no `bash`. */
	noSandbox?: boolean;
	/** Asks the user; without it, calls that need approval are denied. */
	approve?: (request: ApprovalRequest) => Promise<boolean>;
	createId?: () => string;
	/** Enables the task tool. Children get no subagents: they do not delegate. */
	subagents?: SubagentOptions;
	/** Passed to the backend: caps the model requests of one turn. */
	maxRequestsPerTurn?: number;
	/** Turns on ODD tracking: the feature and phase tools, phases and the verbatim user log. */
	odd?: boolean;
	/** Long-term memory, connected by the caller; the session closes it. */
	memory?: MemoryPort;
	/** Why there is no memory, when the caller tried and failed; reported in memory_status. */
	memoryUnavailable?: string;
	/** Why there is no review in this session (it is off); said once, in the first turn. */
	reviewUnavailable?: string;
	/** Adds `home`/.agents/AGENTS.md and the AGENTS.md / CLAUDE.md files from `cwd` up to `home` (excluded) to the system prompt, read once at start. Never given to subagents. */
	projectInstructions?: { home: string };
	/** Turns on RDD: the risk tool, the assessment at the end of each turn and `Session.review`. Never given to subagents. */
	review?: ReviewOptions;
}

export interface SubagentOptions {
	agents: readonly SubagentDefinition[];
	/** A fresh backend of the same kind as the parent's, for each child. */
	createBackend: () => AgentBackend | Promise<AgentBackend>;
}

/**
 * Orchestrates turns against one backend. It stamps every event, merges tool
 * events into the turn stream, owns tool execution and approval, and
 * guarantees each turn ends with exactly one `turn_finished`.
 */
export class Session {
	readonly #options: SessionOptions;
	readonly #tools: Map<string, ToolDefinition>;
	readonly #createId: () => string;
	#backendSession: BackendSession | undefined;
	#turn: Channel<TurnEvent> | undefined;
	/** The subagent running right now, so interrupting or closing reaches it. */
	#child: Session | undefined;
	readonly #odd: OddTracker | undefined;
	readonly #review: SessionReview | undefined;
	/** Recent memory, fetched once at start and given with the first prompt only. */
	#memoryContext = "";
	/** The instruction files read at start; reported with the first turn. */
	#instructions: ProjectInstructions | undefined;
	#announced = false;
	/** The sandbox warning was already said in this turn. */
	#warned = false;
	#abort: AbortController | undefined;
	#closed = false;
	#closing: Promise<void> | undefined;
	#scratchDir: string | undefined;

	private constructor(options: SessionOptions) {
		const subagents = options.subagents;
		const tools = subagents
			? [
					...options.tools,
					createTaskTool(subagents.agents, (agent, prompt, context) =>
						this.#runSubagent(subagents, agent, prompt, context),
					),
				]
			: options.tools;
		this.#odd = options.odd
			? new OddTracker(
					options.cwd,
					(event) => this.#turn?.push(event),
					options.memory ? (feature) => this.#mirror(feature) : undefined,
				)
			: undefined;
		this.#review = options.review
			? new SessionReview(
					options.noSandbox ? { ...options.review, sandbox: new Sandbox({ disabled: SANDBOX_OFF }) } : options.review,
				)
			: undefined;
		const all = [
			...tools,
			...(this.#review ? [this.#review.tool] : []),
			...(this.#odd ? this.#odd.tools() : []),
			...(options.memory ? [createMemoryTool(options.memory)] : []),
		];
		this.#options = { ...options, tools: all };
		this.#tools = new Map(all.map((tool) => [tool.name, tool]));
		this.#createId = options.createId ?? randomUUID;
	}

	static async start(requested: SessionOptions): Promise<Session> {
		// Memory that cannot even give its context is treated as unavailable, with the reason.
		let options = requested;
		let memoryContext = "";
		const memory = requested.memory;
		if (memory) {
			try {
				memoryContext = await Promise.resolve().then(() => memory.context(CONTEXT_BYTES));
			} catch (error) {
				await Promise.resolve()
					.then(() => memory.close())
					.catch(() => {});
				const { memory: _dropped, ...rest } = requested;
				options = { ...rest, memoryUnavailable: `Memory did not answer: ${describeError(error)}` };
			}
		}
		const session = new Session(options);
		session.#memoryContext = memoryContext;
		if (options.projectInstructions) {
			const instructions = await loadProjectInstructions(options.cwd, options.projectInstructions.home);
			if (instructions.files.length > 0 || instructions.dropped.length > 0) session.#instructions = instructions;
		}
		const scratchDir = await mkdtemp(join(tmpdir(), "atelier-session-"));
		session.#scratchDir = scratchDir;
		try {
			session.#backendSession = await options.backend.start({
				cwd: options.cwd,
				...(options.model === undefined ? {} : { model: options.model }),
				systemPromptAppend: [
					options.systemPromptAppend ?? "",
					options.odd ? ODD_RULES : "",
					options.memory ? MEMORY_RULES : "",
					options.review ? RISK_RULES : "",
					session.#instructions?.text ?? "",
				]
					.filter((part) => part !== "")
					.join("\n\n"),
				tools: session.#options.tools,
				executeTool: (call) => session.#executeTool(call),
				compactionState: () => session.#compactionState(),
				...(options.maxRequestsPerTurn === undefined ? {} : { maxRequestsPerTurn: options.maxRequestsPerTurn }),
			});
		} catch (error) {
			await rm(scratchDir, { recursive: true, force: true });
			throw error;
		}
		return session;
	}

	/** What a compaction must not lose: the active feature and its task, the phase, and the memory of the first turn. */
	#compactionState(): string | undefined {
		const lines: string[] = [];
		const odd = this.#odd?.snapshot();
		if (odd?.path !== undefined) {
			const task = odd.task ? `, task ${odd.task.id} "${odd.task.title}" (${odd.task.status})` : "";
			lines.push(`feature: ${odd.path}${task}`);
		}
		if (odd?.phase !== undefined) lines.push(`phase: ${odd.phase}`);
		const memory = this.#memoryContext.trim();
		if (memory !== "") lines.push(`memory:\n${memory}`);
		return lines.length === 0 ? undefined : `<state>\n${lines.join("\n")}\n</state>`;
	}

	get busy(): boolean {
		return this.#turn !== undefined;
	}

	/** Runs one turn. `turnId` lets a caller know the id before the first event (the RPC server answers with it). */
	async *send(prompt: string, turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> {
		yield* this.#stream(turnId, async (turn, signal, backendSession) => {
			// The user's words reach the feature log as the turn starts, without delaying the backend;
			// the turn waits for it before finishing, so a failure is reported inside this turn.
			const logged = this.#odd?.userMessage(prompt);
			// What the agent declared in an earlier turn does not cover this one, and its candidate starts from today's HEAD.
			this.#review?.startTurn(this.#options.cwd, prompt);
			// The first turn says whether memory works and gives the model the recent memory, outside the system prompt.
			let sent = prompt;
			if (!this.#announced) {
				this.#announced = true;
				const memory = this.#options.memory;
				if (this.#instructions)
					turn.push({
						type: "project_instructions",
						files: this.#instructions.files,
						dropped: this.#instructions.dropped,
					});
				if (memory) turn.push({ type: "memory_status", available: true, project: memory.project });
				else if (this.#options.memoryUnavailable !== undefined)
					turn.push({ type: "memory_status", available: false, reason: this.#options.memoryUnavailable });
				if (!this.#options.review && this.#options.reviewUnavailable !== undefined)
					turn.push({ type: "review_status", available: false, reason: this.#options.reviewUnavailable });
				if (this.#memoryContext.trim() !== "") sent = `<memory>\n${this.#memoryContext}\n</memory>\n\n${prompt}`;
			}
			let finish: Extract<AtelierEventBody, { type: "turn_finished" }> | undefined;
			let failed = false;
			try {
				for await (const event of backendSession.send(sent)) {
					if (event.type === "turn_finished") finish ??= event;
					else {
						if (event.type === "error") failed = true;
						turn.push(event);
					}
				}
			} catch (error) {
				failed = true;
				turn.push(errorEvent("backend_error", describeError(error)));
			}
			await logged;
			const ended = finish ?? {
				type: "turn_finished",
				stopReason: failed ? "error" : "incomplete",
				usage: { ...ZERO_USAGE },
			};
			// A change left by a turn that finished well is assessed before the turn ends; its cost joins the turn's.
			const clean = !failed && finish !== undefined && !signal.aborted && !NOT_REVIEWED.has(finish.stopReason);
			if (!clean || !this.#review) return ended;
			return addSpent(ended, await this.#review.endOfTurn(this.#reviewHost(turn, signal, backendSession)));
		});
	}

	/**
	 * Reviews the current change on request: any risk, no consent. Against HEAD, or against the commit `base` names.
	 * A turn like `send`, with one `turn_finished`.
	 */
	async *review(turnId: string = this.#createId(), base?: string): AsyncGenerator<AtelierEvent> {
		yield* this.#stream(turnId, async (turn, signal, backendSession) => {
			if (!this.#review) {
				turn.push(errorEvent("review_unavailable", "Review is off for this session.", true));
				return { type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } };
			}
			const spent = await this.#review.onDemand(this.#reviewHost(turn, signal, backendSession), base);
			const stopReason = signal.aborted ? "interrupted" : spent.refused ? "error" : "end_turn";
			return addSpent({ type: "turn_finished", stopReason, usage: { ...ZERO_USAGE } }, spent);
		});
	}

	/** Summarizes the older history now. A turn like `send`, with one `turn_finished`; no review follows it. */
	async *compact(instructions?: string, turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> {
		yield* this.#stream(turnId, async (turn, _signal, backendSession) => {
			if (!backendSession.compact) {
				turn.push(errorEvent("compaction_unavailable", "This backend cannot compact its context.", true));
				return { type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } };
			}
			let finish: Extract<AtelierEventBody, { type: "turn_finished" }> | undefined;
			let failed = false;
			try {
				for await (const event of backendSession.compact(instructions)) {
					if (event.type === "turn_finished") finish ??= event;
					else {
						if (event.type === "error") failed = true;
						turn.push(event);
					}
				}
			} catch (error) {
				failed = true;
				turn.push(errorEvent("backend_error", describeError(error)));
			}
			return finish ?? { type: "turn_finished", stopReason: failed ? "error" : "incomplete", usage: { ...ZERO_USAGE } };
		});
	}

	/** The turn machinery `send`, `review` and `compact` share: closed/busy rules, the channel, and exactly one `turn_finished`. */
	async *#stream(
		turnId: string,
		work: (
			turn: Channel<TurnEvent>,
			signal: AbortSignal,
			backendSession: BackendSession,
		) => Promise<Extract<AtelierEventBody, { type: "turn_finished" }>>,
	): AsyncGenerator<AtelierEvent> {
		let seq = 0;
		const stamp = (body: TurnEvent): AtelierEvent => ({ ...body, seq: ++seq, turnId });

		const backendSession = this.#backendSession;
		if (this.#closed || !backendSession) {
			yield stamp(errorEvent("session_closed", "The session is closed."));
			yield stamp({ type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } });
			return;
		}
		if (this.#turn) {
			yield stamp(errorEvent("busy", "A turn is already running.", true));
			yield stamp({ type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } });
			return;
		}

		const turn = new Channel<TurnEvent>();
		this.#turn = turn;
		this.#warned = false;
		const abort = new AbortController();
		this.#abort = abort;
		const started = performance.now();
		const pump = (async () => {
			let finish: Extract<AtelierEventBody, { type: "turn_finished" }>;
			try {
				finish = await work(turn, abort.signal, backendSession);
			} catch (error) {
				turn.push(errorEvent("turn_failed", describeError(error)));
				finish = { type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } };
			}
			turn.push({ ...finish, durationMs: Math.round(performance.now() - started) });
			turn.close();
		})();

		try {
			for await (const body of turn) yield stamp(body);
		} finally {
			if (!turn.closed) {
				this.#abort?.abort();
				await backendSession.interrupt().catch(() => {});
			}
			await pump;
			this.#turn = undefined;
			this.#abort = undefined;
		}
	}

	/** What a review may use of this session: the turn's stream, its signal, one correction turn and child sessions. */
	#reviewHost(turn: Channel<TurnEvent>, signal: AbortSignal, backendSession: BackendSession): ReviewHost {
		const feature = this.#odd?.snapshot().path;
		return {
			cwd: this.#options.cwd,
			model: this.#options.model,
			...(feature === undefined ? {} : { feature: resolve(this.#options.cwd, feature) }),
			signal,
			push: (event) => turn.push(event),
			correct: async (message) => {
				let usage = ZERO_USAGE;
				let costUsd: number | undefined;
				let requests: number | undefined;
				let ok = false;
				let failed = false;
				try {
					for await (const event of backendSession.send(message)) {
						if (event.type === "turn_finished") {
							usage = event.usage;
							costUsd = event.costUsd;
							requests = event.requests;
							ok = !NOT_REVIEWED.has(event.stopReason);
						} else {
							if (event.type === "error") failed = true;
							turn.push(event);
						}
					}
				} catch (error) {
					failed = true;
					turn.push(errorEvent("backend_error", describeError(error)));
				}
				return {
					ok: ok && !failed,
					usage,
					...(costUsd === undefined ? {} : { costUsd }),
					...(requests === undefined ? {} : { requests }),
				};
			},
			startChild: (options) => Session.start(options),
			createId: this.#createId,
		};
	}

	/** Aborts running tools and asks the backend to stop the turn. */
	async interrupt(): Promise<void> {
		if (!this.#turn) return;
		// Aborting reaches a running subagent too: it listens to the tool's signal.
		this.#abort?.abort();
		await this.#backendSession?.interrupt();
	}

	/** Closes the backend; every call waits for the same close to finish. */
	close(): Promise<void> {
		if (!this.#closing) {
			this.#closed = true;
			const scratchDir = this.#scratchDir;
			// .then() turns a synchronous throw from close() into a rejection, so cleanup still runs.
			this.#closing = Promise.resolve()
				.then(() => this.#child?.close())
				.then(() => this.#review?.close())
				.then(() => this.#odd?.close())
				.then(() => this.#options.memory?.close().catch(() => {}))
				.then(() => this.#backendSession?.close())
				.finally(() => (scratchDir === undefined ? undefined : rm(scratchDir, { recursive: true, force: true })));
		}
		return this.#closing;
	}

	async #executeTool(call: ToolCall): Promise<ToolCallResult> {
		const callId = call.callId ?? this.#createId();
		const emit = (event: AtelierEventBody) => this.#turn?.push(event);
		emit({ type: "tool_call_started", callId, tool: call.tool, input: call.input });
		this.#odd?.toolStarted(call.tool, call.input);

		const fail = (summary: string): ToolCallResult => {
			emit({ type: "tool_call_finished", callId, ok: false, summary, truncated: false });
			return { ok: false, output: summary };
		};

		const tool = this.#tools.get(call.tool);
		if (!tool) return fail(`Unknown tool: ${call.tool}`);

		try {
			const signal = this.#abort?.signal;
			const context: ToolContext = {
				cwd: this.#options.cwd,
				...(signal ? { signal } : {}),
				...(this.#scratchDir === undefined ? {} : { scratchDir: this.#scratchDir }),
				callId,
				...(this.#options.noSandbox ? { sandboxOff: true } : {}),
			};
			const gate = await this.#gate(tool, call.input, context);
			if (gate.refusal) {
				emit({ type: "tool_call_finished", callId, ok: false, summary: gate.refusal.summary, truncated: false });
				return { ok: false, output: gate.refusal.output };
			}
			if (gate.warning !== undefined && !this.#warned) {
				this.#warned = true;
				emit({ type: "sandbox_warning", reason: gate.warning });
			}
			const { approval } = gate;
			if (approval && (approval.always || !this.#options.autoApprove)) {
				const { command, reason } = approval;
				emit({ type: "approval_requested", callId, command, ...(reason === undefined ? {} : { reason }) });
				const request = {
					callId,
					command,
					...(reason === undefined ? {} : { reason }),
					...(approval.always ? { always: true } : {}),
				};
				const approved = (await this.#options.approve?.(request)) ?? false;
				if (!approved) return fail("The user denied this command.");
			}
			const outcome = await tool.execute(call.input, context);
			emit({
				type: "tool_call_finished",
				callId,
				ok: outcome.ok,
				summary: outcome.summary,
				truncated: outcome.truncated,
				...(outcome.fullOutputPath === undefined ? {} : { fullOutputPath: outcome.fullOutputPath }),
			});
			return { ok: outcome.ok, output: outcome.output };
		} catch (error) {
			const prefix = error instanceof ToolInputError ? "Invalid input" : "Tool failed";
			return fail(`${prefix}: ${describeError(error)}`);
		}
	}

	/** What the tool says about the call; a tool without a gate only has the command to approve. */
	async #gate(tool: ToolDefinition, input: unknown, context: ToolContext): Promise<ToolGate> {
		if (tool.gate) return tool.gate(input, context);
		const command = tool.approvalCommand(input);
		return command === undefined ? {} : { approval: { command } };
	}

	/** Runs one child turn with its own context and turns its final text into the report. */
	async #runSubagent(
		options: SubagentOptions,
		agent: SubagentDefinition,
		prompt: string,
		{ callId, signal }: ToolContext,
	): Promise<ToolOutcome> {
		const fail = (output: string): ToolOutcome => ({ ok: false, output, summary: output, truncated: false });
		let child: Session;
		try {
			const backend = await options.createBackend();
			const model = agent.models[backend.id] ?? this.#options.model;
			child = await Session.start({
				backend,
				cwd: this.#options.cwd,
				...(model === undefined ? {} : { model }),
				// In the definition's order; a tool the parent lacks is skipped, and task never: children do not delegate.
				tools: agent.tools.flatMap((name) => {
					const tool = PARENT_ONLY.has(name) ? undefined : this.#tools.get(name);
					return tool ? [tool] : [];
				}),
				systemPromptAppend: agent.prompt,
				maxRequestsPerTurn: agent.maxRequests,
				...(this.#options.autoApprove === undefined ? {} : { autoApprove: this.#options.autoApprove }),
				...(this.#options.noSandbox ? { noSandbox: true } : {}),
				...(this.#options.approve === undefined ? {} : { approve: this.#options.approve }),
				createId: this.#createId,
			});
		} catch (error) {
			return fail(`The ${agent.name} subagent could not start: ${describeError(error)}`);
		}
		this.#child = child;
		const stop = () => void child.interrupt();
		signal?.addEventListener("abort", stop, { once: true });
		const tag: SubagentTag = { ...(callId === undefined ? {} : { parentCallId: callId }), agent: agent.name };
		try {
			// Only the text after the child's last tool call is its answer.
			let report = "";
			let failure: string | undefined;
			let stopReason = "incomplete";
			for await (const event of child.send(prompt)) {
				// Clients see the child's work in the parent's turn; the parent model never does.
				const { seq: _seq, turnId: _turnId, ...body } = event;
				this.#turn?.push({ ...body, ...tag });
				if (event.type === "text_delta") report += event.text;
				else if (event.type === "tool_call_started") report = "";
				else if (event.type === "error") failure ??= `${event.code}: ${event.message}`;
				else if (event.type === "turn_finished") stopReason = event.stopReason;
			}
			if (stopReason === "error" || stopReason === "interrupted" || failure !== undefined)
				return fail(`The ${agent.name} subagent failed (${stopReason}): ${failure ?? "no details"}`);
			if (report.trim() === "") return fail(`The ${agent.name} subagent returned no report.`);
			const bounded = boundReport(report);
			return {
				ok: true,
				output: bounded.text,
				summary: `${agent.name}: ${bounded.text.length} characters`,
				truncated: bounded.truncated,
			};
		} finally {
			signal?.removeEventListener("abort", stop);
			this.#child = undefined;
			await child.close();
		}
	}

	/** Keeps a finished feature in memory. Never throws: the feature change it follows is already saved. */
	async #mirror(feature: CompletedFeature): Promise<void> {
		const memory = this.#options.memory;
		if (!memory) return;
		const secret = findSecret(feature.text);
		if (secret) {
			this.#turn?.push(
				errorEvent(
					"memory_mirror_skipped",
					`Feature ${feature.name} was not saved to memory: it contains what looks like ${secret}.`,
					true,
				),
			);
			return;
		}
		try {
			await memory.save({
				title: `Feature ${feature.name}: ${feature.title}`,
				type: "architecture",
				content: feature.text,
				topicKey: `odd/${feature.name}/tasks`,
			});
		} catch (error) {
			this.#turn?.push(
				errorEvent(
					"memory_mirror_failed",
					`Feature ${feature.name} was not saved to memory: ${describeError(error)}`,
					true,
				),
			);
		}
	}
}

/** Stop reasons after which a turn is neither assessed nor trusted as a correction. */
const NOT_REVIEWED = new Set(["error", "interrupted", "incomplete"]);

/** The turn's closing event with the review's usage and cost added. */
function addSpent(
	ended: Extract<AtelierEventBody, { type: "turn_finished" }>,
	spent: Spent,
): Extract<AtelierEventBody, { type: "turn_finished" }> {
	const { usage } = ended;
	const cost =
		ended.costUsd === undefined && spent.costUsd === undefined
			? undefined
			: (ended.costUsd ?? 0) + (spent.costUsd ?? 0);
	const requests =
		ended.requests === undefined && spent.requests === undefined
			? undefined
			: (ended.requests ?? 0) + (spent.requests ?? 0);
	return {
		...ended,
		...(requests === undefined ? {} : { requests }),
		usage: {
			input: usage.input + spent.usage.input,
			output: usage.output + spent.usage.output,
			cacheRead: usage.cacheRead + spent.usage.cacheRead,
			cacheWrite: usage.cacheWrite + spent.usage.cacheWrite,
		},
		...(cost === undefined ? {} : { costUsd: cost }),
	};
}
