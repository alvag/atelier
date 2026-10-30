import type { AtelierEventBody, Effort, JsonValue, Usage } from "./events.ts";
import type { ImageAttachment } from "./images.ts";
import type { ThinkingSend } from "./pricing.ts";
import type { ThinkingLevel } from "./profiles/index.ts";
import type { ToolDefinition } from "./tools/types.ts";

/** A tool call routed by a backend to the core, which owns execution and approval. */
export interface ToolCall {
	tool: string;
	input: JsonValue;
	/** Backend-provided id when available; the core generates one otherwise. */
	callId?: string;
}

export interface ToolCallResult {
	ok: boolean;
	images?: ImageAttachment[];
	/** Text returned to the model. */
	output: string;
	/** What the user said while the turn ran, for the model with this result, apart from the tool's output. */
	steering?: string;
}

export type ToolExecutor = (call: ToolCall, signal?: AbortSignal) => Promise<ToolCallResult>;

/**
 * What a backend needs to carry its conversation into another process: the messages of `anthropic-api`, whose history
 * is Atelier's own, or the id of the session Claude Code keeps on disk for `claude-code`.
 */
export type ResumeState = { messages: JsonValue[] } | { sessionId: string };

export interface BackendStartOptions {
	cwd: string;
	model?: string;
	/** Appended to the backend's system prompt; must be byte-stable across turns. */
	systemPromptAppend: string;
	tools: readonly ToolDefinition[];
	executeTool: ToolExecutor;
	/** The core's state (ODD feature, phase, memory) to give once after a compaction; undefined when there is none. */
	compactionState?: () => string | undefined;
	/** Called with the summary of each compaction that replaced the history, during the turn that compacted. */
	compacted?: (summary: string) => void;
	/** Thinking level for every request; not sent when the model does not support it (see `thinkingToSend`). */
	thinking?: ThinkingLevel;
	/**
	 * The model and level for the request that summarizes the history, when they differ from the session's;
	 * only a backend that makes such a request uses it (anthropic-api).
	 */
	compaction?: { model?: string; thinking?: ThinkingLevel };
	/** Caps the model requests of one turn; backends without such a cap ignore it. */
	maxRequestsPerTurn?: number;
	/** The conversation resumes from this state; start rejects when the backend cannot find or read it. */
	resume?: ResumeState;
	/** The session is saved, so the backend keeps what it needs to resume it (Claude Code writes its own session file). */
	persist?: boolean;
}

/** What a session changes in its backend while it is open; an absent field stays as it is. */
export interface SessionChange {
	model?: string;
	/** A level from the profiles' names (`off`, `minimal`, `low` ... `max`); the backend sends what its model takes. */
	thinking?: ThinkingLevel;
	/**
	 * The profile's compaction entry for the summary request, when a profile change brings a different one; `null`
	 * clears it, so the summary runs with the session's model and level again. Backends that do not summarize ignore it.
	 */
	compaction?: { model?: string; thinking?: ThinkingLevel } | null;
}

/** The whole conversation in words, with what asking for it cost. */
export interface BackendSummary {
	text: string;
	usage: Usage;
	requests?: number;
	costUsd?: number;
}

export interface BackendSession {
	/** The resolved model used for requests, including constructor defaults and the last successful configure. */
	currentModel?(): string;
	/**
	 * Runs one turn. The core stamps `seq` and `turnId` on each event. `images` are normalized attachments sent with the
	 * prompt, which may then be empty; a backend refuses them before changing anything when its model cannot take images.
	 */
	send(prompt: string, images?: readonly ImageAttachment[]): AsyncIterable<AtelierEventBody>;
	/** Summarizes the older history now, like a turn ending in `turn_finished`; absent when the backend cannot. */
	compact?(instructions?: string): AsyncIterable<AtelierEventBody>;
	/**
	 * Summarizes the whole conversation so far, to hand it to another backend; the history stays as it is. Rejects when
	 * the summary cannot be had. Absent when the backend cannot, and the session then refuses to leave it.
	 */
	summarize?(): Promise<BackendSummary>;
	/**
	 * Changes the model or the thinking level for the turns after this call. The session calls it between turns only;
	 * absent when the backend cannot, and the session then refuses the change. A rejection leaves the backend as it was.
	 */
	configure?(change: SessionChange): Promise<void>;
	/** What `resume` needs to continue the conversation as it stands; undefined while there is none. Absent when the backend cannot resume. */
	resumeState?(): ResumeState | undefined;
	/** The thinking level as sent for the turns after the last `configure`, what `session_started` says about the
	 * effort; every session that says an effort there tells it here, absent when none was asked. */
	effortReport?(): ThinkingSend["report"] | undefined;
	interrupt(): Promise<void>;
	close(): Promise<void>;
	/** The effort the backend applied to the last turn when no level was asked, when it reports one. */
	effectiveEffort?(): Effort | undefined;
}

export interface AgentBackend {
	readonly id: string;
	start(options: BackendStartOptions): Promise<BackendSession>;
}
