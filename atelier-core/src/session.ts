import { randomUUID } from "node:crypto";
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
import { type BackgroundNotice, deliveryText } from "./background-notices.ts";
import { Channel } from "./channel.ts";
import { COMPACTED_HEADER } from "./compaction/compactor.ts";
import { nearCompaction } from "./context-gauge.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	type BackendChange,
	type ContextUsage,
	describeError,
	type Effort,
	type EffortNotSent,
	errorEvent,
	type McpServerStatus,
	type PhaseAgent,
	type PhaseSpent,
	type QueuedMessage,
	type QueueKind,
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
	MemoryUncertainError,
	promptForMemory,
	recoveryNotice,
	SESSION_SUMMARY_TYPE,
	type SummaryOutcome,
	summaryPreview,
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
import {
	type ListedPermissionRule,
	type PermissionRuleKind,
	type PermissionRuleScope,
	type PermissionRules,
	PermissionRulesError,
} from "./permission-rules.ts";
import { type ThinkingBackend, thinkingToSend } from "./pricing.ts";
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
import { LEFT_YOLO, MEMORY_RULES, oddRules, RISK_RULES, YOLO_RULES } from "./prompt.ts";
import { type ReviewHost, type ReviewOptions, SessionReview, type Spent } from "./review/session-review.ts";
import { RISK_TOOL } from "./review/tool.ts";
import { createScratchDir, type ScratchDir } from "./scratch.ts";
import type { SavedConfig } from "./sessions/format.ts";
import type { SessionRecorder } from "./sessions/recorder.ts";
import { type LoadedSkills, loadSkills, skillsPrompt } from "./skills.ts";
import { addPhaseSpent, addPhases, onePhase, phaseAgent, withEffectiveEffort } from "./spent.ts";
import {
	boundReport,
	createTaskTool,
	type SubagentDefinition,
	type SubagentResult,
	TASK_TOOL,
} from "./subagents/definitions.ts";
import {
	BackgroundTasks,
	type EndedTask,
	type TaskInfo,
	TaskRefusedError,
	type TaskResult,
	taskStartedText,
} from "./subagents/tasks.ts";
import {
	createTaskWorktree,
	type Dependencies,
	type TaskWorktree,
	type WorktreeChanges,
	WorktreeRefusedError,
} from "./subagents/worktree.ts";
import { ASK_USER_TOOL, type AskUser, createAskUserTool } from "./tools/ask-user.ts";
import { BASH_BACKGROUND_TOOL, JOB_LIST_TOOL, JOB_STOP_TOOL } from "./tools/background.ts";
import { commandRuleScope } from "./tools/command-rules.ts";
import { type EndedJob, type JobInfo, Jobs } from "./tools/jobs.ts";
import { SANDBOX_MECHANISM, SANDBOX_OFF, Sandbox } from "./tools/sandbox.ts";
import {
	type ToolContext,
	type ToolDefinition,
	type ToolGate,
	ToolInputError,
	type ToolOutcome,
} from "./tools/types.ts";
import { UserQuestions } from "./user-questions.ts";

type TurnEvent = AtelierEventBody & SubagentTag;

/** Errors a backend reports when its credentials are missing or refused. */
const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set(["not_logged_in", "authentication_error"]);
/** How long a turn a job's notice woke waits for others before it takes them: jobs that end together share one turn. */
const WAKE_GATHER_MS = 250;
/** What a subagent in the background is told instead of a question to the user: nobody would answer it. */
const UNATTENDED_DENIAL =
	"Denied without asking: a background subagent cannot ask the user. Leave this out and say in your report what needs approval.";
/** What a background worker is told of its folder. */
const WORKTREE_NOTE =
	"You work in a git worktree made for this task alone, from the other agent's working tree. Do not commit: your changes are collected from its files as a patch.";
/** What the parent and the worker are told of the dependencies in the worker's worktree. */
const DEPENDENCIES_SAID: Record<Dependencies, { parent: string; worker: string }> = {
	linked: {
		parent: " Its node_modules folders are links to yours: it reads and runs them, and cannot write them.",
		worker:
			" Its node_modules folders are links to the other agent's: read and run them, but you cannot write them, so install nothing.",
	},
	none: { parent: "", worker: "" },
};
/** What a launch answers once the session closes before its task started. */
const CLOSING_REFUSAL = "Refused: the session is closing.";
/** The patches of background workers whose files a new patch is compared with. */
const MAX_KEPT_PATCHES = 20;
/** How long a stopped background subagent has to end its turn before its session is closed under it. */
const STOP_GRACE_MS = 2000;
/** A line of a background subagent's activity for its task's file: its tool calls and errors; nothing else. */
function activityLine(body: AtelierEventBody): string {
	if (body.type === "tool_call_started") return `- ${body.tool} ${JSON.stringify(body.input).slice(0, 200)}`;
	if (body.type === "tool_call_finished" && !body.ok) return `  failed: ${body.summary}`;
	if (body.type === "error") return `- error ${body.code}: ${body.message}`;
	return "";
}

/** Tools a subagent never gets: delegation and the ODD document belong to the parent. */
const PARENT_ONLY = new Set([
	ASK_USER_TOOL,
	TASK_TOOL,
	FEATURE_TOOL,
	PHASE_TOOL,
	MEMORY_TOOL,
	RISK_TOOL,
	MCP_SEARCH_TOOL,
	MCP_CALL_TOOL,
	// A subagent's session closes with its report, and its jobs with it.
	BASH_BACKGROUND_TOOL,
	JOB_LIST_TOOL,
	JOB_STOP_TOOL,
]);

/** Tells the agent which commands run outside the sandbox on their own, so it asks to leave it only when needed. */
async function rulesPrompt(rules: PermissionRules | undefined): Promise<string> {
	const { bash, projectBash } = rules === undefined ? { bash: [], projectBash: [] } : await rules.current();
	const lines = [
		...(bash.length === 0
			? []
			: [`The user allows these bash commands outside the sandbox without asking: ${bash.join(", ")}.`]),
		...(projectBash.length === 0
			? []
			: [
					`In this project the user also allows these bash commands outside the sandbox without asking: ${projectBash.join(", ")}.`,
				]),
	];
	if (lines.length === 0) return "";
	return `${lines.join(" ")} They run there on their own: do not set unsandboxed for them.`;
}

export interface ApprovalRequest {
	callId: string;
	command: string;
	/** Why the agent asks to run the command outside the sandbox; present only for that request. */
	reason?: string;
	/** Present when the question is not about a `bash` command: `edit` asks to change a file outside the usual places. */
	tool?: string;
	/** The guard's confirm rule the command matches (`recursive removal`, `git push`, ...); `bash` only. */
	confirm?: string;
	/** The sandbox failed to start, so the command asks in every mode, `yolo` included; `bash` only. */
	sandboxFailed?: true;
	/**
	 * What "Allow in this session" and "Allow always" would remember (`rules`, shown to the user); `always` is false when
	 * they may not be kept for every folder. `project`, the project's real path, is set when they may be kept always in
	 * it instead ("Allow always in this project"): a command of the line runs code the repository defines. Absent when
	 * the answer can only allow or deny.
	 */
	remember?: { rules: string[]; always: boolean; project?: string };
}

/** Why rules the question did not offer for every folder cannot be kept always. */
function neverAlways(kind: PermissionRuleKind, rules: readonly string[]): string {
	const project = kind === "bash" ? rules.find((rule) => commandRuleScope(rule) === "project") : undefined;
	const runner = kind === "bash" && rules.some((rule) => commandRuleScope(rule) === "session");
	if (project !== undefined && !runner)
		return `"${project}" runs code the project defines: it is allowed always only in a project`;
	return `${rules.join(", ")} runs arbitrary code: it is never allowed always`;
}

/** The user's answer: allow or deny this call, or allow it and remember its rules for the session, the project or always. */
export type ApprovalAnswer = boolean | { remember: PermissionRuleScope };

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
	approve?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
	/** User-only question channel for a direct client. Never inherited by subagents. */
	askUser?: AskUser;
	/** True: answers arrive through answerUser. False: omit the tool (internal child sessions). */
	userQuestions?: boolean;
	/**
	 * The rules the user allowed, which spare the questions they cover: the session's in memory and the saved ones.
	 * Without it nothing is remembered and questions offer only Allow and Deny. Subagents share the parent's.
	 */
	permissionRules?: PermissionRules;
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
	/**
	 * Lists the skills of `.agents/skills/` (from `cwd` up to the repo root, then `home`'s) in the system prompt, found
	 * once at start. Never given to subagents.
	 */
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
	/**
	 * With `resume`: whether the saved conversation last told the model it runs in yolo, so a session resumed in another
	 * mode says the change in its first prompt; `null`, unknown, says the mode. Absent (a file saved before it was
	 * kept): the mode it starts in.
	 */
	resumedYoloTold?: boolean | null;
	/**
	 * Called when a background job or task ended with no turn running: its notice waits, and the caller starts its turn
	 * with `nextQueued`. One that ends while a turn runs goes with its next tool result, or waits for `nextQueued` after
	 * it. Without it the session cannot receive a background result: `task` refuses `background`.
	 */
	wake?: () => void;
	/**
	 * Hears what happens while no turn runs and none will start for it: the end of a background job after a turn that
	 * was interrupted or failed, whose notice waits for the user's next prompt (`job_finished`, with `waiting`). Without
	 * it, the event goes first in the next turn instead.
	 */
	idleEvent?: (event: AtelierEventBody) => void;
	/**
	 * Nobody answers this session's questions: a call that would ask the user is denied at once, without asking. For a
	 * subagent in the background.
	 */
	unattended?: boolean;
	/**
	 * Its tools write only `cwd` and the session's scratch directory, whatever the configuration or rules add, and its
	 * commands run only in the sandbox (`ToolContext.confined`). For a worker in the background, in its own worktree.
	 */
	confined?: boolean;
}

/** What the main agent runs with, as `Session.configure` and the `session_configured` event say it. */
export interface SessionConfiguration {
	backend: string;
	/** Absent while the backend's default model runs and nothing changed it. */
	model?: string;
	thinking?: ThinkingLevel;
	/** The level as the backend sends it, what `session_started.effort` says: the effort, `off`, `auto` for a model
	 * that reasons on its own, or `<level> not sent`. Absent when no level was asked or while a change waits for the
	 * turn to end, so what still runs stays what was said before. */
	effort?: Effort | "off" | "auto" | EffortNotSent;
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

const THINKING_BACKENDS: ReadonlySet<string> = new Set(["claude-code", "anthropic-api", "opencode-go"]);

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
	/** Counts the changes of backend or model: a context belongs to the backend and model that measured it. */
	#modelEpoch = 0;
	/** The `#modelEpoch` `context_warning` was said in, until the context goes below it again or compacts. */
	#contextWarned: number | undefined;
	/** Events from outside a turn (a summary that was not saved), said at the start of the next one. */
	#notices: AtelierEventBody[] = [];
	/** The main agent as its backend's `session_started` described it: what the turn's parts say it ran with. */
	#mainAgent: PhaseAgent | undefined;
	#turn: Channel<TurnEvent> | undefined;
	/** The subagent running right now, so interrupting or closing reaches it. */
	#child: Session | undefined;
	readonly #odd: OddTracker | undefined;
	readonly #review: SessionReview | undefined;
	readonly #userQuestions: UserQuestions;
	/** Recent memory, fetched at start and given with the first prompt only; fetched again after each compaction. */
	#memoryContext = "";
	/**
	 * What the agent is told after a compaction, with the recent memory when it came (`fetched`); it goes before the
	 * next prompt, once.
	 */
	#recovery: Recovery | undefined;
	/**
	 * The recovery notice in the prompt the backend is taking now, until the backend answers with something other than
	 * an error; a backend that fails before that gets it back as pending, for the next prompt.
	 */
	#recoveryInFlight: Recovery | undefined;
	/** The instruction files read at start; reported with the first turn. */
	#instructions: ProjectInstructions | undefined;
	/** The skills found at start; reported with the first turn. */
	#skills: LoadedSkills | undefined;
	#announced = false;
	/** The session started in yolo, so the system prompt has its rules. */
	#startedYolo = false;
	/**
	 * Whether the model was last told it runs in yolo: by the system prompt, then by the note of a later prompt. `null`:
	 * unknown, as after a note the backend failed on, which it may have kept in its history; the next prompt says the mode.
	 */
	#toldYolo: boolean | null = false;
	/** The MCP servers whose instructions the model was already given. */
	readonly #mcpGiven = new Set<string>();
	/** The last `mcp_status` said, as JSON, so a turn says it again only when it changed. */
	#mcpSaid: string | undefined;
	/** The configuration the session started with was saved. */
	#recordedConfig = false;
	/** What the backend that ran the turn answered at its end, until the turn's last event is saved. */
	#endState: ResumeState | undefined;
	#endBackend = "";
	/** What the model of that backend was last told about yolo, taken with its state: a backend change resets it. */
	#endYoloTold: boolean | null = false;
	/** The first failed write was reported; the ones after it are not. */
	#saveFailureSaid = false;
	/** The sandbox warning was already said in this turn. */
	#warned = false;
	/** The broken rules file was already said in this session. */
	#rulesProblemSaid = false;
	#rulesIgnoredSaid = false;
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
	/** What the user queued while a turn runs, in order, until it enters the conversation. */
	#queue: QueuedMessage[] = [];
	/** The running turn answers a prompt, so a steer can go with its tool results. */
	#steerable = false;
	/** Marks what the running turn's prompt carried as the model's: the mode note and the review notice. */
	#promptTaken: (() => void) | undefined;
	/** The running turn ended interrupted or failed and gave its queue back: nothing more is queued behind it. */
	#givenBack = false;
	#abort: AbortController | undefined;
	#closed = false;
	#closing: Promise<void> | undefined;
	#scratch: ScratchDir | undefined;
	/** The session as memory knows it: its registration and its summary key. */
	readonly #memoryId = randomUUID();
	/** Every compaction summary of this session updates the same memory. */
	readonly #summaryKey = `session/${this.#memoryId}/summary`;
	/** Summaries and prompts being saved to memory; the turn that started them waits for them before it finishes. */
	readonly #memoryWrites = new Set<Promise<void>>();
	/** Saving the user's prompts failed once and was said; later failures are not. */
	#promptFailureSaid = false;
	/** The background jobs, when the session's tools include `bash_background`. */
	#jobs: Jobs | undefined;
	/** The subagents in the background, when the session has subagents and can be woken. */
	#tasks: BackgroundTasks | undefined;
	/** The worktrees made for background workers so far: each gets the next number as its folder. */
	#worktrees = 0;
	/** The files of the latest patches of background workers, by task id, oldest first. */
	readonly #patches = new Map<string, string[]>();
	/** Notices of ended background work the agent has not read yet, oldest first. */
	#backgroundNotices: BackgroundNotice[] = [];
	/** The waiting notices may start a turn of their own: not after a turn that ended interrupted or failed left them. */
	#noticesWake = false;
	/**
	 * The last turn that answers the user ended interrupted or failed: notices, those it left and those that come after,
	 * wait for the user's next prompt and start no turn of their own.
	 */
	#noticesHeld = false;
	/** Ends the wait of a woken turn for its notices: the session's close calls it. */
	#gathering: (() => void) | undefined;

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
					createTaskTool(
						subagents.agents,
						(agent, prompt, context) => this.#runSubagent(subagents, agent, prompt, context),
						options.wake === undefined
							? undefined
							: (agent, prompt, label, context) => this.#startBackground(subagents, agent, prompt, label, context),
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
		this.#userQuestions = new UserQuestions(
			(event) => this.#turn?.push(event),
			(signal) => this.#turn?.drained(signal) ?? Promise.resolve(false),
		);
		const all = [
			...tools,
			...(options.userQuestions === false
				? []
				: [
						createAskUserTool((questions, context) =>
							this.#userQuestions.ask(
								questions,
								context,
								options.userQuestions === true || options.askUser !== undefined,
								options.askUser,
							),
						),
					]),
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
		if (options.memory) await session.#beginMemory(options.memory);
		if (options.projectInstructions) {
			const instructions = await loadProjectInstructions(options.cwd, options.projectInstructions.home);
			if (instructions.files.length > 0 || instructions.dropped.length > 0) session.#instructions = instructions;
		}
		if (options.skills) {
			const skills = await loadSkills(options.cwd, options.skills.home);
			if (skills.skills.length > 0 || skills.warnings.length > 0) session.#skills = skills;
		}
		const scratch = await createScratchDir("session");
		session.#scratch = scratch;
		session.#startedYolo = options.permissionMode === "yolo";
		session.#toldYolo =
			options.resume !== undefined && options.resumedYoloTold !== undefined
				? options.resumedYoloTold
				: session.#startedYolo;
		if (session.#tools.has(BASH_BACKGROUND_TOOL))
			session.#jobs = new Jobs({
				scratchDir: scratch.path,
				onStarted: (job) => session.#jobStarted(job),
				onEnded: (ended) => session.#jobEnded(ended),
			});
		if (options.subagents !== undefined && options.wake !== undefined)
			session.#tasks = new BackgroundTasks({
				scratchDir: scratch.path,
				onStarted: (task) => session.#taskStarted(task),
				onEnded: (ended) => session.#taskEnded(ended),
			});
		session.#systemPrompt = [
			options.systemPromptAppend ?? "",
			options.odd ? oddRules(options.subagents?.agents.map((agent) => agent.name) ?? []) : "",
			options.memory ? MEMORY_RULES : "",
			options.review ? RISK_RULES : "",
			session.#startedYolo ? YOLO_RULES : "",
			session.#instructions?.text ?? "",
			skillsPrompt(session.#skills?.skills ?? []),
			options.mcp ? mcpPromptBlock(options.mcp) : "",
			await rulesPrompt(options.permissionRules),
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
			await scratch.remove();
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
		// The note of a change of mode was a prompt the summary may lose; the system prompt says the starting mode.
		// When it is unknown what the model was told, the state says the mode now.
		const told = this.#toldYolo ?? this.#options.permissionMode === "yolo";
		if (this.#toldYolo !== this.#startedYolo) lines.push(`mode:\n${told ? YOLO_RULES : LEFT_YOLO}`);
		// The recovery notice brings the memory with the same prompt; said twice, it would only cost context.
		const memory = this.#memoryContext.trim();
		if (memory !== "" && !this.#recovery?.fetched && !this.#recoveryInFlight?.fetched) lines.push(`memory:\n${memory}`);
		return lines.length === 0 ? undefined : `<state>\n${lines.join("\n")}\n</state>`;
	}

	/** The user's MCP servers now, and what is wrong with their file; undefined without MCP or without servers. */
	mcpStatus(): { servers: McpServerStatus[]; problems: string[] } | undefined {
		const mcp = this.#options.mcp;
		if (mcp === undefined) return undefined;
		const servers = mcp.status();
		const problems = mcp.problems();
		return servers.length === 0 && problems.length === 0 ? undefined : { servers, problems };
	}

	/** Signs an HTTP server in with OAuth through the browser and connects it again; rejects without MCP. */
	async mcpLogin(server: string): Promise<void> {
		const mcp = this.#options.mcp;
		if (mcp === undefined) throw new Error(`No MCP server named "${server}"`);
		await mcp.login(server);
	}

	/** Deletes a server's OAuth credentials and connects it again; rejects without MCP. */
	async mcpLogout(server: string): Promise<void> {
		const mcp = this.#options.mcp;
		if (mcp === undefined) throw new Error(`No MCP server named "${server}"`);
		await mcp.logout(server);
	}

	get busy(): boolean {
		return this.#turn !== undefined;
	}

	/** The background jobs running now, and the notices of ended ones the agent has not read yet. */
	get jobs(): { running: number; waiting: number } {
		return { running: this.#runningBackground(), waiting: this.#backgroundNotices.length };
	}

	/** What is queued now, in the order it would enter. */
	get queued(): readonly QueuedMessage[] {
		return this.#queue.map((message) => ({ ...message }));
	}

	/**
	 * Queues a message while a turn runs: a steer goes to the model with the turn's next tool result, a follow-up waits
	 * for `nextQueued`. Whatever no tool result took is left for `nextQueued`, steers first.
	 */
	queue(kind: QueueKind, text: string): QueuedMessage {
		// Taken now, it would run after a turn that gave its queue back; refused, it stays with the client.
		if (this.#givenBack)
			throw new ConfigureError("turn_ended", "The turn was interrupted or failed; the message was not queued.");
		const message = { id: this.#createId(), kind, text };
		this.#queue.push(message);
		this.#userQuestions.cancel({ status: "superseded" });
		this.#sayQueue();
		return { ...message };
	}

	/** Changes a queued message's text; false once it entered the conversation or left the queue. */
	editQueued(id: string, text: string): boolean {
		const message = this.#queue.find((queued) => queued.id === id);
		if (!message) return false;
		message.text = text;
		this.#sayQueue();
		return true;
	}

	/** Takes the message `id` off the queue, or every message without an id, and answers what it took. */
	unqueue(id?: string): QueuedMessage[] {
		const taken = this.#queue.filter((message) => id === undefined || message.id === id);
		if (taken.length === 0) return [];
		this.#queue = this.#queue.filter((message) => !taken.includes(message));
		this.#sayQueue();
		return taken;
	}

	/**
	 * The turn of the next queued message, a steer before any follow-up, which starts by saying it entered; undefined
	 * when nothing is queued. The message leaves the queue now.
	 */
	nextQueued(turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> | undefined {
		if (this.#givenBack) return undefined;
		const next = this.#queue.find((message) => message.kind === "steer") ?? this.#queue[0];
		if (!next) return this.#wokenTurn(turnId);
		this.#queue = this.#queue.filter((message) => message !== next);
		return this.#send(next.text, turnId, next);
	}

	/** The queue as it stands, to the clients of the running turn. */
	#sayQueue(returned?: QueuedMessage[]): void {
		this.#turn?.push({
			type: "queue_update",
			messages: this.#queue.map((message) => ({ ...message })),
			...(returned === undefined ? {} : { returned }),
		});
	}

	/** Runs one turn. `turnId` lets a caller know the id before the first event (the RPC server answers with it). */
	async *send(prompt: string, turnId: string = this.#createId()): AsyncGenerator<AtelierEvent> {
		yield* this.#send(prompt, turnId);
	}

	/**
	 * `woken`: the turn of background notices with no prompt of the user's (`prompt` is empty): nothing is logged or kept as the
	 * user's words, the classifier has no request, and the review takes the user's last request.
	 */
	async *#send(prompt: string, turnId: string, entered?: QueuedMessage, woken = false): AsyncGenerator<AtelierEvent> {
		yield* this.#stream(turnId, woken ? undefined : prompt, entered, async (turn, signal, backendSession) => {
			// A woken turn waits a moment for the notices of work ending with the first, then takes all there are.
			if (woken) await this.#gatherNotices(signal);
			// Interrupted or closed while it waited: it ends before the backend, and the notices wait for the next prompt.
			if (woken && (signal.aborted || this.#closed))
				return { type: "turn_finished", stopReason: "interrupted", usage: { ...ZERO_USAGE } };
			// The user's words reach the feature log as the turn starts, without delaying the backend;
			// the turn waits for it before finishing, so a failure is reported inside this turn.
			this.#turnPrompt = woken ? undefined : prompt;
			const logged = woken ? undefined : this.#odd?.userMessage(prompt);
			if (!woken) this.#keepPrompt(prompt);
			// The user is back: the notices this prompt does not take may wake a turn again.
			if (!woken) this.#noticesHeld = false;
			const request = woken ? (this.#previousTurn?.request ?? prompt) : prompt;
			// What the agent declared in an earlier turn does not cover this one, and its candidate starts from today's HEAD.
			this.#review?.startTurn(this.#options.cwd, request);
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
				if (memory) {
					turn.push({ type: "memory_status", available: true, project: memory.project });
					for (const warning of memory.warnings) turn.push(errorEvent("memory_settings_invalid", warning, true));
				} else if (this.#options.memoryUnavailable !== undefined)
					turn.push({ type: "memory_status", available: false, reason: this.#options.memoryUnavailable });
				if (!this.#options.review && this.#options.reviewUnavailable !== undefined)
					turn.push({ type: "review_status", available: false, reason: this.#options.reviewUnavailable });
				this.#sayProfileNotices(turn);
				if (this.#options.permissionModeProblem !== undefined)
					turn.push(errorEvent("permission_mode_invalid", this.#options.permissionModeProblem, true));
				// Left out only when a compaction before the first prompt fetched the memory again for its notice.
				if (this.#memoryContext.trim() !== "" && !this.#recovery?.fetched)
					sent = `<memory>\n${this.#memoryContext}\n</memory>\n\n${prompt}`;
			}
			if (this.#recovery !== undefined) {
				sent = `${this.#recovery.text}\n\n${sent}`;
				this.#recoveryInFlight = this.#recovery;
				this.#recovery = undefined;
			}
			// The outcome of the latest review, once: the agent hears about it, and acts only if the user asks.
			let reviewNotice = this.#review?.takeNotice();
			if (reviewNotice !== undefined) sent = `${reviewNotice}\n\n${sent}`;
			// The notices of ended background work that waited: the whole prompt of a turn they woke, else before the user's words.
			let backgroundNotices = this.#takeNotices(turn);
			if (backgroundNotices !== undefined) {
				const text = deliveryText(backgroundNotices);
				sent = woken ? `${sent}${text}` : `${text}\n\n${sent}`;
			}
			const mcpStatus = this.mcpStatus();
			if (mcpStatus !== undefined && JSON.stringify(mcpStatus) !== this.#mcpSaid) {
				this.#mcpSaid = JSON.stringify(mcpStatus);
				turn.push({ type: "mcp_status", ...mcpStatus });
			}
			// Servers that connected since the last prompt, with no description, say what they offer once.
			const mcpNote = this.#options.mcp ? mcpInstructionsNote(this.#options.mcp, this.#mcpGiven) : undefined;
			if (mcpNote !== undefined) sent = `${mcpNote}\n\n${sent}`;
			// A mode changed since the model was last told: entering yolo gives its rules, leaving it says they ended.
			// It counts as told once the model took the prompt; until then the next prompt carries it again.
			const yolo = this.#options.permissionMode === "yolo";
			const telling = yolo !== this.#toldYolo;
			// What the prompt carried is the model's once it answered or called a tool, even if the turn fails after.
			let noteTaken = false;
			this.#promptTaken = () => {
				reviewNotice = undefined;
				backgroundNotices = undefined;
				if (telling) this.#toldYolo = yolo;
				noteTaken = true;
			};
			if (telling) sent = `${yolo ? YOLO_RULES : LEFT_YOLO}\n\n${sent}`;
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
			this.#steerable = true;
			try {
				for await (const event of backendSession.send(sent)) {
					if (!refusal(event)) this.#recoveryInFlight = undefined;
					if (answered(event)) this.#promptTaken?.();
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
			} finally {
				this.#steerable = false;
				this.#promptTaken = undefined;
				// A backend may keep a prompt it failed on (anthropic-api does), so whether the model saw the note is unknown.
				if (telling && !noteTaken) this.#toldYolo = null;
				// Never taken: it goes with the next prompt, unless a later compaction left a newer one.
				if (this.#recoveryInFlight !== undefined) this.#recovery ??= this.#recoveryInFlight;
				this.#recoveryInFlight = undefined;
				if (reviewNotice !== undefined) this.#review?.returnNotice(reviewNotice);
				// The model never saw them: they wait again, before any that came since, for the next prompt.
				if (backgroundNotices !== undefined) this.#returnNotices(backgroundNotices, turn);
			}
			this.#previousTurn = { request, lastMessage: lastMessageTail(this.#lastMessage) };
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
		yield* this.#stream(turnId, undefined, undefined, async (turn, signal, backendSession) => {
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
		yield* this.#stream(turnId, undefined, undefined, async (turn) => {
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
		yield* this.#stream(turnId, undefined, undefined, async (turn, _signal, backendSession) => {
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
		/** The queued message the prompt comes from: the turn starts by saying it entered. */
		entered: QueuedMessage | undefined,
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
		if (entered) {
			turn.push({ type: "queued_message", ...entered });
			this.#sayQueue();
		}
		this.#warned = false;
		this.#turnPrompt = undefined;
		this.#classifier = { consecutive: 0, denials: 0, failures: 0 };
		this.#classifierSpent = undefined;
		const abort = new AbortController();
		this.#abort = abort;
		const started = performance.now();
		// A backend change made just before this turn replaces the session this turn runs on.
		let backendSession: BackendSession = opening;
		// The backend and model the turn runs on, once the changes made before it are applied.
		let turnEpoch = this.#modelEpoch;
		const pump = (async () => {
			let finish: Extract<AtelierEventBody, { type: "turn_finished" }>;
			try {
				// The change made just before this turn reaches the backend before the turn's prompt does.
				if (this.#changing > 0) await this.#changes;
				// A change that arrived as the last turn was ending is applied before this one starts.
				if (this.#pending !== undefined || this.#pendingBackend !== undefined) await this.#applyPending(turn);
				backendSession = this.#backendSession ?? backendSession;
				turnEpoch = this.#modelEpoch;
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
			await Promise.all(this.#memoryWrites);
			// The state of the backend that ran the turn, before a change made at its end can replace the backend.
			if (this.#options.record) this.#endState = this.#backendSession?.resumeState?.();
			this.#endBackend = this.#backendSessionId;
			this.#endYoloTold = this.#toldYolo;
			// A change asked during the turn lands now, between this turn and the next.
			await this.#applyPending(turn);
			finish = this.#withHandoff(this.#withClassifier(finish));
			// A backend or model change applied as the turn ended: the context it measured is not the new model's.
			if (this.#modelEpoch !== turnEpoch) {
				const { context: _measured, ...rest } = finish;
				finish = rest;
			}
			// An interrupted or failed turn gives the queue back instead of running it after, also what was queued while
			// it was ending; from here until it is over, nothing more is queued.
			if (abort.signal.aborted || UNCLEAN_ENDS.has(finish.stopReason)) {
				this.#givenBack = true;
				// Background notices, those it left and later ones, wait for the user's next prompt instead of starting a turn.
				this.#noticesWake = false;
				this.#noticesHeld = true;
				const returned = this.#queue;
				this.#queue = [];
				if (returned.length > 0) this.#sayQueue(returned);
			}
			turn.push({ ...finish, durationMs: Math.round(performance.now() - started), at: new Date().toISOString() });
			turn.close();
		})();

		try {
			for await (const body of turn) {
				if (body.type === "compaction_finished" && body.ok && body.parentCallId === undefined)
					this.#contextWarned = undefined;
				// Only the main agent's context: a subagent's turn neither warns, nor rearms, nor uses up the warning.
				const main = body.type === "turn_finished" && body.parentCallId === undefined;
				const warning = main ? this.#contextWarning(body.context, turnEpoch) : undefined;
				if (warning !== undefined) {
					const said = stamp(warning);
					this.#options.record?.event(said);
					yield said;
				}
				const event = stamp(body);
				// The state goes after the turn's events and before its end, which is the last line of the turn.
				if (event.type === "turn_finished")
					this.#options.record?.state(this.#endBackend, this.#endState, this.#endYoloTold);
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
			this.#givenBack = false;
		}
	}

	/**
	 * The warning a turn's context brings: once near compaction, again after it went below or the backend or model the
	 * turn ran on (`epoch`) changed, also back to one it was said for.
	 */
	#contextWarning(context: ContextUsage | undefined, epoch: number): AtelierEventBody | undefined {
		if (context === undefined) return undefined;
		if (!nearCompaction(context)) {
			this.#contextWarned = undefined;
			return undefined;
		}
		if (this.#contextWarned === epoch) return undefined;
		this.#contextWarned = epoch;
		const { tokens, window, compactAt } = context;
		return { type: "context_warning", tokens, window, compactAt };
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
		const pending = this.#pending !== undefined || this.#pendingProfile !== undefined || coming !== undefined;
		// While a change waits the backend still runs the old one, so its report would say the wrong level.
		const effort = pending ? undefined : this.#sentEffort(model);
		return {
			backend: coming?.backend.id ?? this.#options.backend.id,
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			...(effort === undefined ? {} : { effort }),
			permissionMode: this.#options.permissionMode ?? "normal",
			...(profile === undefined ? {} : { profile: profileSummary(profile) }),
			pending,
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
		this.#modelEpoch++;
		this.#explicitModel = requested !== undefined;
		this.#compaction = compaction.compaction;
		if (compaction.notice !== undefined) this.#profileNotices.push(compaction.notice);
		this.#mainAgent = undefined;
		this.#backendChange = { from, summarized: summary !== undefined };
		this.#unannounced = true;
		// The new backend knows only its system prompt's mode: a later one is a note, pending until it takes a prompt.
		this.#toldYolo = this.#startedYolo;
		if (summary !== undefined) {
			// Saved first, so the state knows whether the recovery notice already brings the memory.
			if (this.#carried === undefined) await this.#saveSummary(summary.text);
			const state = this.#compactionState();
			this.#handoff = [`${COMPACTED_HEADER}\n\n<summary>\n${summary.text}\n</summary>`, state]
				.filter((part) => part !== undefined)
				.join("\n\n");
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
		if (change.model !== undefined && change.model !== this.#model) this.#modelEpoch++;
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

	/** The effort as the backend sends the level asked, what `session_started` says of it, so a level the backend
	 * cannot send (a thinking budget that does not fit the output budget, for one) is never said as sent; the table
	 * is the fallback for backends that track none, and needs the model's name. Absent when no level was asked. */
	#sentEffort(model: string | undefined): Effort | "off" | "auto" | EffortNotSent | undefined {
		if (this.#thinking === undefined) return undefined;
		const backend = this.#options.backend.id;
		const report = this.#backendSession?.effortReport?.();
		if (report !== undefined || !THINKING_BACKENDS.has(backend) || model === undefined) return report;
		return thinkingToSend(model, this.#thinking, backend as ThinkingBackend)?.report;
	}

	/** The turn parts name the model and effort the backend was told, also when it does not say `session_started` again. */
	#patchMainAgent(): void {
		const agent = this.#mainAgent;
		if (agent === undefined) return;
		const next: PhaseAgent = { ...agent, ...(this.#model === undefined ? {} : { model: this.#model }) };
		const report = this.#sentEffort(next.model);
		if (report !== undefined) {
			next.effort = report;
			delete next.effectiveEffort;
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
		if (this.#turnOpen()) this.#turn?.push(event);
		else this.#notices.push(event);
	}

	/** A turn runs and still takes events: its last one closes them before the turn is over. */
	#turnOpen(): boolean {
		return this.#turn !== undefined && !this.#turn.closed;
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
			startChild: (options) => Session.start({ ...options, userQuestions: false }),
			createId: this.#createId,
		};
	}

	/** Answers one live batch atomically; invalid replies leave it pending. Null cancels it. */
	answerUser(callId: string, answers: unknown): void {
		if (!this.#userQuestions.has(callId))
			throw new ConfigureError("unknown_question", `No pending user question ${callId}.`);
		try {
			this.#userQuestions.answer(callId, answers);
		} catch (error) {
			throw new ConfigureError("invalid_answer", describeError(error));
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
			this.#userQuestions.close();
			const scratch = this.#scratch;
			this.#gathering?.();
			// The jobs stop whatever else fails below: apart from the chain, and waited for before their files go.
			const stoppingJobs = Promise.all([this.#jobs?.stopAll(), this.#tasks?.stopAll()]).catch(() => {});
			// .then() turns a synchronous throw from close() into a rejection, so cleanup still runs.
			this.#closing = Promise.resolve()
				.then(() => this.#child?.close())
				.then(() => this.#review?.close())
				.then(() => this.#odd?.close())
				.then(() => Promise.all(this.#memoryWrites))
				.then(() => this.#options.record?.flush())
				// Nobody is left to hear that ending the memory session failed.
				.then(() => this.#options.memory?.end().catch(() => {}))
				.then(() => this.#options.memory?.close().catch(() => {}))
				.then(() => this.#options.mcp?.close().catch(() => {}))
				.then(() => this.#backendSession?.close())
				.finally(async () => {
					await stoppingJobs;
					// Whatever failed above, the saved session is let go once its entries are written.
					await this.#options.record?.release();
					await scratch?.remove();
				});
		}
		return this.#closing;
	}

	/** Runs a call of the main agent; in a turn that answers a prompt, the steers queued so far go with its result. */
	async #executeTool(call: ToolCall): Promise<ToolCallResult> {
		// A tool call comes from the model's answer, which backends do not always stream as an event.
		this.#promptTaken?.();
		// HEAD is read where the turn started before any command of the agent can move it; the backend got the prompt at once.
		// An interrupt ends the wait, and a call of an interrupted turn does not run.
		const signal = this.#abort?.signal;
		const lookup = this.#review?.turnStarted();
		if (lookup !== undefined) await untilAborted(lookup, signal);
		if (signal?.aborted) return { ok: false, output: "Not run: the turn was interrupted." };
		const result = await this.#runTool(call);
		if (!this.#steerable || this.#abort?.signal.aborted) return result;
		// The notices of background work that ended go with the result too, after the user's steers.
		const taken = this.#takeNotices(this.#turn);
		const notices = taken === undefined ? undefined : deliveryText(taken);
		const steers = this.#queue.filter((message) => message.kind === "steer");
		if (steers.length === 0) return notices === undefined ? result : { ...result, steering: notices };
		this.#queue = this.#queue.filter((message) => message.kind !== "steer");
		for (const steer of steers) {
			this.#turn?.push({ type: "queued_message", ...steer });
			this.#keepPrompt(steer.text);
		}
		this.#sayQueue();
		const steering = steeringText(steers.map((steer) => steer.text));
		return { ...result, steering: notices === undefined ? steering : `${steering}\n\n${notices}` };
	}

	/** The turn of the notices that wait, when they may start one; it takes them, so a second call answers undefined. */
	#wokenTurn(turnId: string): AsyncGenerator<AtelierEvent> | undefined {
		if (!this.#noticesWake || this.#backgroundNotices.length === 0) return undefined;
		this.#noticesWake = false;
		return this.#send("", turnId, undefined, true);
	}

	/** A job started: the clients hear it in the turn whose call started it. */
	#jobStarted(job: JobInfo): void {
		this.#say({
			type: "job_started",
			jobId: job.id,
			label: job.label,
			command: job.command,
			outputPath: job.outputPath,
			running: this.#runningBackground(),
		});
	}

	/**
	 * A job ended: its notice waits for the agent, and the clients hear of it in the running turn or the next. With no
	 * turn running, the notice asks for a turn of its own (`wake`).
	 */
	#jobEnded({ job, notice }: EndedJob): void {
		// Past a delivery's budget, the notice only says how the job ended and where its output is.
		const short = `${notice?.split("\n")[0]}\nIts output did not fit with the other notices: read it at ${job.outputPath}`;
		this.#backgroundEnded(notice === undefined ? undefined : { text: notice, short }, (waiting) => ({
			type: "job_finished",
			jobId: job.id,
			label: job.label,
			status: job.status === "stopped" || job.status === "failed" ? job.status : "exited",
			...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
			...(job.signal === undefined ? {} : { signal: job.signal }),
			durationMs: job.durationMs,
			outputPath: job.outputPath,
			notified: notice !== undefined,
			running: this.#runningBackground(),
			waiting,
		}));
	}

	/**
	 * Background work ended (a job, or anything else that tells the agent when it ends): its notice, if any, waits for
	 * the agent, and the clients hear `ended` (made with the notices now waiting) in the running turn or the next. With
	 * no turn running, the notice asks for a turn of its own (`wake`).
	 */
	#backgroundEnded(notice: BackgroundNotice | undefined, ended: (waiting: number) => AtelierEventBody): void {
		if (notice !== undefined) {
			this.#backgroundNotices.push(notice);
			if (!this.#noticesHeld) this.#noticesWake = true;
		}
		const event = ended(this.#backgroundNotices.length);
		// Held notices start no turn: the clients hear of the end now, not when the user's next prompt runs.
		const idle = !this.#turnOpen() && this.#noticesHeld && !this.#closed ? this.#options.idleEvent : undefined;
		if (idle !== undefined) this.#sayIdle(idle, event);
		else this.#say(event);
		if (notice !== undefined && this.#turn === undefined && !this.#closed && !this.#noticesHeld) this.#options.wake?.();
	}

	/** The background work running now: what `running` counts in the events and in `jobs`. */
	#runningBackground(): number {
		return (this.#jobs?.running ?? 0) + (this.#tasks?.running ?? 0);
	}

	/**
	 * The woken turn's wait for the notices of work ending with the first: WAKE_GATHER_MS, cut short by an interrupt or
	 * the session's close, and its timer cleared whichever comes first.
	 */
	#gatherNotices(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				if (this.#gathering === done) this.#gathering = undefined;
				resolve();
			};
			const timer = setTimeout(done, WAKE_GATHER_MS);
			signal.addEventListener("abort", done, { once: true });
			this.#gathering = done;
			if (signal.aborted) done();
		});
	}

	/** An event outside any turn: to its listener, and saved with the session as a turn's events are (`turnId` empty). */
	#sayIdle(idle: (event: AtelierEventBody) => void, event: AtelierEventBody): void {
		this.#options.record?.event({ ...event, seq: 0, turnId: "" } as AtelierEvent);
		idle(event);
	}

	/** The waiting notices as the agent reads them, the clients told none waits now; undefined when none waited. */
	#takeNotices(turn: Channel<TurnEvent> | undefined): BackgroundNotice[] | undefined {
		if (this.#backgroundNotices.length === 0) return undefined;
		const notices = this.#backgroundNotices.splice(0);
		this.#noticesWake = false;
		turn?.push({ type: "jobs_status", running: this.#runningBackground(), waiting: 0 });
		return notices;
	}

	/** Notices a prompt took that the backend failed on before answering: they wait again, oldest first. */
	#returnNotices(notices: readonly BackgroundNotice[], turn: Channel<TurnEvent>): void {
		this.#backgroundNotices.unshift(...notices);
		turn.push({ type: "jobs_status", running: this.#runningBackground(), waiting: this.#backgroundNotices.length });
	}

	async #runTool(call: ToolCall): Promise<ToolCallResult> {
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
				...(this.#scratch === undefined ? {} : { scratchDir: this.#scratch.path }),
				callId,
				...(this.#options.noSandbox ? { sandboxOff: true } : {}),
				approvedPaths: this.#approvedPaths,
				...(this.#jobs === undefined ? {} : { jobs: this.#jobs }),
				...(this.#tasks === undefined ? {} : { tasks: this.#tasks }),
				...(this.#options.confined === true ? { confined: true } : {}),
				...(await this.#currentRules(emit)),
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
				(mode === "yolo" && approval?.sandboxFailed !== true && (!confirmed || approval?.yoloWaived === true)) ||
				(approval?.classifyOnly === true && mode !== "auto");
			const verdict =
				approval && mode === "auto" && !confirmed ? await this.#classify(callId, call.tool, approval, emit) : undefined;
			if (verdict?.decision === "deny") return fail(denialMessage(verdict.reason));
			if (approval && (skipped || verdict?.decision === "allow")) {
				if (approval.grant !== undefined) this.#approvedPaths.add(approval.grant);
			} else if (approval && this.#options.unattended === true) {
				return fail(UNATTENDED_DENIAL);
			} else if (approval) {
				const { command, reason, tool: asking, confirm, sandboxFailed } = approval;
				const store = this.#options.permissionRules;
				const project = approval.remember?.project === true ? await store?.project() : undefined;
				const remember =
					store === undefined || approval.remember === undefined
						? undefined
						: {
								rules: approval.remember.rules,
								always: approval.remember.always && store.canSave,
								...(project === undefined ? {} : { project }),
							};
				const question = {
					command,
					...(reason === undefined ? {} : { reason }),
					...(asking === undefined ? {} : { tool: asking }),
					...(confirm === undefined ? {} : { confirm }),
					...(remember === undefined ? {} : { remember }),
					// Only `true` means a failed start; a tool that sends anything else is taken as before, as not failed.
					...(sandboxFailed === true ? { sandboxFailed } : {}),
				};
				emit({ type: "approval_requested", callId, ...question });
				const request = { callId, ...question };
				// The client must have read everything before the question; a turn nobody reads anymore is not asked.
				const delivered = (await this.#turn?.drained(signal)) ?? false;
				const answer = delivered ? ((await this.#options.approve?.(request)) ?? false) : false;
				if (answer === false) return fail(approval.denial ?? "The user denied this command.");
				if (approval.grant !== undefined) this.#approvedPaths.add(approval.grant);
				if (answer !== true && remember !== undefined) {
					await this.#remember(
						asking === "edit" || asking === "write" ? "path" : "bash",
						remember,
						answer.remember,
						emit,
					);
					// The call itself runs as the rule now says: outside the sandbox, with `~/.atelier` unwritable.
					Object.assign(context, await this.#currentRules(emit));
				}
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
				...(outcome.startLines === undefined ? {} : { startLines: outcome.startLines }),
				...(outcome.newStartLines === undefined ? {} : { newStartLines: outcome.newStartLines }),
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
				userQuestions: false,
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

	/** The rules in force for this session, its own first, then the saved ones; none without `permissionRules`. */
	async permissionRules(): Promise<ListedPermissionRule[]> {
		return (await this.#options.permissionRules?.list()) ?? [];
	}

	/** Removes the rule `permissionRules` named `id`; false when there is none. Throws when the saved file cannot be written. */
	async removePermissionRule(id: string): Promise<boolean> {
		return (await this.#options.permissionRules?.remove(id)) ?? false;
	}

	/** The rules in force now, as tools take them; a broken saved file is said once, as a recoverable error, and counts as none. */
	async #currentRules(
		emit: (event: AtelierEventBody) => void,
	): Promise<{ bashRules: string[]; projectBashRules: string[]; projectBounds?: string; pathRules: string[] }> {
		const rules = this.#options.permissionRules;
		if (rules === undefined) return { bashRules: [], projectBashRules: [], pathRules: [] };
		const current = await rules.current();
		if (current.problem !== undefined && !this.#rulesProblemSaid) {
			this.#rulesProblemSaid = true;
			emit(errorEvent("permission_rules_invalid", current.problem, true));
		}
		if (current.ignored !== undefined && !this.#rulesIgnoredSaid) {
			this.#rulesIgnoredSaid = true;
			emit(errorEvent("permission_rules_ignored", current.ignored, true));
		}
		const projectBounds = await rules.checkout();
		return {
			bashRules: current.bash,
			projectBashRules: current.projectBash,
			...(projectBounds === undefined ? {} : { projectBounds }),
			pathRules: current.paths,
		};
	}

	/**
	 * Keeps the answer's rules; what cannot be saved always or in the project (a launcher, a project's command for every
	 * folder, a broken file) is kept for the session, and said.
	 */
	async #remember(
		kind: PermissionRuleKind,
		{ rules, always, project }: { rules: string[]; always: boolean; project?: string },
		scope: PermissionRuleScope,
		emit: (event: AtelierEventBody) => void,
	): Promise<void> {
		const store = this.#options.permissionRules;
		if (store === undefined) return;
		const kept = rules.map((value) => ({ kind, value }));
		if (scope !== "session") {
			try {
				if (scope === "always" && !always) throw new PermissionRulesError(neverAlways(kind, rules));
				if (scope === "project" && project === undefined)
					throw new PermissionRulesError("they are not allowed always in a project here");
				await store.allow(kept, scope);
				return;
			} catch (error) {
				emit(
					errorEvent(
						"permission_rules_not_saved",
						`Not saved: ${describeError(error)}; allowed for this session`,
						true,
					),
				);
			}
		}
		await store.allow(kept, "session").catch((error: unknown) => {
			emit(errorEvent("permission_rules_not_saved", `Not kept: ${describeError(error)}`, true));
		});
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
		const settings = this.#subagentSettings(agent);
		const child = await this.#startChild(options, agent, settings, false);
		if (typeof child === "string") return fail(child);
		this.#child = child;
		const stop = () => void child.interrupt();
		signal?.addEventListener("abort", stop, { once: true });
		const tag: SubagentTag = { ...(callId === undefined ? {} : { parentCallId: callId }), agent: agent.name };
		try {
			// Clients see the child's work in the parent's turn; the parent model never does.
			const result = await this.#childReport(child, agent, settings, prompt, (body) =>
				this.#turn?.push({ ...body, ...tag }),
			);
			if (!result.ok) return fail(result.error);
			const bounded = boundReport(result.report);
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

	/**
	 * Starts a subagent in the background and answers at once with its task id; its report comes as a notice when it
	 * ends. Whatever refuses it does so before its session is created: the session closing, the cap, an agent the
	 * profile does not route, or a profile that cannot be confirmed. It never asks the user, and the turn's interrupt
	 * does not reach it: only `job_stop` and the session's close stop it.
	 */
	async #startBackground(
		options: SubagentOptions,
		agent: SubagentDefinition,
		prompt: string,
		label: string | undefined,
		_context: ToolContext,
	): Promise<ToolOutcome> {
		const fail = (output: string): ToolOutcome => ({ ok: false, output, summary: output, truncated: false });
		const tasks = this.#tasks;
		if (tasks === undefined)
			return fail("Refused: this session cannot receive a background result; run the task without background.");
		const refusal = this.#backgroundRefusal(agent) ?? (agent.name === "worker" ? await this.#noSandbox() : undefined);
		if (refusal !== undefined) return fail(refusal);
		let place: ReturnType<BackgroundTasks["reserve"]>;
		try {
			place = tasks.reserve();
		} catch (error) {
			if (error instanceof TaskRefusedError) return fail(error.message);
			throw error;
		}
		// Whatever ends the launch before the task starts gives its place back once what it made is gone, so the
		// session's close, which waits for the places, never removes the scratch directory under a worktree.
		let worktree: TaskWorktree | undefined;
		let child: Session | undefined;
		const giveUp = async (output: string): Promise<ToolOutcome> => {
			await child?.close().catch(() => {});
			await worktree?.remove();
			place.release();
			return fail(output);
		};
		// A worker writes in a worktree of its own, so two never write in the same folder, nor in the parent's.
		if (agent.name === "worker") {
			try {
				worktree = await createTaskWorktree(
					this.#options.cwd,
					join(this.#scratch?.path ?? tmpdir(), "worktrees", String(++this.#worktrees)),
				);
			} catch (error) {
				if (error instanceof WorktreeRefusedError) return giveUp(error.message);
				return giveUp(`The worker's worktree could not be made: ${describeError(error)}`);
			}
		}
		// The session closed while the worktree was made: nothing more starts.
		if (this.#closed) return giveUp(CLOSING_REFUSAL);
		const settings = this.#subagentSettings(agent);
		const started = await this.#startChild(options, agent, settings, true, worktree);
		if (typeof started === "string") return giveUp(started);
		child = started;
		if (this.#closed) return giveUp(CLOSING_REFUSAL);
		const running = started;
		const tree = worktree;
		let task: TaskInfo;
		try {
			task = place.start({
				agent: agent.name,
				...(label === undefined ? {} : { label }),
				prompt,
				run: async (signal, log): Promise<TaskResult> => {
					// A backend that does not end its turn on the interrupt is closed after a grace.
					let grace: NodeJS.Timeout | undefined;
					const stop = () => {
						void running.interrupt();
						grace = setTimeout(() => void running.close().catch(() => {}), STOP_GRACE_MS);
					};
					signal.addEventListener("abort", stop, { once: true });
					try {
						const result = await this.#childReport(running, agent, settings, prompt, (body) => {
							const line = activityLine(body);
							if (line !== "") log(line);
						});
						// A stopped worker's changes are dropped with its worktree.
						if (tree === undefined || signal.aborted) return result;
						return { ...result, changes: await this.#collectChanges(task.id, tree) };
					} finally {
						signal.removeEventListener("abort", stop);
						clearTimeout(grace);
						// The worktree goes even when the subagent's session fails to close.
						try {
							await running.close();
						} finally {
							await tree?.remove();
						}
					}
				},
			});
		} catch (error) {
			if (error instanceof TaskRefusedError) return giveUp(error.message);
			throw error;
		}
		const where =
			worktree === undefined
				? ""
				: ` It works in its own git worktree, from your working tree as it is now (HEAD ${worktree.head}${worktree.dirty ? " plus uncommitted changes" : ""}); its changes come back as a patch.${DEPENDENCIES_SAID[worktree.dependencies].parent}`;
		return {
			ok: true,
			output: `${taskStartedText(task)}${where}`,
			summary: `${task.label} (task ${task.id} started)`,
			truncated: false,
		};
	}

	/**
	 * What a worker changed, for its notice: the patch, and the files it shares with the parent's changes since the
	 * snapshot and with the patches of the session's other tasks. A patch that cannot be made is said instead.
	 */
	async #collectChanges(id: string, worktree: TaskWorktree): Promise<string> {
		let changes: WorktreeChanges | undefined;
		try {
			changes = await worktree.collect(join(this.#scratch?.path ?? tmpdir(), `${id}.patch`));
		} catch (error) {
			return `Its changes could not be collected: ${describeError(error)}`;
		}
		if (changes === undefined) return "It changed no files.";
		const { files, insertions, deletions, patchPath } = changes;
		const lines = [
			`Its changes: ${files.length} file${files.length === 1 ? "" : "s"} changed, +${insertions} -${deletions}, as a patch against your working tree as it was when the task started: ${patchPath}. Apply it from ${worktree.top} with git apply and check it.`,
		];
		const since = await worktree.changedSince().catch((): string[] => []);
		const shared = files.filter((file) => since.includes(file));
		if (shared.length > 0)
			lines.push(`Files it changed that also changed in your working tree since: ${shared.join(", ")}.`);
		for (const [other, theirs] of this.#patches) {
			const both = files.filter((file) => theirs.includes(file));
			if (both.length > 0) lines.push(`Files the patch of ${other} also changed: ${both.join(", ")}.`);
		}
		this.#patches.set(id, files);
		// Only the latest patches: those the agent may still apply.
		for (const old of [...this.#patches.keys()].slice(0, Math.max(0, this.#patches.size - MAX_KEPT_PATCHES)))
			this.#patches.delete(old);
		return lines.join("\n");
	}

	/**
	 * Why a subagent cannot run in the background with what the session knows of its routing: only the worker and the
	 * explorer have an entry in the profile, and a profile that reported problems when it was read may not route them
	 * as the user wrote. Undefined when it may.
	 */
	#backgroundRefusal(agent: SubagentDefinition): string | undefined {
		if (agent.name !== "worker" && agent.name !== "explorer")
			return `Refused: only the explorer and the worker run in the background, where the session's profile routes them; run ${agent.name} without background.`;
		const [problem] = this.#options.profile?.resolved.reports ?? [];
		if (problem !== undefined)
			return `Refused: the session's profile had problems when it was read (${problem.path}: ${problem.message}), so the subagent's backend and model cannot be confirmed; fix the profile and start a new session, or run the task without background.`;
		return undefined;
	}

	/**
	 * Why a worker cannot run in the background here: it writes only inside the sandbox, so with it off or not available
	 * (or no tool that runs in it) it is refused. Undefined when the sandbox is there.
	 */
	async #noSandbox(): Promise<string | undefined> {
		const tool = this.#options.tools.find((candidate) => candidate.sandboxStatus !== undefined);
		const status = this.#options.noSandbox
			? { available: false as const, reason: SANDBOX_OFF }
			: ((await tool?.sandboxStatus?.({ cwd: this.#options.cwd })) ?? {
					available: false as const,
					reason: "no tool runs in it",
				});
		if (status.available) return undefined;
		return `Refused: a worker runs in the background only in the sandbox, which is not available here (${status.reason}); run it without background.`;
	}

	/** What a subagent runs with: its entry in the profile (only the worker and the explorer have one), else the parent's. */
	#subagentSettings(agent: SubagentDefinition): ReturnType<typeof roleSettings> {
		const role = agent.name === "worker" || agent.name === "explorer" ? agent.name : undefined;
		return roleSettings(
			role === undefined ? undefined : this.#options.profile,
			role ?? "worker",
			undefined,
			this.#thinking,
		);
	}

	/**
	 * Starts a subagent's session, in `normal`, in the parent's folder or in `worktree` (a worker's own); a failure
	 * answers the message the parent sees instead.
	 */
	async #startChild(
		options: SubagentOptions,
		agent: SubagentDefinition,
		settings: ReturnType<typeof roleSettings>,
		unattended: boolean,
		worktree?: TaskWorktree,
	): Promise<Session | string> {
		try {
			const backend = await options.createBackend(settings.backend);
			const model = settings.model ?? agent.models[backend.id] ?? this.#model;
			const childCompaction = compactionSettings(this.#options.profile, backend.id).compaction;
			return await Session.start({
				backend,
				userQuestions: false,
				cwd: worktree?.cwd ?? this.#options.cwd,
				...(model === undefined ? {} : { model }),
				...(settings.thinking === undefined ? {} : { thinking: settings.thinking }),
				...(childCompaction === undefined ? {} : { compaction: childCompaction }),
				// In the definition's order; a tool the parent lacks is skipped, and task never: children do not delegate.
				tools: agent.tools.flatMap((name) => {
					const tool = PARENT_ONLY.has(name) ? undefined : this.#tools.get(name);
					return tool ? [tool] : [];
				}),
				systemPromptAppend:
					worktree === undefined
						? agent.prompt
						: `${agent.prompt}\n\n${WORKTREE_NOTE}${DEPENDENCIES_SAID[worktree.dependencies].worker}`,
				maxRequestsPerTurn: agent.maxRequests,
				// The mode is not passed on: the child runs in normal.
				...(this.#options.noSandbox ? { noSandbox: true } : {}),
				// Nobody answers a background child: what would ask is denied instead.
				...(unattended ? { unattended: true } : {}),
				// A worker in its worktree writes nothing outside it, whatever reaches there through a link.
				...(worktree === undefined ? {} : { confined: true }),
				...(unattended || this.#options.approve === undefined ? {} : { approve: this.#options.approve }),
				// A worker in its own worktree gets none of the user's allowances: what it would do outside it, through a rule
				// that covers the parent's folder or a command run outside the sandbox, asks, so it is denied.
				...(this.#options.permissionRules === undefined || worktree !== undefined
					? {}
					: { permissionRules: this.#options.permissionRules }),
				createId: this.#createId,
			});
		} catch (error) {
			if (settings.backend !== undefined) return roleStartMessage(agent.name, settings.backend, error);
			return `The ${agent.name} subagent could not start: ${describeError(error)}`;
		}
	}

	/** Plays the child's one turn and turns its final text into its report; `onEvent` hears each event worth telling. */
	async #childReport(
		child: Session,
		agent: SubagentDefinition,
		settings: ReturnType<typeof roleSettings>,
		prompt: string,
		onEvent: (body: AtelierEventBody) => void,
	): Promise<SubagentResult> {
		// Only the text after the child's last tool call is its answer.
		let report = "";
		let failure: string | undefined;
		// The parent model never sees the child's compaction rows: a failed one goes with the failure.
		let compactionFailure: string | undefined;
		let stopReason = "incomplete";
		let costUsd: number | undefined;
		for await (const event of child.send(prompt)) {
			// The child's `bash` is the parent's: the status was already said. The context warning is the main agent's.
			if (event.type === "sandbox_status" || event.type === "context_warning") continue;
			const { seq: _seq, turnId: _turnId, ...body } = event;
			onEvent(body);
			if (event.type === "text_delta") report += event.text;
			else if (event.type === "tool_call_started") report = "";
			else if (event.type === "error") failure ??= `${event.code}: ${event.message}`;
			else if (event.type === "compaction_finished" && !event.ok) compactionFailure = event.error ?? "no reason given";
			else if (event.type === "turn_finished") {
				stopReason = event.stopReason;
				costUsd = event.costUsd;
			}
		}
		const cost = costUsd === undefined ? {} : { costUsd };
		if (stopReason === "error" || stopReason === "interrupted" || failure !== undefined) {
			const compaction = compactionFailure === undefined ? "" : `; its compaction failed: ${compactionFailure}`;
			const on = settings.backend === undefined ? "" : ` on ${settings.backend}`;
			return {
				ok: false,
				error: `The ${agent.name} subagent failed${on} (${stopReason}): ${failure ?? "no details"}${compaction}`,
				...cost,
			};
		}
		if (report.trim() === "") return { ok: false, error: `The ${agent.name} subagent returned no report.`, ...cost };
		return { ok: true, report, ...cost };
	}

	/** A background task started: the clients hear it in the turn whose call started it. */
	#taskStarted(task: TaskInfo): void {
		this.#say({
			type: "task_started",
			taskId: task.id,
			agent: task.agent,
			label: task.label,
			outputPath: task.outputPath,
			running: this.#runningBackground(),
		});
	}

	/** A background task ended: as a job's end, its notice waits for the agent and may wake a turn. */
	#taskEnded({ task, notice }: EndedTask): void {
		this.#backgroundEnded(notice, (waiting) => ({
			type: "task_finished",
			taskId: task.id,
			agent: task.agent,
			label: task.label,
			status: task.status === "running" ? "finished" : task.status,
			...(task.error === undefined ? {} : { error: task.error }),
			durationMs: task.durationMs,
			outputPath: task.outputPath,
			...(task.costUsd === undefined ? {} : { costUsd: task.costUsd }),
			...(task.reportTail === undefined ? {} : { reportTail: task.reportTail }),
			notified: notice !== undefined,
			running: this.#runningBackground(),
			waiting,
		}));
	}

	/** Registers the session in memory, once; a failure is said in the first turn, and memory goes on without it. */
	async #beginMemory(memory: MemoryPort): Promise<void> {
		try {
			await memory.begin(`atelier-${this.#memoryId}`, this.#options.cwd);
		} catch (error) {
			this.#notices.push(
				errorEvent(
					"memory_session_failed",
					`Memory did not register this session; it is saved without one: ${describeError(error)}`,
					true,
				),
			);
		}
	}

	/** Starts saving a compaction summary; the turn waits for it, the backend does not. */
	#archive(summary: string): void {
		this.#write(this.#saveSummary(summary));
	}

	#write(work: Promise<void>): void {
		const writing = work.finally(() => this.#memoryWrites.delete(writing));
		this.#memoryWrites.add(writing);
	}

	/**
	 * Starts saving what the user wrote, as `promptForMemory` leaves it: masked, then cut; a credential still found
	 * across words keeps the prompt out. Never throws: the first failure is a recoverable error, said once per session.
	 */
	#keepPrompt(text: string): void {
		const memory = this.#options.memory;
		if (!memory) return;
		const kept = promptForMemory(text);
		if (kept === undefined) return;
		this.#write(
			Promise.resolve()
				.then(() => memory.savePrompt(kept))
				.catch((error) => {
					if (this.#promptFailureSaid) return;
					this.#promptFailureSaid = true;
					this.#say(
						errorEvent(
							"memory_prompt_failed",
							`Your prompts are not being saved to memory: ${describeError(error)}`,
							true,
						),
					);
				}),
		);
	}

	/**
	 * Keeps the summary in memory, then fetches the recent memory for the recovery notice the next prompt carries.
	 * Never throws: the compaction already happened.
	 */
	async #saveSummary(summary: string): Promise<void> {
		const memory = this.#options.memory;
		if (!memory) return;
		const outcome = await this.#storeSummary(memory, summary);
		let context = "";
		let fetched = false;
		try {
			context = await memory.context(CONTEXT_BYTES);
			this.#memoryContext = context;
			fetched = true;
		} catch (error) {
			this.#say(
				errorEvent(
					"memory_recovery_failed",
					`Recent memory could not be fetched after the compaction: ${describeError(error)}`,
					true,
				),
			);
		}
		this.#recovery = { text: recoveryNotice(memory.project, context, outcome, this.#summaryKey), fetched };
	}

	/** Saves the summary once, under the session's key, and says how it went; a failure is a recoverable error. */
	async #storeSummary(memory: MemoryPort, summary: string): Promise<SummaryOutcome> {
		const secret = findSecret(summary);
		if (secret) {
			this.#say(
				errorEvent(
					"memory_summary_skipped",
					`The compaction summary was not saved to memory: it contains what looks like ${secret}.`,
					true,
				),
			);
			return "skipped";
		}
		try {
			const { id, warning } = await memory.save({
				title: `Session summary: ${memory.project}, ${localDate(new Date())}`,
				type: SESSION_SUMMARY_TYPE,
				content: summary,
				topicKey: this.#summaryKey,
			});
			this.#say({
				type: "memory_summary_saved",
				id,
				preview: summaryPreview(summary),
				...(warning === undefined ? {} : { warning }),
			});
			if (warning !== undefined)
				this.#say(
					errorEvent(
						"memory_summary_warning",
						`The compaction summary was saved to memory with a warning: ${warning}`,
						true,
					),
				);
			return "saved";
		} catch (error) {
			this.#say(
				errorEvent(
					"memory_summary_failed",
					`The compaction summary was not saved to memory: ${describeError(error)}`,
					true,
				),
			);
			return error instanceof MemoryUncertainError ? "uncertain" : "failed";
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
/** Ends after which the queue goes back to the user instead of running. */
const UNCLEAN_ENDS: ReadonlySet<string> = new Set(["error", "interrupted"]);

/** A recovery notice, and whether it brings the recent memory (fetched again after the compaction). */
interface Recovery {
	text: string;
	fetched: boolean;
}

/** An event that says the backend did not take the prompt: an error, or a turn that ended on one. */
function refusal(event: AtelierEventBody): boolean {
	return event.type === "error" || (event.type === "turn_finished" && event.stopReason === "error");
}

/**
 * An event that shows the model took the prompt: it answered, or the turn ended on something other than an error or
 * an interrupt. Metadata such as `session_started` comes before a backend may still refuse.
 */
function answered(event: AtelierEventBody): boolean {
	if (event.type === "turn_finished") return event.stopReason !== "error" && event.stopReason !== "interrupted";
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_call_started";
}

/** Waits for `work`, which never rejects, or until `signal` aborts, whichever comes first. */
function untilAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) return work;
	if (signal.aborted) return Promise.resolve();
	let stop = () => {};
	const aborted = new Promise<void>((resolve) => {
		stop = resolve;
		signal.addEventListener("abort", stop, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", stop));
}

/** How steers reach the model with a tool result: as the user's words, apart from the tool's output. */
function steeringText(texts: string[]): string {
	return `The user sent this while you were working; take it into account as you continue:\n\n${texts.join("\n\n")}`;
}

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
