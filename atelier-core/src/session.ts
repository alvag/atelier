import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	BackendSummary,
	ResumeState,
	SessionChange,
	ToolCall,
	ToolCallResult,
} from "./backend.ts";
import { Channel } from "./channel.ts";
import { COMPACTED_HEADER } from "./compaction/compactor.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	type BackendChange,
	describeError,
	errorEvent,
	type PhaseAgent,
	type PhaseSpent,
	type SessionProfile,
	type SubagentTag,
	ZERO_USAGE,
} from "./events.ts";
import type { McpManager } from "./mcp/manager.ts";
import { createMcpTools, MCP_CALL_TOOL, MCP_SEARCH_TOOL, mcpInstructionsNote, mcpPromptBlock } from "./mcp/tools.ts";
import {
	CONTEXT_BYTES,
	createMemoryTool,
	findSecret,
	MEMORY_TOOL,
	type MemoryPort,
	SESSION_SUMMARY_TYPE,
} from "./memory/index.ts";
import type { PermissionMode } from "./modes.ts";
import type { CompletedFeature } from "./odd/tracker.ts";
import { FEATURE_TOOL, OddTracker, PHASE_TOOL } from "./odd/tracker.ts";
import {
	CLASSIFIER_INSTRUCTION,
	CLASSIFIER_TIMEOUT_MS,
	classifierPrompt,
	denialMessage,
	lastMessageTail,
	type PreviousTurn,
	parseDecision,
	pauseReason,
} from "./permission-classifier.ts";
import { thinkingToSend } from "./pricing.ts";
import {
	compactionSettings,
	type FrozenProfile,
	orchestratorBackend,
	profileChanges,
	profileSummary,
	type RoleBackendFactory,
	roleSettings,
	roleStartMessage,
	type ThinkingLevel,
} from "./profiles/index.ts";
import { loadProjectInstructions, type ProjectInstructions } from "./project-instructions.ts";
import { MEMORY_RULES, ODD_RULES, RISK_RULES } from "./prompt.ts";
import { type ReviewHost, type ReviewOptions, SessionReview, type Spent } from "./review/session-review.ts";
import { RISK_TOOL } from "./review/tool.ts";
import type { SavedConfig } from "./sessions/format.ts";
import type { SessionRecorder } from "./sessions/recorder.ts";
import { loadSkills, type Skills, skillsPrompt } from "./skills.ts";
import { addPhaseSpent, addPhases, onePhase, phaseAgent, withEffectiveEffort } from "./spent.ts";
import { boundReport, createTaskTool, type SubagentDefinition, TASK_TOOL } from "./subagents/definitions.ts";
import { SANDBOX_MECHANISM, SANDBOX_OFF, Sandbox } from "./tools/sandbox.ts";
import {
	type ToolContext,
	type ToolDefinition,
	type ToolGate,
	ToolInputError,
	type ToolOutcome,
} from "./tools/types.ts";

type TurnEvent = AtelierEventBody & SubagentTag;

/** Errors a backend reports when its credentials are missing or refused. */
const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set(["not_logged_in", "authentication_error"]);
/** Tools a subagent never gets: delegation and the ODD document belong to the parent. */
const PARENT_ONLY = new Set([
	TASK_TOOL,
	FEATURE_TOOL,
	PHASE_TOOL,
	MEMORY_TOOL,
	RISK_TOOL,
	MCP_SEARCH_TOOL,
	MCP_CALL_TOOL,
]);

export interface ApprovalRequest {
	callId: string;
	command: string;
	/** Why the agent asks to run the command outside the sandbox; present only for that request. */
	reason?: string;
	/** Present when the question is not about a `bash` command: `edit` asks to change a file outside the usual places. */
	tool?: string;
	/** The guard's confirm rule the command matches (`recursive removal`, `git push`, ...); `bash` only. */
	confirm?: string;
}

/** What `auto` decides with: a backend for the classifier's separate model call. Never given to children. */
export interface PermissionClassifierOptions {
	/** A fresh backend for each classification: the one the profile's `permission-classifier` entry names, or the session's kind. */
	createBackend: RoleBackendFactory;
	/** How long one classification may take before the user is asked instead; 60 seconds by default. */
	timeoutMs?: number;
}

/** How much the session asks the user before a tool call. */
export type { PermissionMode };

export interface SessionOptions {
	backend: AgentBackend;
	cwd: string;
	model?: string;
	/** Thinking level for every request of this session; an explicit one wins over the orchestrator's. */
	thinking?: ThinkingLevel;
	/**
	 * The profile resolved at start: kept as it is for the whole session. The orchestrator's entry gives the
	 * main agent its model (unless `model` is given) and thinking level; the others reach the child roles.
	 */
	profile?: FrozenProfile;
	/** The summary request's model and level, already settled for this session's backend (children of a profiled session). */
	compaction?: { model?: string; thinking?: ThinkingLevel };
	tools: readonly ToolDefinition[];
	systemPromptAppend?: string;
	/**
	 * What the user is asked; `normal` by default. No mode asks about a command the sandbox contains, except
	 * one the guard's confirm category matches (recursive removal, `git push`, ...), which every mode asks.
	 * `normal` and `auto` ask about what the sandbox does not contain (a command outside it, any command without
	 * it, a file outside the working directory); `yolo` asks nothing there, and waives the confirm category only
	 * for a plain `git push` or `git rebase`. The guard and the protected paths refuse in every mode, and
	 * subagents always run in `normal`.
	 */
	permissionMode?: PermissionMode;
	/** In `auto`, decides what would ask the user; without it `auto` asks like `normal`. Subagents never get one. */
	permissionClassifier?: PermissionClassifierOptions;
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
	/**
	 * The user's MCP servers, started by the caller; the session closes them. With at least one listed server the agent
	 * gets `mcp_search` and `mcp_call` and the system prompt lists the servers. Never given to subagents.
	 */
	mcp?: McpManager;
	/** Long-term memory, connected by the caller; the session closes it. */
	memory?: MemoryPort;
	/** Why there is no memory, when the caller tried and failed; reported in memory_status. */
	memoryUnavailable?: string;
	/** Why the saved default mode was not used (an invalid file); said once, in the first turn, as a recoverable error. */
	permissionModeProblem?: string;
	/** Why there is no review in this session (it is off); said once, in the first turn. */
	reviewUnavailable?: string;
	/** Adds `home`/.agents/AGENTS.md and the AGENTS.md / CLAUDE.md files from `cwd` up to `home` (excluded) to the system prompt, read once at start. Never given to subagents. */
	projectInstructions?: { home: string };
	/** Lists the skills of `.agents/skills/` (from `cwd` up to the repo root, then `home`'s) in the system prompt, found once at start. Never given to subagents. */
	skills?: { home: string };
	/** Turns on RDD: the risk tool, the assessment at the end of each turn and `Session.review`. Never given to subagents. */
	review?: ReviewOptions;
	/**
	 * Saves the session as it runs: its configuration, prompts, events and what the backend needs to resume. Never given
	 * to subagents or review roles. Recording is best effort: a failed write is reported in the next turn, once.
	 */
	record?: SessionRecorder;
	/** The backend resumes this saved conversation instead of starting an empty one; start rejects when it cannot. */
	resume?: ResumeState;
}

/** What the main agent runs with, as `Session.configure` and the `session_configured` event say it. */
export interface SessionConfiguration {
	backend: string;
	/** Absent while the backend's default model runs and nothing changed it. */
	model?: string;
	thinking?: ThinkingLevel;
	permissionMode: PermissionMode;
	profile?: SessionProfile;
	/** A turn is running: the model and level above wait for it to end. */
	pending: boolean;
	/** Only in the answer to `setBackend`: what the change did to the history. */
	backendChange?: BackendChange;
}

/** What a caller changes in the main agent: the model, the thinking level, or both. */
export type MainChange = Omit<SessionChange, "compaction">;

/** A change the session or its backend refuses; `code` is what the protocol answers. */
export class ConfigureError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

const THINKING_BACKENDS: ReadonlySet<string> = new Set(["claude-code", "anthropic-api"]);

export interface SubagentOptions {
	agents: readonly SubagentDefinition[];
	/** A fresh backend for each child: the one `name` says, or the parent's kind when the profile names none. */
	createBackend: RoleBackendFactory;
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
	/** The main agent's model and thinking level: the explicit choice, then the orchestrator's entry; `configure` changes them. */
	#model: string | undefined;
	#thinking: ThinkingLevel | undefined;
	/** A change asked while a turn runs: held until the turn ends. */
	#pending: MainChange | undefined;
	/** A profile asked while a turn runs: held with `#pending`, and applied after it. */
	#pendingProfile: FrozenProfile | undefined;
	/** A backend asked while a turn runs: held with `#pending`, and switched to after the turn. */
	#pendingBackend: { backend: AgentBackend; model?: string } | undefined;
	/** The model and the level were chosen by the user (at start or with `configure`): a profile does not change them. */
	#explicitModel: boolean;
	#explicitThinking: boolean;
	/** Changes made one after another, so a turn never starts between a change and its backend call. */
	#changes: Promise<unknown> = Promise.resolve();
	#changing = 0;
	/** The model, level or mode changed and the clients were not told yet. */
	#unannounced = false;
	/** What the profile reported when it was frozen; said once, in the next turn. */
	#profileNotices: string[];
	/** What the profile's files held when the last turn began, to tell what changed since. */
	#profileFiles: Record<string, string>;
	/** The summary request's model and level, from the compaction entry; none on a backend that compacts on its own. */
	#compaction: { model?: string; thinking?: ThinkingLevel } | undefined;
	#backendSession: BackendSession | undefined;
	/** The id of the backend that started `#backendSession`: the label of the state it produces. */
	#backendSessionId = "";
	/** The system prompt every backend of this session starts with. */
	#systemPrompt = "";
	/** A turn ran: there is a conversation for another backend to take over. */
	#hadTurn = false;
	/** The summary a new backend took over, until a turn of its own: a second change before one passes it on again. */
	#carried: string | undefined;
	/** The summary in the form compaction carries it, given to the new backend with its first prompt. */
	#handoff: string | undefined;
	/** What the summaries of backend changes cost, added to the next `turn_finished` as the `handoff` part. */
	#handoffSpent: PhaseSpent | undefined;
	/** What the last backend change did to the history, said once in `session_configured`. */
	#backendChange: BackendChange | undefined;
	/** Events from outside a turn (a summary that was not saved), said at the start of the next one. */
	#notices: AtelierEventBody[] = [];
	/** The main agent as its backend's `session_started` described it: what the turn's parts say it ran with. */
	#mainAgent: PhaseAgent | undefined;
	#turn: Channel<TurnEvent> | undefined;
	/** The subagent running right now, so interrupting or closing reaches it. */
	#child: Session | undefined;
	readonly #odd: OddTracker | undefined;
	readonly #review: SessionReview | undefined;
	/** Recent memory, fetched once at start and given with the first prompt only. */
	#memoryContext = "";
	/** The instruction files read at start; reported with the first turn. */
	#instructions: ProjectInstructions | undefined;
	/** The skills found at start; reported with the first turn. */
	#skills: Skills | undefined;
	#announced = false;
	/** The MCP servers whose instructions the model was already given. */
	readonly #mcpGiven = new Set<string>();
	/** The configuration the session started with was saved. */
	#recordedConfig = false;
	/** What the backend that ran the turn answered at its end, until the turn's last event is saved. */
	#endState: ResumeState | undefined;
	#endBackend = "";
	/** The first failed write was reported; the ones after it are not. */
	#saveFailureSaid = false;
	/** The sandbox warning was already said in this turn. */
	#warned = false;
	/** The user's prompt of the turn running now, verbatim: what the classifier judges an action against. */
	#turnPrompt: string | undefined;
	/** The last `send` turn that finished: the rest the classifier knows of the conversation. */
	#previousTurn: PreviousTurn | undefined;
	/** The main agent's text since its last tool call in this turn: what the user reads before writing the next prompt. */
	#lastMessage = "";
	/** What the classifier did in this turn; it pauses for the rest of the turn when these reach their limits. */
	#classifier = { consecutive: 0, denials: 0, failures: 0 };
	/** What the classifier's calls cost in this turn, added to `turn_finished` as the `classifier` part. */
	#classifierSpent: PhaseSpent | undefined;
	/** Real paths outside the usual places that the user approved for editing; only that exact file, only this session. */
	readonly #approvedPaths = new Set<string>();
	#abort: AbortController | undefined;
	#closed = false;
	#closing: Promise<void> | undefined;
	#scratchDir: string | undefined;
	/** Every compaction summary of this session updates the same memory. */
	readonly #summaryKey = `session/${randomUUID()}/summary`;
	/** Summaries being saved; the turn that compacted waits for them before it finishes. */
	readonly #archiving = new Set<Promise<void>>();

	private constructor(options: SessionOptions) {
		const subagents = options.subagents;
		const orchestrator = roleSettings(options.profile, "orchestrator", undefined);
		this.#model = options.model ?? orchestrator.model;
		this.#thinking = options.thinking ?? orchestrator.thinking;
		this.#explicitModel = options.model !== undefined;
		this.#explicitThinking = options.thinking !== undefined;
		this.#profileFiles = { ...options.profile?.files };
		this.#profileNotices = (options.profile?.resolved.reports ?? []).map(({ path, message }) => `${path}: ${message}`);
		// A child gets the compaction already settled for its own backend; a session works it out from the profile.
		const compaction =
			options.compaction !== undefined
				? { compaction: options.compaction }
				: compactionSettings(options.profile, options.backend.id);
		if (compaction.notice !== undefined) this.#profileNotices.push(compaction.notice);
		this.#compaction = compaction.compaction;
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
			...(options.mcp && mcpPromptBlock(options.mcp) !== "" ? createMcpTools(options.mcp) : []),
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
		if (options.skills) {
			const skills = await loadSkills(options.cwd, options.skills.home);
			if (skills.skills.length > 0 || skills.warnings.length > 0) session.#skills = skills;
		}
		const scratchDir = await mkdtemp(join(tmpdir(), "atelier-session-"));
		session.#scratchDir = scratchDir;
		session.#systemPrompt = [
			options.systemPromptAppend ?? "",
			options.odd ? ODD_RULES : "",
			options.memory ? MEMORY_RULES : "",
			options.review ? RISK_RULES : "",
			session.#instructions?.text ?? "",
			skillsPrompt(session.#skills?.skills ?? []),
			options.mcp ? mcpPromptBlock(options.mcp) : "",
		]
			.filter((part) => part !== "")
			.join("\n\n");
		try {
			session.#backendSession = await options.backend.start({
				...session.#startOptions(session.#model, session.#thinking, session.#compaction),
				...(options.resume === undefined ? {} : { resume: options.resume }),
			});
			session.#backendSessionId = options.backend.id;
		} catch (error) {
			await rm(scratchDir, { recursive: true, force: true });
			throw error;
		}
		return session;
	}

	/** What every backend of this session starts with: the folder, tools, prompt and the core's callbacks. */
	#startOptions(
		model: string | undefined,
		thinking: ThinkingLevel | undefined,
		compaction: { model?: string; thinking?: ThinkingLevel } | undefined,
	): BackendStartOptions {
		const options = this.#options;
		return {
			cwd: options.cwd,
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			...(compaction === undefined ? {} : { compaction }),
			systemPromptAppend: this.#systemPrompt,
			tools: options.tools,
			executeTool: (call) => this.#executeTool(call),
			compactionState: () => this.#compactionState(),
			...(options.memory ? { compacted: (summary: string) => this.#archive(summary) } : {}),
			...(options.maxRequestsPerTurn === undefined ? {} : { maxRequestsPerTurn: options.maxRequestsPerTurn }),
			...(options.record === undefined ? {} : { persist: true }),
		};
	}

	/** Whether `bash` runs in the sandbox, asked without running a command; undefined when the session has no such `bash`. */
	#sandboxStatus(): Promise<AtelierEventBody> | undefined {
		const tool = this.#options.tools.find((candidate) => candidate.sandboxStatus !== undefined);
		if (!tool?.sandboxStatus) return undefined;
		return tool
			.sandboxStatus({ cwd: this.#options.cwd, ...(this.#options.noSandbox ? { sandboxOff: true } : {}) })
			.then((status) =>
				status.available
					? { type: "sandbox_status", sandboxed: true, mechanism: SANDBOX_MECHANISM }
					: { type: "sandbox_status", sandboxed: false, reason: status.reason },
			);
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
		yield* this.#stream(turnId, prompt, async (turn, signal, backendSession) => {
			// The user's words reach the feature log as the turn starts, without delaying the backend;
			// the turn waits for it before finishing, so a failure is reported inside this turn.
			this.#turnPrompt = prompt;
			const logged = this.#odd?.userMessage(prompt);
			// What the agent declared in an earlier turn does not cover this one, and its candidate starts from today's HEAD.
			this.#review?.startTurn(this.#options.cwd, prompt);
			// The first turn says whether memory works and gives the model the recent memory, outside the system prompt.
			let sent = prompt;
			if (!this.#announced) {
				this.#announced = true;
				const memory = this.#options.memory;
				// Not awaited when there is nothing to ask: a turn without `bash` starts its backend at once.
				const sandboxStatus = this.#sandboxStatus();
				if (sandboxStatus) turn.push(await sandboxStatus);
				if (this.#instructions)
					turn.push({
						type: "project_instructions",
						files: this.#instructions.files,
						dropped: this.#instructions.dropped,
					});
				if (this.#skills)
					turn.push({
						type: "skills_loaded",
						skills: this.#skills.skills.map(({ name, path }) => ({ name, path })),
						warnings: this.#skills.warnings,
					});
				if (memory) turn.push({ type: "memory_status", available: true, project: memory.project });
				else if (this.#options.memoryUnavailable !== undefined)
					turn.push({ type: "memory_status", available: false, reason: this.#options.memoryUnavailable });
				if (!this.#options.review && this.#options.reviewUnavailable !== undefined)
					turn.push({ type: "review_status", available: false, reason: this.#options.reviewUnavailable });
				this.#sayProfileNotices(turn);
				if (this.#options.permissionModeProblem !== undefined)
					turn.push(errorEvent("permission_mode_invalid", this.#options.permissionModeProblem, true));
				if (this.#memoryContext.trim() !== "") sent = `<memory>\n${this.#memoryContext}\n</memory>\n\n${prompt}`;
			}
			// Servers that connected since the last prompt, with no description, say what they offer once.
			const mcpNote = this.#options.mcp ? mcpInstructionsNote(this.#options.mcp, this.#mcpGiven) : undefined;
			if (mcpNote !== undefined) sent = `${mcpNote}\n\n${sent}`;
			// A backend that took the conversation over by a summary gets it with its first prompt.
			if (this.#handoff !== undefined) {
				sent = `${this.#handoff}\n\n${sent}`;
				this.#handoff = undefined;
				this.#carried = undefined;
			}
			this.#hadTurn = true;
			let finish: Extract<AtelierEventBody, { type: "turn_finished" }> | undefined;
			let failed = false;
			this.#lastMessage = "";
			try {
				for await (const event of backendSession.send(sent)) {
					if (event.type === "turn_finished") finish ??= event;
					else {
						if (event.type === "error") failed = true;
						if (event.type === "session_started") this.#mainAgent = phaseAgent("orchestrator", event);
						if (event.type === "text_delta") this.#lastMessage += event.text;
						turn.push(this.#withOrchestrator(this.#withProfile(this.#withMode(event))));
					}
				}
			} catch (error) {
				failed = true;
				turn.push(errorEvent("backend_error", describeError(error)));
			}
			this.#previousTurn = { request: prompt, lastMessage: lastMessageTail(this.#lastMessage) };
			await logged;
			const ended = withMainPhase(
				finish ?? {
					type: "turn_finished",
					stopReason: failed ? "error" : "incomplete",
					usage: { ...ZERO_USAGE },
				},
				withEffectiveEffort(this.#mainAgent, backendSession.effectiveEffort?.()),
			);
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
		yield* this.#stream(turnId, undefined, async (turn, signal, backendSession) => {
			if (!this.#review) {
				turn.push(errorEvent("review_unavailable", "Review is off for this session.", true));
				return { type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } };
			}
			const spent = await this.#review.onDemand(this.#reviewHost(turn, signal, backendSession), base);
			const stopReason = signal.aborted ? "interrupted" : spent.refused ? "error" : "end_turn";
			return addSpent({ type: "turn_finished", stopReason, usage: { ...ZERO_USAGE } }, spent);
		});
	}

	/**
	 * Undoes the correction an escalated review left in the worktree: the review of this session `reviewId` names, or
	 * the repository's latest escalated one, from its receipts. A turn like `send`, with one `turn_finished`; no model
	 * call and no review follow it.
	 */
	async *undoCorrection(reviewId?: string, turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> {
		yield* this.#stream(turnId, undefined, async (turn) => {
			if (!this.#review) {
				turn.push(errorEvent("review_unavailable", "Review is off for this session.", true));
				return { type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } };
			}
			const undone = await this.#review.undo({ push: (event) => turn.push(event), cwd: this.#options.cwd }, reviewId);
			return { type: "turn_finished", stopReason: undone ? "end_turn" : "error", usage: { ...ZERO_USAGE } };
		});
	}

	/** Summarizes the older history now. A turn like `send`, with one `turn_finished`; no review follows it. */
	async *compact(instructions?: string, turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> {
		yield* this.#stream(turnId, undefined, async (turn, _signal, backendSession) => {
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

	/** The turn machinery `send`, `review`, `undoCorrection` and `compact` share: closed/busy rules, the channel, and exactly one `turn_finished`. */
	async *#stream(
		turnId: string,
		/** The user's prompt when the turn answers one: the saved transcript starts the turn with it. */
		prompt: string | undefined,
		work: (
			turn: Channel<TurnEvent>,
			signal: AbortSignal,
			backendSession: BackendSession,
		) => Promise<Extract<AtelierEventBody, { type: "turn_finished" }>>,
	): AsyncGenerator<AtelierEvent> {
		let seq = 0;
		const stamp = (body: TurnEvent): AtelierEvent => ({ ...body, seq: ++seq, turnId });

		const opening = this.#backendSession;
		if (this.#closed || !opening) {
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
		this.#recordStart(prompt, turnId);
		this.#warned = false;
		this.#turnPrompt = undefined;
		this.#classifier = { consecutive: 0, denials: 0, failures: 0 };
		this.#classifierSpent = undefined;
		const abort = new AbortController();
		this.#abort = abort;
		const started = performance.now();
		// A backend change made just before this turn replaces the session this turn runs on.
		let backendSession: BackendSession = opening;
		const pump = (async () => {
			let finish: Extract<AtelierEventBody, { type: "turn_finished" }>;
			try {
				// The change made just before this turn reaches the backend before the turn's prompt does.
				if (this.#changing > 0) await this.#changes;
				// A change that arrived as the last turn was ending is applied before this one starts.
				if (this.#pending !== undefined || this.#pendingBackend !== undefined) await this.#applyPending(turn);
				backendSession = this.#backendSession ?? backendSession;
				this.#announceConfiguration(turn);
				this.#sayNotices(turn);
				if (this.#announced) this.#sayProfileNotices(turn);
				// Not awaited without a profile: a session without one starts its turn on the same tick as always.
				if (this.#options.profile) await this.#noticeProfileChanges(turn, this.#options.profile);
				finish = await work(turn, abort.signal, backendSession);
			} catch (error) {
				turn.push(errorEvent("turn_failed", describeError(error)));
				finish = { type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } };
			}
			await Promise.all(this.#archiving);
			// The state of the backend that ran the turn, before a change made at its end can replace the backend.
			if (this.#options.record) this.#endState = this.#backendSession?.resumeState?.();
			this.#endBackend = this.#backendSessionId;
			// A change asked during the turn lands now, between this turn and the next.
			await this.#applyPending(turn);
			finish = this.#withHandoff(this.#withClassifier(finish));
			turn.push({ ...finish, durationMs: Math.round(performance.now() - started) });
			turn.close();
		})();

		try {
			for await (const body of turn) {
				const event = stamp(body);
				// The state goes after the turn's events and before its end, which is the last line of the turn.
				if (event.type === "turn_finished") this.#options.record?.state(this.#endBackend, this.#endState);
				this.#options.record?.event(event);
				// The file holds the turn before a client hears it ended.
				if (event.type === "turn_finished") await this.#recordFlush();
				yield event;
			}
		} finally {
			if (!turn.closed) {
				this.#abort?.abort();
				await (this.#backendSession ?? backendSession).interrupt().catch(() => {});
			}
			await pump;
			this.#turn = undefined;
			this.#abort = undefined;
		}
	}

	/** The first turn saves the configuration it starts with; every turn saves its prompt. */
	#recordStart(prompt: string | undefined, turnId: string): void {
		const record = this.#options.record;
		if (!record) return;
		if (!this.#recordedConfig) {
			this.#recordedConfig = true;
			const { backend, model, thinking, permissionMode, profile } = this.configuration();
			record.config({
				backend: backend as SavedConfig["backend"],
				...(model === undefined ? {} : { model }),
				...(thinking === undefined ? {} : { thinking }),
				mode: permissionMode,
				...(profile?.name === undefined ? {} : { profile: profile.name }),
			});
		}
		if (prompt !== undefined) record.prompt(turnId, prompt);
	}

	/** Waits for the saved entries; a write that failed is said in the next turn. */
	async #recordFlush(): Promise<void> {
		const record = this.#options.record;
		if (!record) return;
		await record.flush();
		const failure = record.takeFailure();
		if (failure !== undefined && !this.#saveFailureSaid) {
			this.#saveFailureSaid = true;
			this.#notices.push(errorEvent("session_not_saved", `The session could not be saved: ${failure}`, true));
		}
	}

	/** A profile file that changed since the last turn began is said once; the session keeps the profile it froze. */
	async #noticeProfileChanges(turn: Channel<TurnEvent>, profile: FrozenProfile): Promise<void> {
		const { changes, files } = await profileChanges(profile, this.#profileFiles);
		this.#profileFiles = files;
		for (const { path, message } of changes) turn.push(errorEvent("profile_changed", `${path} ${message}`, true));
	}

	/** Changes the mode for the next tool calls of this session; children keep running in `normal`. */
	setPermissionMode(mode: PermissionMode): void {
		if (mode !== (this.#options.permissionMode ?? "normal")) this.#unannounced = true;
		this.#options.permissionMode = mode;
	}

	/**
	 * Changes the main agent's model or thinking level from the next turn on; the history stays. Between turns the
	 * backend gets the change now; while a turn runs the change is held and applied when it ends, never in the middle.
	 * Rejects with a `ConfigureError` when the backend cannot take it, and then nothing changes.
	 */
	async configure(change: MainChange): Promise<SessionConfiguration> {
		const backendSession = this.#backendSession;
		if (this.#closed || !backendSession) throw new ConfigureError("session_closed", "The session is closed.");
		if (!backendSession.configure)
			throw new ConfigureError(
				"configure_unsupported",
				`The ${this.#options.backend.id} backend cannot change the model or the effort of an open session.`,
			);
		if (this.#turn) {
			// A model chosen while a backend change waits belongs to the backend that is coming.
			const held = this.#pendingBackend;
			if (held !== undefined && change.model !== undefined) held.model = change.model;
			const { model: _model, ...level } = change;
			this.#pending = { ...this.#pending, ...(held === undefined ? change : level) };
		} else {
			this.#changing++;
			const applying = this.#changes.then(() => this.#apply(change));
			this.#changes = applying.catch(() => {}).finally(() => this.#changing--);
			await applying;
		}
		return this.configuration();
	}

	/**
	 * Takes a new frozen profile for the roles that start from the next turn on: subagents, verifier, lenses, refuter,
	 * validator, classifier and compaction. The orchestrator's entry sets the main model and level through `configure`'s
	 * path, except what the user chose. Held while a turn runs, like `configure`. Rejects with a `ConfigureError` when
	 * the orchestrator's entry names another backend than the session's, or the backend cannot take the change; nothing
	 * changes then.
	 */
	async setProfile(profile: FrozenProfile): Promise<SessionConfiguration> {
		const backendSession = this.#backendSession;
		if (this.#closed || !backendSession) throw new ConfigureError("session_closed", "The session is closed.");
		const named = orchestratorBackend(profile);
		const running = this.#pendingBackend?.backend.id ?? this.#options.backend.id;
		if (named !== undefined && named !== running)
			throw new ConfigureError(
				"profile_backend_change",
				`Profile "${profile.resolved.name ?? "default"}" runs the orchestrator on ${named}, but this session runs on ${running}; the backend of an open session does not change with the profile. To move the session to another backend use session.set_backend, then set the profile.`,
			);
		if (!backendSession.configure && Object.keys(this.#planProfile(profile, this.#pending)).length > 0)
			throw new ConfigureError(
				"configure_unsupported",
				`The ${this.#options.backend.id} backend cannot change the model or the effort of an open session.`,
			);
		if (this.#turn) this.#pendingProfile = profile;
		else {
			this.#changing++;
			const applying = this.#changes.then(() => this.#apply(undefined, profile));
			this.#changes = applying.catch(() => {}).finally(() => this.#changing--);
			await applying;
		}
		return this.configuration();
	}

	/** What the orchestrator's entry and the compaction entry of `profile` change in the backend, leaving what the user chose. */
	#planProfile(profile: FrozenProfile, user: MainChange | undefined): SessionChange {
		const entry = roleSettings(profile, "orchestrator", undefined);
		const change: SessionChange = {};
		if (!this.#explicitModel && user?.model === undefined && entry.model !== undefined && entry.model !== this.#model)
			change.model = entry.model;
		if (
			!this.#explicitThinking &&
			user?.thinking === undefined &&
			entry.thinking !== undefined &&
			entry.thinking !== this.#thinking
		)
			change.thinking = entry.thinking;
		const compaction = compactionSettings(profile, this.#options.backend.id).compaction;
		if (JSON.stringify(compaction) !== JSON.stringify(this.#compaction)) change.compaction = compaction ?? null;
		return change;
	}

	/** The configuration the next turn runs with, and whether a held change is part of it. */
	configuration(): SessionConfiguration {
		const held = this.#pendingProfile && this.#planProfile(this.#pendingProfile, this.#pending);
		const coming = this.#pendingBackend;
		const model = coming ? coming.model : (this.#pending?.model ?? held?.model ?? this.#model);
		const thinking = this.#pending?.thinking ?? held?.thinking ?? this.#thinking;
		const profile = this.#pendingProfile ?? this.#options.profile;
		return {
			backend: coming?.backend.id ?? this.#options.backend.id,
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			permissionMode: this.#options.permissionMode ?? "normal",
			...(profile === undefined ? {} : { profile: profileSummary(profile) }),
			pending: this.#pending !== undefined || this.#pendingProfile !== undefined || coming !== undefined,
		};
	}

	/**
	 * Moves the session to `backend` from the next turn on. The conversation is summarized by the backend it leaves
	 * (a compaction's summary), the new backend starts with `model` (absent: the profile's orchestrator entry, then its
	 * default) and gets the summary with its first prompt, the old backend is closed, and the summary is saved to memory
	 * as a compaction summary is. Detail and the prompt cache are lost. Between turns the change is made now; while a
	 * turn runs it is held and made when the turn ends. Rejects with a `ConfigureError` when the summary cannot be had,
	 * the old backend cannot summarize or the new one does not start; the session keeps its old backend untouched then.
	 */
	async setBackend(backend: AgentBackend, model?: string): Promise<SessionConfiguration> {
		const backendSession = this.#backendSession;
		if (this.#closed || !backendSession) throw new ConfigureError("session_closed", "The session is closed.");
		const from = this.#options.backend.id;
		if (backend.id === from) {
			if (this.#pendingBackend === undefined)
				throw new ConfigureError(
					"same_backend",
					`The session already runs on ${from}; session.set_model changes its model.`,
				);
			// Asking for the backend it runs on takes back a change that was waiting.
			this.#pendingBackend = undefined;
			return this.configuration();
		}
		if (this.#turn) {
			if (!backendSession.summarize) throw summaryUnsupported(from);
			this.#pendingBackend = { backend, ...(model === undefined ? {} : { model }) };
			return { ...this.configuration(), backendChange: { from, summarized: true } };
		}
		this.#changing++;
		const applying = this.#changes.then(() => this.#switch(backend, model));
		this.#changes = applying.catch(() => {}).finally(() => this.#changing--);
		const backendChange = await applying;
		return { ...this.configuration(), backendChange };
	}

	/** The summary, the new backend, the swap and the old backend's close, in that order; any failure before the swap changes nothing. */
	async #switch(next: AgentBackend, requested: string | undefined): Promise<BackendChange> {
		const old = this.#backendSession;
		if (this.#closed || !old) throw new ConfigureError("session_closed", "The session is closed.");
		const from = this.#options.backend.id;
		let summary: BackendSummary | undefined;
		if (this.#carried !== undefined) summary = { text: this.#carried, usage: { ...ZERO_USAGE } };
		else if (this.#hadTurn) {
			if (!old.summarize) throw summaryUnsupported(from);
			const failed = (reason: string) =>
				new ConfigureError(
					"summary_failed",
					`The summary of the conversation could not be made, so the session stays on ${from}: ${reason}`,
				);
			try {
				summary = await old.summarize();
			} catch (error) {
				throw failed(describeError(error));
			}
			this.#chargeHandoff(summary);
			if (summary.text.trim() === "") throw failed("the summary is empty.");
		}
		const profile = this.#options.profile;
		const entry = roleSettings(profile, "orchestrator", undefined);
		const model = requested ?? (orchestratorBackend(profile) === next.id ? entry.model : undefined);
		const compaction = compactionSettings(profile, next.id);
		let started: BackendSession;
		try {
			started = await next.start(this.#startOptions(model, this.#thinking, compaction.compaction));
		} catch (error) {
			throw new ConfigureError(
				"backend_start_failed",
				`${next.id} could not start, so the session stays on ${from}: ${describeError(error)}`,
			);
		}
		this.#backendSession = started;
		this.#backendSessionId = next.id;
		this.#options.backend = next;
		this.#model = model;
		this.#explicitModel = requested !== undefined;
		this.#compaction = compaction.compaction;
		if (compaction.notice !== undefined) this.#profileNotices.push(compaction.notice);
		this.#mainAgent = undefined;
		this.#backendChange = { from, summarized: summary !== undefined };
		this.#unannounced = true;
		if (summary !== undefined) {
			const state = this.#compactionState();
			this.#handoff = [`${COMPACTED_HEADER}\n\n<summary>\n${summary.text}\n</summary>`, state]
				.filter((part) => part !== undefined)
				.join("\n\n");
			if (this.#carried === undefined) await this.#saveSummary(summary.text);
			this.#carried = summary.text;
		}
		await old.close().catch(() => {});
		return this.#backendChange;
	}

	/** The summary's cost joins the next `turn_finished`, also when the change then failed: it was spent. */
	#chargeHandoff({ usage, requests, costUsd }: BackendSummary): void {
		const spent: PhaseSpent = {
			usage,
			...(requests === undefined ? {} : { requests }),
			...(costUsd === undefined ? {} : { costUsd }),
		};
		this.#handoffSpent = this.#handoffSpent ? addPhaseSpent(this.#handoffSpent, spent) : spent;
	}

	/**
	 * Gives the backend the user's change and what `profile` brings (the user's choices win), then takes them as the
	 * session's own; a refusal leaves the backend, the choices and the profile as they were.
	 */
	async #apply(user: MainChange | undefined, profile?: FrozenProfile): Promise<void> {
		const change: SessionChange = { ...(profile && this.#planProfile(profile, user)), ...user };
		if (user !== undefined || Object.keys(change).length > 0) {
			try {
				await this.#backendSession?.configure?.(change);
			} catch (error) {
				throw new ConfigureError("configure_failed", describeError(error));
			}
		}
		if (change.model !== undefined) this.#model = change.model;
		if (change.thinking !== undefined) this.#thinking = change.thinking;
		if (user?.model !== undefined) this.#explicitModel = true;
		if (user?.thinking !== undefined) this.#explicitThinking = true;
		if (change.compaction !== undefined) this.#compaction = change.compaction ?? undefined;
		if (profile) this.#adopt(profile);
		this.#unannounced = true;
		this.#patchMainAgent();
	}

	/** Takes `profile` as the frozen one: its files are the ones to watch, and what it dropped is said in the next turn. */
	#adopt(profile: FrozenProfile): void {
		this.#options.profile = profile;
		this.#profileFiles = { ...profile.files };
		const notice = compactionSettings(profile, this.#options.backend.id).notice;
		this.#profileNotices = [
			...profile.resolved.reports.map(({ path, message }) => `${path}: ${message}`),
			...(notice === undefined ? [] : [notice]),
		];
	}

	/** Says what the profile reported when it was frozen, once. */
	#sayProfileNotices(turn: Channel<TurnEvent>): void {
		for (const notice of this.#profileNotices) turn.push(errorEvent("profile_warning", notice, true));
		this.#profileNotices = [];
	}

	/** The turn parts name the model and effort the backend was told, also when it does not say `session_started` again. */
	#patchMainAgent(): void {
		const agent = this.#mainAgent;
		if (agent === undefined) return;
		const next: PhaseAgent = { ...agent, ...(this.#model === undefined ? {} : { model: this.#model }) };
		const backend = this.#options.backend.id;
		if (this.#thinking !== undefined && THINKING_BACKENDS.has(backend)) {
			const sent = thinkingToSend(next.model, this.#thinking, backend as "claude-code" | "anthropic-api");
			if (sent !== undefined) {
				next.effort = sent.report;
				delete next.effectiveEffort;
			}
		}
		this.#mainAgent = next;
	}

	/** Applies what a turn held; a failure is said in that turn and the old configuration stays. */
	async #applyPending(turn: Channel<TurnEvent>): Promise<void> {
		const change = this.#pending;
		const profile = this.#pendingProfile;
		const backend = this.#pendingBackend;
		this.#pending = undefined;
		this.#pendingProfile = undefined;
		this.#pendingBackend = undefined;
		// The backend comes first: the model, the level and the profile are for the one that runs from now on.
		if (backend !== undefined) {
			try {
				await this.#switch(backend.backend, backend.model);
			} catch (error) {
				turn.push(
					errorEvent(error instanceof ConfigureError ? error.code : "configure_failed", describeError(error), true),
				);
			}
		}
		if (change !== undefined || profile !== undefined) {
			try {
				await this.#apply(change, profile);
			} catch (error) {
				turn.push(errorEvent("configure_failed", describeError(error), true));
			}
		}
		this.#announceConfiguration(turn);
	}

	/** Says the configuration once after it changed. */
	#announceConfiguration(turn: Channel<TurnEvent>): void {
		if (!this.#unannounced) return;
		this.#unannounced = false;
		const { pending: _pending, ...configuration } = this.configuration();
		const backendChange = this.#backendChange;
		this.#backendChange = undefined;
		turn.push({
			type: "session_configured",
			...configuration,
			...(backendChange === undefined ? {} : { backendChange }),
		});
	}

	/** Says what happened outside a turn, now that there is one. */
	#sayNotices(turn: Channel<TurnEvent>): void {
		for (const notice of this.#notices.splice(0)) turn.push(notice);
	}

	/** In the turn running, or in the next one when none runs. */
	#say(event: AtelierEventBody): void {
		if (this.#turn) this.#turn.push(event);
		else this.#notices.push(event);
	}

	/** `session_started` says the session's permission mode. */
	#withMode(event: AtelierEventBody): AtelierEventBody {
		if (event.type !== "session_started") return event;
		return { ...event, permissionMode: this.#options.permissionMode ?? "normal" };
	}

	/** The main agent's `session_started` says the profile this session froze. */
	#withProfile(event: AtelierEventBody): AtelierEventBody {
		const profile = this.#options.profile;
		if (event.type !== "session_started" || profile === undefined) return event;
		return { ...event, profile: profileSummary(profile) };
	}

	/** A credential error of the backend the profile chose for the orchestrator (not an explicit one) names that role and backend. */
	#withOrchestrator(event: AtelierEventBody): AtelierEventBody {
		if (event.type !== "error" || !CREDENTIAL_ERRORS.has(event.code)) return event;
		const backend = orchestratorBackend(this.#options.profile);
		if (backend === undefined || backend !== this.#options.backend.id) return event;
		return { ...event, message: `orchestrator: ${backend}: ${event.message}` };
	}

	/** What a review may use of this session: the turn's stream, its signal, one correction turn and child sessions. */
	#reviewHost(turn: Channel<TurnEvent>, signal: AbortSignal, backendSession: BackendSession): ReviewHost {
		const feature = this.#odd?.snapshot().path;
		return {
			cwd: this.#options.cwd,
			model: this.#model,
			settings: (role) => roleSettings(this.#options.profile, role, this.#model, this.#thinking),
			compaction: (backendId) => compactionSettings(this.#options.profile, backendId).compaction,
			...(feature === undefined ? {} : { feature: resolve(this.#options.cwd, feature) }),
			signal,
			push: (event) => turn.push(event),
			delivered: () => turn.drained(signal),
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
							if (event.type === "session_started") this.#mainAgent = phaseAgent("orchestrator", event);
							turn.push(this.#withOrchestrator(this.#withProfile(this.#withMode(event))));
						}
					}
				} catch (error) {
					failed = true;
					turn.push(errorEvent("backend_error", describeError(error)));
				}
				const agent = withEffectiveEffort(this.#mainAgent, backendSession.effectiveEffort?.());
				return {
					ok: ok && !failed,
					...(agent === undefined ? {} : { agents: [agent] }),
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
				.then(() => Promise.all(this.#archiving))
				.then(() => this.#options.record?.flush())
				.then(() => this.#options.memory?.close().catch(() => {}))
				.then(() => this.#options.mcp?.close().catch(() => {}))
				.then(() => this.#backendSession?.close())
				.finally(async () => {
					// Whatever failed above, the saved session is let go once its entries are written.
					await this.#options.record?.release();
					if (scratchDir !== undefined) await rm(scratchDir, { recursive: true, force: true });
				});
		}
		return this.#closing;
	}

	async #executeTool(call: ToolCall): Promise<ToolCallResult> {
		const callId = call.callId ?? this.#createId();
		const emit = (event: AtelierEventBody) => this.#turn?.push(event);
		emit({ type: "tool_call_started", callId, tool: call.tool, input: call.input });
		this.#lastMessage = "";
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
				approvedPaths: this.#approvedPaths,
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
			const mode = this.#options.permissionMode;
			// A guard confirmation asks in every mode and is never the classifier's to decide; `yolo` waives only the
			// reversible delivery (a plain push or rebase) the gate marks.
			const confirmed = approval?.confirm !== undefined;
			const skipped =
				(mode === "yolo" && (!confirmed || approval?.yoloWaived === true)) ||
				(approval?.classifyOnly === true && mode !== "auto");
			const verdict =
				approval && mode === "auto" && !confirmed ? await this.#classify(callId, call.tool, approval, emit) : undefined;
			if (verdict?.decision === "deny") return fail(denialMessage(verdict.reason));
			if (approval && (skipped || verdict?.decision === "allow")) {
				if (approval.grant !== undefined) this.#approvedPaths.add(approval.grant);
			} else if (approval) {
				const { command, reason, tool: asking, confirm } = approval;
				const question = {
					command,
					...(reason === undefined ? {} : { reason }),
					...(asking === undefined ? {} : { tool: asking }),
					...(confirm === undefined ? {} : { confirm }),
				};
				emit({ type: "approval_requested", callId, ...question });
				const request = { callId, ...question };
				// The client must have read everything before the question; a turn nobody reads anymore is not asked.
				const delivered = (await this.#turn?.drained(signal)) ?? false;
				const approved = delivered && ((await this.#options.approve?.(request)) ?? false);
				if (!approved) return fail(approval.denial ?? "The user denied this command.");
				if (approval.grant !== undefined) this.#approvedPaths.add(approval.grant);
			}
			const outcome = await tool.execute(call.input, context);
			emit({
				type: "tool_call_finished",
				callId,
				ok: outcome.ok,
				summary: outcome.summary,
				truncated: outcome.truncated,
				...(outcome.fullOutputPath === undefined ? {} : { fullOutputPath: outcome.fullOutputPath }),
				...(outcome.blocked === undefined ? {} : { blocked: outcome.blocked }),
			});
			return { ok: outcome.ok, output: outcome.output };
		} catch (error) {
			const prefix = error instanceof ToolInputError ? "Invalid input" : "Tool failed";
			return fail(`${prefix}: ${describeError(error)}`);
		}
	}

	/**
	 * Asks the classifier about a call that would ask the user, and says what it decided. Undefined means it did not
	 * decide (it failed, is paused or is missing) and the user is asked as in `normal`.
	 */
	async #classify(
		callId: string,
		tool: string,
		approval: NonNullable<ToolGate["approval"]>,
		emit: (event: AtelierEventBody) => void,
	): Promise<{ decision: "allow" | "deny"; reason: string } | undefined> {
		const undecided = (reason: string, paused?: true): undefined => {
			emit({ type: "permission_classified", callId, decision: "undecided", reason, ...(paused ? { paused } : {}) });
			return undefined;
		};
		const options = this.#options.permissionClassifier;
		if (!options) return undecided("classifier unavailable: not configured");
		const paused = pauseReason(this.#classifier);
		if (paused !== undefined) return undecided(paused, true);
		const request = this.#turnPrompt;
		if (request === undefined) return undecided("classifier unavailable: no request in this turn");
		const answer = await this.#askClassifier(
			options,
			classifierPrompt(request, approval.classifierTool ?? tool, approval.command, approval.reason, this.#previousTurn),
		);
		if (!answer.ok) {
			this.#classifier.failures++;
			return undecided(`classifier unavailable: ${answer.error}`);
		}
		const { decision, reason } = answer.decision;
		if (decision === "allow") this.#classifier.consecutive = 0;
		else {
			this.#classifier.consecutive++;
			this.#classifier.denials++;
		}
		emit({ type: "permission_classified", callId, decision, reason });
		return answer.decision;
	}

	/** One separate model call with no tools, in a child session of its own; its events stay out of the turn's stream. */
	async #askClassifier(
		options: PermissionClassifierOptions,
		prompt: string,
	): Promise<{ ok: true; decision: { decision: "allow" | "deny"; reason: string } } | { ok: false; error: string }> {
		const settings = roleSettings(this.#options.profile, "permission-classifier", this.#model, this.#thinking);
		let child: Session | undefined;
		let agent: PhaseAgent | undefined;
		let usage = ZERO_USAGE;
		let requests: number | undefined;
		let costUsd: number | undefined;
		let timer: NodeJS.Timeout | undefined;
		const signal = this.#abort?.signal;
		const stop = () => void child?.interrupt();
		try {
			const backend = await options.createBackend(settings.backend);
			const compaction = compactionSettings(this.#options.profile, backend.id).compaction;
			child = await Session.start({
				backend,
				cwd: this.#options.cwd,
				...(settings.model === undefined ? {} : { model: settings.model }),
				...(settings.thinking === undefined ? {} : { thinking: settings.thinking }),
				...(compaction === undefined ? {} : { compaction }),
				tools: [],
				systemPromptAppend: CLASSIFIER_INSTRUCTION,
				maxRequestsPerTurn: 1,
				createId: this.#createId,
			});
			const running = child;
			const timedOut = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					void running.close();
					reject(new Error("timed out"));
				}, options.timeoutMs ?? CLASSIFIER_TIMEOUT_MS);
			});
			signal?.addEventListener("abort", stop, { once: true });
			let text = "";
			let failure: string | undefined;
			let stopReason = "incomplete";
			const reading = (async () => {
				for await (const event of running.send(prompt)) {
					if (event.type === "session_started") agent = phaseAgent("permission-classifier", event);
					else if (event.type === "text_delta") text += event.text;
					else if (event.type === "error") failure ??= `${event.code}: ${event.message}`;
					else if (event.type === "turn_finished") {
						stopReason = event.stopReason;
						usage = event.usage;
						requests = event.requests;
						costUsd = event.costUsd;
					}
				}
			})();
			// A timeout closes the child, which ends `reading`; its late outcome is not wanted.
			await Promise.race([reading, timedOut]);
			if (signal?.aborted) return { ok: false, error: "interrupted" };
			if (stopReason !== "end_turn" || failure !== undefined)
				return { ok: false, error: failure ?? `the classifier stopped: ${stopReason}` };
			const parsed = parseDecision(text);
			return parsed.ok ? { ok: true, decision: parsed.decision } : { ok: false, error: parsed.error };
		} catch (error) {
			return { ok: false, error: describeError(error) };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			await child?.close().catch(() => {});
			const spent: PhaseSpent = {
				usage,
				...(requests === undefined ? {} : { requests }),
				...(costUsd === undefined ? {} : { costUsd }),
				...(agent === undefined ? {} : { agents: [agent] }),
			};
			this.#classifierSpent = this.#classifierSpent ? addPhaseSpent(this.#classifierSpent, spent) : spent;
		}
	}

	/** The turn's closing event with what the classifier cost as its own part, added to the totals. */
	#withClassifier(
		ended: Extract<AtelierEventBody, { type: "turn_finished" }>,
	): Extract<AtelierEventBody, { type: "turn_finished" }> {
		const spent = this.#classifierSpent;
		if (spent === undefined) return ended;
		return addSpent(ended, { ...spent, phases: onePhase("classifier", spent) });
	}

	/** The turn's closing event with what the summaries of backend changes cost as the `handoff` part, added to the totals. */
	#withHandoff(
		ended: Extract<AtelierEventBody, { type: "turn_finished" }>,
	): Extract<AtelierEventBody, { type: "turn_finished" }> {
		const spent = this.#handoffSpent;
		if (spent === undefined) return ended;
		this.#handoffSpent = undefined;
		return addSpent(ended, { ...spent, phases: onePhase("handoff", spent) });
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
		// Only the worker and the explorer have an entry in the profile.
		const role = agent.name === "worker" || agent.name === "explorer" ? agent.name : undefined;
		const settings = roleSettings(
			role === undefined ? undefined : this.#options.profile,
			role ?? "worker",
			undefined,
			this.#thinking,
		);
		try {
			const backend = await options.createBackend(settings.backend);
			const model = settings.model ?? agent.models[backend.id] ?? this.#model;
			const childCompaction = compactionSettings(this.#options.profile, backend.id).compaction;
			child = await Session.start({
				backend,
				cwd: this.#options.cwd,
				...(model === undefined ? {} : { model }),
				...(settings.thinking === undefined ? {} : { thinking: settings.thinking }),
				...(childCompaction === undefined ? {} : { compaction: childCompaction }),
				// In the definition's order; a tool the parent lacks is skipped, and task never: children do not delegate.
				tools: agent.tools.flatMap((name) => {
					const tool = PARENT_ONLY.has(name) ? undefined : this.#tools.get(name);
					return tool ? [tool] : [];
				}),
				systemPromptAppend: agent.prompt,
				maxRequestsPerTurn: agent.maxRequests,
				// The mode is not passed on: the child runs in normal.
				...(this.#options.noSandbox ? { noSandbox: true } : {}),
				...(this.#options.approve === undefined ? {} : { approve: this.#options.approve }),
				createId: this.#createId,
			});
		} catch (error) {
			if (settings.backend !== undefined) return fail(roleStartMessage(agent.name, settings.backend, error));
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
			// The parent model never sees the child's compaction rows: a failed one goes with the failure.
			let compactionFailure: string | undefined;
			let stopReason = "incomplete";
			for await (const event of child.send(prompt)) {
				// Clients see the child's work in the parent's turn; the parent model never does.
				// The child's `bash` is the parent's: the status was already said.
				if (event.type === "sandbox_status") continue;
				const { seq: _seq, turnId: _turnId, ...body } = event;
				this.#turn?.push({ ...body, ...tag });
				if (event.type === "text_delta") report += event.text;
				else if (event.type === "tool_call_started") report = "";
				else if (event.type === "error") failure ??= `${event.code}: ${event.message}`;
				else if (event.type === "compaction_finished" && !event.ok)
					compactionFailure = event.error ?? "no reason given";
				else if (event.type === "turn_finished") stopReason = event.stopReason;
			}
			if (stopReason === "error" || stopReason === "interrupted" || failure !== undefined) {
				const compaction = compactionFailure === undefined ? "" : `; its compaction failed: ${compactionFailure}`;
				const on = settings.backend === undefined ? "" : ` on ${settings.backend}`;
				return fail(`The ${agent.name} subagent failed${on} (${stopReason}): ${failure ?? "no details"}${compaction}`);
			}
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

	/** Starts saving a compaction summary; the turn waits for it, the backend does not. */
	#archive(summary: string): void {
		const saving = this.#saveSummary(summary).finally(() => this.#archiving.delete(saving));
		this.#archiving.add(saving);
	}

	/** Keeps the summary in memory, once, under the session's key. Never throws: the compaction already happened. */
	async #saveSummary(summary: string): Promise<void> {
		const memory = this.#options.memory;
		if (!memory) return;
		const secret = findSecret(summary);
		if (secret) {
			this.#say(
				errorEvent(
					"memory_summary_skipped",
					`The compaction summary was not saved to memory: it contains what looks like ${secret}.`,
					true,
				),
			);
			return;
		}
		try {
			const { warning } = await memory.save({
				title: `Session summary: ${memory.project}, ${localDate(new Date())}`,
				type: SESSION_SUMMARY_TYPE,
				content: summary,
				topicKey: this.#summaryKey,
			});
			if (warning !== undefined)
				this.#say(
					errorEvent(
						"memory_summary_warning",
						`The compaction summary was saved to memory with a warning: ${warning}`,
						true,
					),
				);
		} catch (error) {
			this.#say(
				errorEvent(
					"memory_summary_failed",
					`The compaction summary was not saved to memory: ${describeError(error)}`,
					true,
				),
			);
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
			const { warning } = await memory.save({
				title: `Feature ${feature.name}: ${feature.title}`,
				type: "architecture",
				content: feature.text,
				topicKey: `odd/${feature.name}/tasks`,
			});
			if (warning !== undefined)
				this.#turn?.push(
					errorEvent(
						"memory_mirror_warning",
						`Feature ${feature.name} was saved to memory with a warning: ${warning}`,
						true,
					),
				);
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

function summaryUnsupported(backend: string): ConfigureError {
	return new ConfigureError(
		"summary_unsupported",
		`The ${backend} backend cannot summarize its conversation, so the session cannot leave it.`,
	);
}

/** YYYY-MM-DD in the local time zone. */
function localDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Stop reasons after which a turn is neither assessed nor trusted as a correction. */
const NOT_REVIEWED = new Set(["error", "interrupted", "incomplete"]);

/** The main agent's own closing event, with what it cost as the turn's `main` part. */
function withMainPhase(
	ended: Extract<AtelierEventBody, { type: "turn_finished" }>,
	agent: PhaseAgent | undefined,
): Extract<AtelierEventBody, { type: "turn_finished" }> {
	return { ...ended, phases: onePhase("main", agent === undefined ? ended : { ...ended, agents: [agent] }) };
}

/** The turn's closing event with the review's usage, cost and parts added. */
function addSpent(
	ended: Extract<AtelierEventBody, { type: "turn_finished" }>,
	spent: Spent,
): Extract<AtelierEventBody, { type: "turn_finished" }> {
	const { usage, requests, costUsd } = addPhaseSpent(ended, spent);
	const phases = addPhases(ended.phases, spent.phases);
	return {
		...ended,
		...(requests === undefined ? {} : { requests }),
		usage,
		...(costUsd === undefined ? {} : { costUsd }),
		...(phases === undefined ? {} : { phases }),
	};
}
