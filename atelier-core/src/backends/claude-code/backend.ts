import {
	type AccountInfo,
	createSdkMcpServer,
	getSessionInfo,
	type HookCallback,
	type ModelInfo,
	type ModelUsage,
	type Options,
	type SDKControlGetContextUsageResponse,
	type SDKMessage,
	type SDKUserMessage,
	query as sdkQuery,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	BackendSummary,
	ResumeState,
	SessionChange,
	ToolExecutor,
} from "../../backend.ts";
import { Channel } from "../../channel.ts";
import {
	type AtelierEventBody,
	describeError,
	EFFORTS,
	type Effort,
	errorEvent,
	type JsonValue,
	ZERO_USAGE,
} from "../../events.ts";
import { BACKEND_DEFAULTS } from "../../options.ts";
import { summarizesThinking, type ThinkingSend, thinkingToSend } from "../../pricing.ts";
import type { ToolDefinition } from "../../tools/types.ts";
import { VERSION } from "../../version.ts";
import { ContextTracker, compactThresholdOf } from "./context.ts";
import { BACKEND_ID, type MapContext, MCP_SERVER_NAME, mapSdkMessage } from "./map.ts";
import { claudeCodeIdOf, claudeCodeName, isVersionedClaudeId, withoutWindow } from "./models.ts";

/** The model a session runs without one chosen: `opus`, whatever model it stands for now. */
export const DEFAULT_MODEL = BACKEND_DEFAULTS["claude-code"];
export const DEFAULT_INTERRUPT_GRACE_MS = 5000;
const ACCOUNT_INFO_TIMEOUT_MS = 3000;
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** The part of the SDK's Query the backend uses. */
export interface SdkQuery extends AsyncIterable<SDKMessage> {
	interrupt(): Promise<unknown>;
	close(): void;
	accountInfo?(): Promise<AccountInfo>;
	/** The models Claude Code offers this account: a control request to the running process, no API call. */
	supportedModels?(): Promise<ModelInfo[]>;
	/** Changes the model of the open query for the next turns. */
	setModel?(model?: string): Promise<void>;
	/** Merges settings into the open query; `effortLevel: null` goes back to the model's default effort. */
	applyFlagSettings?(settings: { effortLevel?: Effort | null }): Promise<void>;
	/** Claude Code's view of the context; `summary` answers from the last response's usage, without counting tokens. */
	getContextUsage?(opts?: {
		detail?: "summary" | "full";
	}): Promise<Pick<SDKControlGetContextUsageResponse, "isAutoCompactEnabled" | "autoCompactThreshold">>;
}

export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SdkQuery;

export interface ClaudeCodeBackendOptions {
	/** Injected in tests; defaults to the SDK's `query`. */
	query?: QueryFunction;
	/** Environment for the Claude Code process; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Keep ANTHROPIC_API_KEY. By default it is removed so the subscription is used instead of billing the API. */
	keepApiKey?: boolean;
	pathToClaudeCodeExecutable?: string;
	/** How long an interrupted turn may take to finish before the SDK query is closed. */
	interruptGraceMs?: number;
	/** Receives every raw SDK message; used to record fixtures. */
	onSdkMessage?: (message: SDKMessage) => void;
	/**
	 * Given, at each session start, a way to ask that session's Claude Code for its models: the catalog calls it when
	 * its list is old, so no process is started only to list them.
	 */
	listModels?: (list: () => Promise<readonly ModelInfo[]>) => void;
	/** At each turn's end, the window Claude Code ran each model with, by its versioned id. */
	onContextWindows?: (windows: Record<string, number>) => void;
	/** Whether Claude Code still has the session `sessionId` for the folder; injected in tests, the SDK's lookup by default. */
	sessionExists?: (sessionId: string, cwd: string) => Promise<boolean>;
}

/**
 * Exposes Atelier tools to Claude Code as an in-process MCP server. Handlers
 * only route to the core; ids come from the request metadata when present,
 * otherwise from the tool_use blocks announced by the assistant message.
 */
export function createToolBridge(tools: readonly ToolDefinition[], executeTool: ToolExecutor) {
	const announced = new Map<string, string[]>();

	const takeId = (toolName: string, extra: unknown): string | undefined => {
		const queue = announced.get(toolName) ?? [];
		const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
		if (typeof meta === "string") {
			const index = queue.indexOf(meta);
			if (index !== -1) queue.splice(index, 1);
			return meta;
		}
		return queue.shift();
	};

	const definitions = tools.map((definition) =>
		tool(definition.name, definition.description, definition.inputShape, async (args, extra) => {
			const callId = takeId(definition.name, extra);
			const result = await executeTool({
				tool: definition.name,
				input: args as JsonValue,
				...(callId === undefined ? {} : { callId }),
			});
			// What the user steered goes in a block of its own, as Claude Code itself gives what is typed while it works.
			const steering = result.steering === undefined ? [] : [{ type: "text" as const, text: result.steering }];
			return {
				content: [{ type: "text" as const, text: result.output }, ...steering],
				...(result.ok ? {} : { isError: true }),
			};
		}),
	);

	return {
		definitions,
		/** Records tool_use ids from top-level assistant messages, in order. */
		observe(message: SDKMessage): void {
			if (message.type !== "assistant" || message.parent_tool_use_id !== null) return;
			for (const block of message.message?.content ?? []) {
				if (block.type !== "tool_use" || !block.name.startsWith(TOOL_PREFIX)) continue;
				const name = block.name.slice(TOOL_PREFIX.length);
				announced.set(name, [...(announced.get(name) ?? []), block.id]);
			}
		},
	};
}

function childEnv(options: ClaudeCodeBackendOptions): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...(options.env ?? process.env) };
	if (!options.keepApiKey) delete env.ANTHROPIC_API_KEY;
	env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
	env.CLAUDE_AGENT_SDK_CLIENT_APP = `atelier/${VERSION}`;
	return env;
}

/** Runs turns through Claude Code with the Agent SDK, using the user's Claude login. */
export class ClaudeCodeBackend implements AgentBackend {
	readonly id = BACKEND_ID;
	readonly #options: ClaudeCodeBackendOptions;

	constructor(options: ClaudeCodeBackendOptions = {}) {
		this.#options = options;
	}

	async start(start: BackendStartOptions): Promise<BackendSession> {
		const resumed = await this.#resumable(start);
		const bridge = createToolBridge(start.tools, start.executeTool);
		const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: VERSION, tools: bridge.definitions });
		const input = new Channel<SDKUserMessage>();
		const run = this.#options.query ?? (sdkQuery as QueryFunction);
		const model = start.model ?? DEFAULT_MODEL;
		const sent = thinkingToSend(model, start.thinking, "claude-code");
		// Claude Code tells the effort it applied only to hooks inside a turn; read it when Atelier asked none.
		const applied: AppliedEffort = {};
		// A summary asked for by `summarize` goes to it; the others go to the core when it wants them.
		const tap: SummaryTap = {};
		const hooks: Options["hooks"] = {
			PostCompact: [{ hooks: [summaryHook(start.compacted, tap)] }],
			...(sent === undefined ? { Stop: [{ hooks: [effortHook(applied)] }] } : {}),
		};
		const query = run({
			prompt: input,
			options: {
				cwd: start.cwd,
				model: claudeCodeName(model),
				...(sent?.effort === undefined ? {} : { effort: sent.effort }),
				...(sent?.thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
				// The API omits the thinking text by default on these models; the setting alone did not bring it back.
				// Thinking is on by default on the model an alias stands for, as on the model itself.
				...(summarizesThinking(claudeCodeIdOf(model), sent)
					? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
					: {}),
				tools: [],
				mcpServers: { [MCP_SERVER_NAME]: server },
				strictMcpConfig: true,
				settingSources: [],
				skills: [],
				// Thinking summaries, which the API omits by default on recent models, so clients can show the thinking.
				settings: { includeGitInstructions: false, autoMemoryEnabled: false, showThinkingSummaries: true },
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				systemPrompt: { type: "preset", preset: "claude_code", append: start.systemPromptAppend },
				includePartialMessages: true,
				...(start.maxRequestsPerTurn === undefined ? {} : { maxTurns: start.maxRequestsPerTurn }),
				persistSession: start.persist === true,
				...(resumed === undefined ? {} : { resume: resumed }),
				...(Object.keys(hooks).length === 0 ? {} : { hooks }),
				env: childEnv(this.#options),
				...(this.#options.pathToClaudeCodeExecutable === undefined
					? {}
					: { pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable }),
			},
		});
		const { supportedModels } = query;
		if (supportedModels) this.#options.listModels?.(() => supportedModels.call(query));
		const record = this.#options.onSdkMessage;
		const noteWindows = this.#options.onContextWindows;
		const observe = (message: SDKMessage) => {
			record?.(message);
			bridge.observe(message);
			if (message.type === "result" && noteWindows) noteWindows(windowsOf(message.modelUsage));
		};
		return new ClaudeCodeSession(
			query,
			input,
			observe,
			this.#options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS,
			sent?.report,
			applied,
			start.compactionState,
			model,
			start.thinking,
			tap,
			resumed,
		);
	}

	/** The Claude Code session to resume, checked now: a query only fails on a session it does not have when its first prompt is sent. */
	async #resumable(start: BackendStartOptions): Promise<string | undefined> {
		const state = start.resume;
		if (state === undefined) return undefined;
		if (!("sessionId" in state)) throw new Error("The saved state is not a Claude Code session.");
		const exists = this.#options.sessionExists ?? defaultSessionExists;
		if (!(await exists(state.sessionId, start.cwd).catch(() => false)))
			throw new Error(
				`Claude Code has no session ${state.sessionId} for ${start.cwd}; it keeps sessions under ~/.claude/projects and may have removed it.`,
			);
		return state.sessionId;
	}
}

async function defaultSessionExists(sessionId: string, cwd: string): Promise<boolean> {
	return (await getSessionInfo(sessionId, { dir: cwd })) !== undefined;
}

/** Where the next compaction summary goes while `summarize` waits for it, instead of to the core's `compacted`. */
interface SummaryTap {
	take?: ((summary: string) => void) | undefined;
}

/** Claude Code reports its compaction summary only to a PostCompact hook; the hook changes nothing. */
function summaryHook(compacted: ((summary: string) => void) | undefined, tap: SummaryTap): HookCallback {
	return async (input) => {
		if (input.hook_event_name === "PostCompact" && input.compact_summary.trim() !== "")
			(tap.take ?? compacted)?.(input.compact_summary);
		return {};
	};
}

/** The effort Claude Code applied to the current turn, as its hooks report it. */
interface AppliedEffort {
	level?: Effort;
}

/** Records the effort of the main thread's turn from the Stop hook; the hook changes nothing. */
function effortHook(applied: AppliedEffort): HookCallback {
	return async (input) => {
		const level = input.effort?.level;
		if (input.hook_event_name === "Stop" && input.agent_id === undefined && isEffort(level)) applied.level = level;
		return {};
	};
}

function isEffort(level: string | undefined): level is Effort {
	return (EFFORTS as readonly (string | undefined)[]).includes(level);
}

/** Resolves to a subscription only when the account confirms one on Anthropic's own API. */
async function confirmSubscription(query: SdkQuery): Promise<boolean> {
	if (!query.accountInfo) return false;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ACCOUNT_INFO_TIMEOUT_MS);
	});
	try {
		const info = await Promise.race([query.accountInfo(), timeout]);
		return Boolean(info?.subscriptionType) && (info?.apiProvider ?? "firstParty") === "firstParty";
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** The window of each model a turn ran, by its versioned id: the canonical one, or the key without `[1m]`. */
function windowsOf(usage: Record<string, ModelUsage> | undefined): Record<string, number> {
	const windows: Record<string, number> = {};
	for (const [key, entry] of Object.entries(usage ?? {})) {
		const id = withoutWindow(entry.canonicalModel ?? key);
		if (isVersionedClaudeId(id) && Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0)
			windows[id] = entry.contextWindow;
	}
	return windows;
}

class ClaudeCodeSession implements BackendSession {
	readonly #query: SdkQuery;
	readonly #input: Channel<SDKUserMessage>;
	readonly #interruptGraceMs: number;
	readonly #context: MapContext = { previousCostUsd: 0 };
	/** Events that arrive between turns (for example system/init) wait for the next turn. */
	#early: AtelierEventBody[] = [];
	#turn: Channel<AtelierEventBody> | undefined;
	#interruptTimer: NodeJS.Timeout | undefined;
	#closing = false;
	#failure: string | undefined;
	readonly #compactionState: (() => string | undefined) | undefined;
	/** What `session_started` says about the effort. */
	#effort: ThinkingSend["report"] | undefined;
	readonly #applied: AppliedEffort;
	/** Claude Code compacted; the core's state goes with the next prompt. */
	#stateDue = false;
	/** The model and level the open query runs with, as `configure` last set them. */
	#model: string;
	#thinking: SessionChange["thinking"];
	readonly #tap: SummaryTap;
	/** The Claude Code session the SDK messages name: what `resumeState` hands on. */
	#sessionId: string | undefined;
	readonly #contextTracker = new ContextTracker();
	/** Whether the model in use was asked where Claude Code compacts it; counts the asks, so a late answer is dropped. */
	#compactAtAsked = false;
	#compactAtAsks = 0;

	constructor(
		query: SdkQuery,
		input: Channel<SDKUserMessage>,
		observe: (message: SDKMessage) => void,
		interruptGraceMs: number,
		effort: ThinkingSend["report"] | undefined,
		applied: AppliedEffort,
		compactionState: (() => string | undefined) | undefined,
		model: string,
		thinking: SessionChange["thinking"],
		tap: SummaryTap,
		sessionId: string | undefined,
	) {
		this.#sessionId = sessionId;
		this.#tap = tap;
		this.#model = model;
		this.#thinking = thinking;
		this.#query = query;
		this.#input = input;
		this.#interruptGraceMs = interruptGraceMs;
		this.#compactionState = compactionState;
		this.#effort = effort;
		this.#applied = applied;
		void this.#read(observe);
	}

	async #read(observe: (message: SDKMessage) => void): Promise<void> {
		try {
			for await (const message of this.#query) {
				observe(message);
				this.#contextTracker.observe(message);
				if (typeof message.session_id === "string" && message.session_id !== "") this.#sessionId = message.session_id;
				if (message.type === "system" && message.subtype === "compact_boundary") this.#stateDue = true;
				const events = mapSdkMessage(message, this.#context);
				for (const event of events) {
					if (event.type === "turn_finished") {
						const context = this.#contextTracker.usage();
						if (context !== undefined) event.context = context;
					}
					if (event.type !== "session_started") continue;
					if (this.#effort !== undefined) event.effort = this.#effort;
					if (event.authSource === "other" && (await confirmSubscription(this.#query)))
						event.authSource = "subscription";
				}
				this.#deliver(events);
				if (message.type === "result") {
					this.#context.previousCostUsd = message.total_cost_usd;
					this.#endTurn();
				}
			}
			if (!this.#closing) {
				this.#failure = "Claude Code ended the session.";
				this.#deliver([errorEvent("backend_ended", this.#failure)]);
			}
		} catch (error) {
			this.#failure = describeError(error);
			this.#deliver([errorEvent("backend_crashed", this.#failure)]);
		} finally {
			this.#failure ??= "Claude Code session is closed.";
			this.#endTurn();
		}
	}

	/** A delivered turn is immutable: anything that arrives after it closed (a crash, an error) goes to the next turn. */
	#deliver(events: AtelierEventBody[]): void {
		for (const event of events) {
			if (this.#turn && !this.#turn.closed) this.#turn.push(event);
			else this.#early.push(event);
		}
	}

	#endTurn(): void {
		clearTimeout(this.#interruptTimer);
		this.#interruptTimer = undefined;
		this.#turn?.close();
		this.#turn = undefined;
	}

	async *send(prompt: string): AsyncIterable<AtelierEventBody> {
		let sent = prompt;
		if (this.#stateDue) {
			this.#stateDue = false;
			const state = this.#compactionState?.();
			if (state !== undefined) sent = `${state}\n\n${prompt}`;
		}
		yield* this.#turnFor(sent);
	}

	/** Claude Code's own /compact; its compact_boundary reports the result. */
	async *compact(instructions?: string): AsyncIterable<AtelierEventBody> {
		const extra = instructions?.trim();
		yield* this.#turnFor(extra ? `/compact ${extra}` : "/compact");
	}

	/** Claude Code's own /compact over the whole conversation; its summary comes from the PostCompact hook. */
	async summarize(): Promise<BackendSummary> {
		let text: string | undefined;
		let finish: Extract<AtelierEventBody, { type: "turn_finished" }> | undefined;
		let failure: string | undefined;
		this.#tap.take = (summary) => {
			text = summary;
		};
		try {
			for await (const event of this.compact()) {
				if (event.type === "turn_finished") finish ??= event;
				else if (event.type === "error") failure ??= event.message;
				else if (event.type === "compaction_finished" && !event.ok) failure ??= event.error ?? "compaction failed";
			}
		} finally {
			this.#tap.take = undefined;
		}
		if (failure !== undefined) throw new Error(failure);
		if (text === undefined) throw new Error("Claude Code did not report a summary of the conversation.");
		return {
			text,
			usage: finish?.usage ?? { ...ZERO_USAGE },
			...(finish?.requests === undefined ? {} : { requests: finish.requests }),
			...(finish?.costUsd === undefined ? {} : { costUsd: finish.costUsd }),
		};
	}

	async *#turnFor(prompt: string): AsyncIterable<AtelierEventBody> {
		const early = this.#early;
		this.#early = [];
		// A level belongs to the turn its Stop hook ran in, also when this turn only reports a failure.
		delete this.#applied.level;
		if (this.#failure !== undefined) {
			// The session failed between turns: this turn reports why, the ones after it refuse.
			if (early.length === 0) throw new Error(this.#failure);
			yield* early;
			return;
		}
		if (!this.#compactAtAsked) this.#askCompactAt();
		const turn = new Channel<AtelierEventBody>();
		for (const event of early) turn.push(event);
		this.#turn = turn;
		this.#input.push({
			type: "user",
			message: { role: "user", content: prompt },
			parent_tool_use_id: null,
		} as SDKUserMessage);
		yield* turn;
	}

	/** Asks where Claude Code compacts the model in use, without waiting: until it answers, the window stands for it. */
	#askCompactAt(): void {
		this.#compactAtAsked = true;
		const ask = ++this.#compactAtAsks;
		const { getContextUsage } = this.#query;
		if (!getContextUsage) return;
		getContextUsage.call(this.#query, { detail: "summary" }).then(
			(usage) => {
				if (ask === this.#compactAtAsks) this.#contextTracker.compactAt = compactThresholdOf(usage);
			},
			() => {},
		);
	}

	/** Asks Claude Code to stop; if the turn does not end within the grace period, closes the query. */
	async interrupt(): Promise<void> {
		const turn = this.#turn;
		await this.#query.interrupt().catch(() => {});
		if (!turn || turn !== this.#turn || this.#interruptTimer) return;
		this.#interruptTimer = setTimeout(() => {
			if (this.#turn !== turn) return;
			this.#deliver([errorEvent("interrupt_timeout", "Claude Code did not stop in time; the session was closed.")]);
			this.#closing = true;
			this.#query.close();
		}, this.#interruptGraceMs);
	}

	resumeState(): ResumeState | undefined {
		return this.#sessionId === undefined ? undefined : { sessionId: this.#sessionId };
	}

	effectiveEffort(): Effort | undefined {
		return this.#applied.level;
	}

	/** The level as the start or the last `configure` left it: what `session_started` says about the effort. */
	effortReport(): ThinkingSend["report"] | undefined {
		return this.#effort;
	}

	/** Sets the model and the effort in the open query: they hold from the next prompt, which has not been sent yet. */
	async configure(change: SessionChange): Promise<void> {
		const { setModel, applyFlagSettings } = this.#query;
		if (!setModel || !applyFlagSettings) throw new Error("This Claude Code query cannot change an open session.");
		const model = change.model ?? this.#model;
		const thinking = change.thinking ?? this.#thinking;
		const sent = thinkingToSend(model, thinking, "claude-code");
		// The Agent SDK has no way to turn thinking off in an open query; refuse before changing anything.
		if (change.thinking !== undefined && sent?.report === "off")
			throw new Error("claude-code cannot turn thinking off in an open session.");
		if (change.model !== undefined) {
			await setModel.call(this.#query, claudeCodeName(change.model));
			// Where Claude Code compacts the new model is asked with its first turn; an answer about the old one is dropped.
			this.#compactAtAsked = false;
			this.#compactAtAsks++;
			this.#contextTracker.compactAt = undefined;
		}
		this.#model = model;
		// A new model only needs the effort again when it takes the level differently from the old one.
		if (sent !== undefined && (change.thinking !== undefined || sent.report !== this.#effort)) {
			await applyFlagSettings.call(this.#query, { effortLevel: sent.effort ?? null });
			this.#effort = sent.report;
		}
		this.#thinking = thinking;
	}

	async close(): Promise<void> {
		this.#closing = true;
		clearTimeout(this.#interruptTimer);
		this.#input.close();
		this.#query.close();
	}
}
