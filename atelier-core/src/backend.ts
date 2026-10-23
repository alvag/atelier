import type { AtelierEventBody, JsonValue } from "./events.ts";
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
	/** Caps the model requests of one turn; backends without such a cap ignore it. */
	maxRequestsPerTurn?: number;
}

export interface BackendSession {
	/** Runs one turn. The core stamps `seq` and `turnId` on every yielded event. */
	send(prompt: string): AsyncIterable<AtelierEventBody>;
	/** Summarizes the older history now, like a turn ending in `turn_finished`; absent when the backend cannot. */
	compact?(instructions?: string): AsyncIterable<AtelierEventBody>;
	interrupt(): Promise<void>;
	close(): Promise<void>;
}

export interface AgentBackend {
	readonly id: string;
	start(options: BackendStartOptions): Promise<BackendSession>;
}
