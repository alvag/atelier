import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type { AgentBackend, BackendSession, BackendStartOptions, ToolExecutor } from "../../backend.ts";
import { type AtelierEventBody, describeError, errorEvent, type JsonValue, type Usage } from "../../events.ts";
import { UsageMeter } from "../../usage-meter.ts";
import { systemPrompt } from "./system-prompt.ts";
import { toAnthropicTools } from "./tool-schema.ts";

export const BACKEND_ID = "anthropic-api";
export const DEFAULT_API_MODEL = "claude-sonnet-5-5";
/** Output budget per request; a turn that needs more continues after its tool results. */
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_MAX_REQUESTS_PER_TURN = 50;
const INTERRUPTED_TOOL = "Interrupted by the user.";

export interface AnthropicApiBackendOptions {
	/** Always passed explicitly, so the SDK never looks for credentials on its own. */
	apiKey: string;
	/** Injected in tests. */
	fetch?: typeof globalThis.fetch;
	model?: string;
	maxTokens?: number;
	maxRequestsPerTurn?: number;
	/** SDK retries for 429, 5xx and connection errors (SDK default: 2). */
	maxRetries?: number;
}

/** Everything a request is built from. The prefix (tools, system) is fixed when the session starts. */
export interface RequestState {
	model: string;
	maxTokens: number;
	system: string;
	tools: Anthropic.Tool[];
	messages: Anthropic.MessageParam[];
}

export function buildRequest(state: RequestState): Anthropic.MessageCreateParamsNonStreaming {
	return {
		model: state.model,
		max_tokens: state.maxTokens,
		system: state.system,
		...(state.tools.length === 0 ? {} : { tools: state.tools }),
		messages: state.messages,
	};
}

/** Runs turns with Atelier's own loop on the Messages API, billed to an API key. */
export class AnthropicApiBackend implements AgentBackend {
	readonly id = BACKEND_ID;
	readonly #options: AnthropicApiBackendOptions;

	constructor(options: AnthropicApiBackendOptions) {
		this.#options = options;
	}

	async start(start: BackendStartOptions): Promise<BackendSession> {
		const client = new Anthropic({
			apiKey: this.#options.apiKey,
			...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
			...(this.#options.maxRetries === undefined ? {} : { maxRetries: this.#options.maxRetries }),
		});
		const state: RequestState = {
			model: start.model ?? this.#options.model ?? DEFAULT_API_MODEL,
			maxTokens: this.#options.maxTokens ?? DEFAULT_MAX_TOKENS,
			system: systemPrompt(start.cwd, start.systemPromptAppend),
			tools: toAnthropicTools(start.tools),
			messages: [],
		};
		const maxRequests = this.#options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN;
		return new AnthropicApiSession(client, state, start.executeTool, maxRequests, this.#options.apiKey);
	}
}

class AnthropicApiSession implements BackendSession {
	readonly #client: Anthropic;
	readonly #state: RequestState;
	readonly #executeTool: ToolExecutor;
	readonly #maxRequests: number;
	readonly #apiKey: string;
	#abort: AbortController | undefined;
	#announced = false;
	#closed = false;

	constructor(client: Anthropic, state: RequestState, executeTool: ToolExecutor, maxRequests: number, apiKey: string) {
		this.#client = client;
		this.#state = state;
		this.#executeTool = executeTool;
		this.#maxRequests = maxRequests;
		this.#apiKey = apiKey;
	}

	async *send(prompt: string): AsyncIterable<AtelierEventBody> {
		if (this.#closed) throw new Error("The anthropic-api session is closed.");
		if (!this.#announced) {
			this.#announced = true;
			yield { type: "session_started", backend: BACKEND_ID, model: this.#state.model, authSource: "api_key" };
		}
		const abort = new AbortController();
		this.#abort = abort;
		const meter = new UsageMeter(this.#state.model);
		let stopReason = "error";
		this.#appendUser([{ type: "text", text: prompt }]);
		try {
			for (let request = 0; ; request++) {
				if (request >= this.#maxRequests) {
					yield errorEvent("turn_limit", `The turn reached its limit of ${this.#maxRequests} model requests.`, true);
					stopReason = "turn_limit";
					break;
				}
				const stream = this.#client.messages.stream(buildRequest(this.#state), { signal: abort.signal });
				for await (const event of stream) {
					if (event.type !== "content_block_delta") continue;
					if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
					else if (event.delta.type === "thinking_delta") yield { type: "thinking_delta", text: event.delta.thinking };
				}
				const message = await stream.finalMessage();
				meter.add(toUsage(message.usage));
				// Only complete messages enter the history; an interrupted stream leaves nothing behind.
				this.#state.messages.push({ role: "assistant", content: message.content });
				if (message.stop_reason !== "tool_use") {
					stopReason = message.stop_reason ?? "end_turn";
					break;
				}
				this.#appendUser(await this.#runTools(message.content, abort.signal));
				if (abort.signal.aborted) {
					stopReason = "interrupted";
					break;
				}
			}
		} catch (error) {
			if (abort.signal.aborted) stopReason = "interrupted";
			else yield this.#apiError(error);
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
		const costUsd = meter.costUsd;
		yield { type: "turn_finished", stopReason, usage: meter.usage, ...(costUsd === undefined ? {} : { costUsd }) };
	}

	/** Runs tool_use blocks in order; once interrupted, the rest get an error result so the history stays valid. */
	async #runTools(content: Anthropic.ContentBlock[], signal: AbortSignal): Promise<Anthropic.ToolResultBlockParam[]> {
		const results: Anthropic.ToolResultBlockParam[] = [];
		for (const block of content) {
			if (block.type !== "tool_use") continue;
			if (signal.aborted) {
				results.push({ type: "tool_result", tool_use_id: block.id, content: INTERRUPTED_TOOL, is_error: true });
				continue;
			}
			const result = await this.#executeTool(
				{ tool: block.name, input: block.input as JsonValue, callId: block.id },
				signal,
			);
			results.push({
				type: "tool_result",
				tool_use_id: block.id,
				content: result.output,
				...(result.ok ? {} : { is_error: true }),
			});
		}
		return results;
	}

	/** Roles must alternate: after an interrupt the last message may already be the user's. */
	#appendUser(blocks: Anthropic.ContentBlockParam[]): void {
		const last = this.#state.messages.at(-1);
		if (last?.role !== "user") {
			this.#state.messages.push({ role: "user", content: blocks });
			return;
		}
		const previous = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
		last.content = [...previous, ...blocks];
	}

	#apiError(error: unknown): AtelierEventBody {
		const message = describeError(error).replaceAll(this.#apiKey, "[redacted]");
		if (!(error instanceof APIError)) return errorEvent("api_error", message, true);
		const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type;
		if (error.status === 429 || type === "rate_limit_error") return errorEvent("rate_limited", message, true);
		if (error.status === 529 || type === "overloaded_error") return errorEvent("overloaded", message, true);
		if (error.status === 401 || type === "authentication_error")
			return errorEvent("authentication_error", message, false);
		if (error.status === 400 || type === "invalid_request_error") return errorEvent("invalid_request", message, false);
		return errorEvent("api_error", message, error.status === undefined || error.status >= 500);
	}

	async interrupt(): Promise<void> {
		this.#abort?.abort();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#abort?.abort();
	}
}

function toUsage(usage: Anthropic.Usage): Usage {
	return {
		input: usage.input_tokens,
		output: usage.output_tokens,
		cacheRead: usage.cache_read_input_tokens ?? 0,
		cacheWrite: usage.cache_creation_input_tokens ?? 0,
	};
}
