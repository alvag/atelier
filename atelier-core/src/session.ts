import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { FEATURE_TOOL, OddTracker, PHASE_TOOL } from "./odd/tracker.ts";
import { boundReport, createTaskTool, type SubagentDefinition, TASK_TOOL } from "./subagents/definitions.ts";
import { type ToolContext, type ToolDefinition, ToolInputError, type ToolOutcome } from "./tools/types.ts";

type TurnEvent = AtelierEventBody & SubagentTag;

/** Tools a subagent never gets: delegation and the ODD document belong to the parent. */
const PARENT_ONLY = new Set([TASK_TOOL, FEATURE_TOOL, PHASE_TOOL]);

export interface ApprovalRequest {
	callId: string;
	command: string;
}

export interface SessionOptions {
	backend: AgentBackend;
	cwd: string;
	model?: string;
	tools: readonly ToolDefinition[];
	systemPromptAppend?: string;
	/** Skips approval for every tool call (`--yes`). */
	autoApprove?: boolean;
	/** Asks the user; without it, calls that need approval are denied. */
	approve?: (request: ApprovalRequest) => Promise<boolean>;
	createId?: () => string;
	/** Enables the task tool. Children get no subagents: they do not delegate. */
	subagents?: SubagentOptions;
	/** Passed to the backend: caps the model requests of one turn. */
	maxRequestsPerTurn?: number;
	/** Turns on ODD tracking: the feature and phase tools, phases and the verbatim user log. */
	odd?: boolean;
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
		this.#odd = options.odd ? new OddTracker(options.cwd, (event) => this.#turn?.push(event)) : undefined;
		const all = this.#odd ? [...tools, ...this.#odd.tools()] : tools;
		this.#options = { ...options, tools: all };
		this.#tools = new Map(all.map((tool) => [tool.name, tool]));
		this.#createId = options.createId ?? randomUUID;
	}

	static async start(options: SessionOptions): Promise<Session> {
		const session = new Session(options);
		const scratchDir = await mkdtemp(join(tmpdir(), "atelier-session-"));
		session.#scratchDir = scratchDir;
		try {
			session.#backendSession = await options.backend.start({
				cwd: options.cwd,
				...(options.model === undefined ? {} : { model: options.model }),
				systemPromptAppend: options.systemPromptAppend ?? "",
				tools: session.#options.tools,
				executeTool: (call) => session.#executeTool(call),
				...(options.maxRequestsPerTurn === undefined ? {} : { maxRequestsPerTurn: options.maxRequestsPerTurn }),
			});
		} catch (error) {
			await rm(scratchDir, { recursive: true, force: true });
			throw error;
		}
		return session;
	}

	get busy(): boolean {
		return this.#turn !== undefined;
	}

	/** Runs one turn. `turnId` lets a caller know the id before the first event (the RPC server answers with it). */
	async *send(prompt: string, turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> {
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
		this.#abort = new AbortController();
		// The user's words reach the feature log as the turn starts, without delaying the backend;
		// the turn waits for it before finishing, so a failure is reported inside this turn.
		const logged = this.#odd?.userMessage(prompt);
		const pump = (async () => {
			let finish: AtelierEventBody | undefined;
			let failed = false;
			try {
				for await (const event of backendSession.send(prompt)) {
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
			turn.push(
				finish ?? { type: "turn_finished", stopReason: failed ? "error" : "incomplete", usage: { ...ZERO_USAGE } },
			);
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
				.then(() => this.#odd?.close())
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
			const command = tool.approvalCommand(call.input);
			if (command !== undefined && !this.#options.autoApprove) {
				emit({ type: "approval_requested", callId, command });
				const approved = (await this.#options.approve?.({ callId, command })) ?? false;
				if (!approved) return fail("The user denied this command.");
			}
			const signal = this.#abort?.signal;
			const outcome = await tool.execute(call.input, {
				cwd: this.#options.cwd,
				...(signal ? { signal } : {}),
				...(this.#scratchDir === undefined ? {} : { scratchDir: this.#scratchDir }),
				callId,
			});
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
}
