import type { AtelierEventBody, Effort, JsonValue } from "./events.ts";
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
	/** Text returned to the model. */
	output: string;
}

export type ToolExecutor = (call: ToolCall, signal?: AbortSignal) => Promise<ToolCallResult>;

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
}

/** What a session changes in its backend while it is open; an absent field stays as it is. */
export interface SessionChange {
	model?: string;
	/** A level from the profiles' names (`off`, `minimal`, `low` ... `max`); the backend sends what its model takes. */
	thinking?: ThinkingLevel;
}

export interface BackendSession {
	/** Runs one turn. The core stamps `seq` and `turnId` on every yielded event. */
	send(prompt: string): AsyncIterable<AtelierEventBody>;
	/** Summarizes the older history now, like a turn ending in `turn_finished`; absent when the backend cannot. */
	compact?(instructions?: string): AsyncIterable<AtelierEventBody>;
	/**
	 * Changes the model or the thinking level for the turns after this call. The session calls it between turns only;
	 * absent when the backend cannot, and the session then refuses the change. A rejection leaves the backend as it was.
	 */
	configure?(change: SessionChange): Promise<void>;
	interrupt(): Promise<void>;
	close(): Promise<void>;
	/** The effort the backend applied to the last turn when no level was asked, when it reports one. */
	effectiveEffort?(): Effort | undefined;
}

export interface AgentBackend {
	readonly id: string;
	start(options: BackendStartOptions): Promise<BackendSession>;
}
