import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type { AgentBackend, BackendSession, BackendStartOptions, ToolExecutor } from "../../backend.ts";
import {
	buildSummaryRequest,
	compactThreshold,
	contextTokens,
	estimateTokens,
	type FileActivity,
	fileActivity,
	findCut,
	KEEP_RECENT_TOKENS,
	replaceHistory,
	turnPromptBefore,
	validateSummary,
} from "../../compaction/compactor.ts";
import {
	type AtelierEventBody,
	type CompactionReason,
	type ContextUsage,
	describeError,
	errorEvent,
	type JsonValue,
	type Usage,
	ZERO_USAGE,
} from "../../events.ts";
import { costOfRequest } from "../../pricing.ts";
import { UsageMeter } from "../../usage-meter.ts";
import { systemPrompt } from "./system-prompt.ts";
import { toAnthropicTools } from "./tool-schema.ts";

export const BACKEND_ID = "anthropic-api";
export const DEFAULT_API_MODEL = "claude-sonnet-5-5";
/** Output budget per request; a turn that needs more continues after its tool results. */
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_MAX_REQUESTS_PER_TURN = 50;
/** Used when the models API does not say the model's window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
const WINDOW_LOOKUP_TIMEOUT_MS = 5_000;
const INTERRUPTED_TOOL = "Interrupted by the user.";
/** 5-minute TTL, the API default. */
const BREAKPOINT: Anthropic.CacheControlEphemeral = Object.freeze({ type: "ephemeral" });

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
	/** The model's context window; looked up in the models API when absent. */
	contextWindow?: number;
	/** Context tokens that start a compaction (`ATELIER_COMPACT_AT`); derived from the window when absent. */
	compactAt?: number;
	/** Size of the history tail a compaction keeps verbatim. */
	keepRecentTokens?: number;
}

interface CompactionConfig {
	window: number;
	compactAt: number;
	keepRecent: number;
}

/** Everything a request is built from. The prefix (tools, system) is fixed when the session starts. */
export interface RequestState {
	model: string;
	maxTokens: number;
	system: string;
	tools: readonly Anthropic.Tool[];
	/** Stored history: it only grows and never carries cache breakpoints. */
	messages: Anthropic.MessageParam[];
	/** Id of the last response, so the API can say why the cache missed. */
	previousMessageId?: string;
}

/**
 * Builds a request with three cache breakpoints, from the most to the least
 * stable part: the last tool, the system block and the last block of the last
 * message. The last one moves forward each request; the API finds the previous
 * write by looking back. Nothing in `state` is modified.
 */
export function buildRequest(state: RequestState): Anthropic.MessageCreateParamsNonStreaming {
	const tools = state.tools.map((tool, index) =>
		index === state.tools.length - 1 ? { ...tool, cache_control: BREAKPOINT } : tool,
	);
	return {
		model: state.model,
		max_tokens: state.maxTokens,
		system: [{ type: "text", text: state.system, cache_control: BREAKPOINT }],
		...(tools.length === 0 ? {} : { tools }),
		messages: state.messages.map((message, index) =>
			index === state.messages.length - 1 ? withBreakpoint(message) : message,
		),
		diagnostics: { previous_message_id: state.previousMessageId ?? null },
	};
}

function withBreakpoint(message: Anthropic.MessageParam): Anthropic.MessageParam {
	const blocks: Anthropic.ContentBlockParam[] =
		typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	// Same role and block kinds as `message`, so the cast cannot change its type.
	return {
		...message,
		content: blocks.map((block, index) =>
			index === blocks.length - 1 ? ({ ...block, cache_control: BREAKPOINT } as Anthropic.ContentBlockParam) : block,
		),
	} as Anthropic.MessageParam;
}

/** Only `*_changed` reasons mean the prompt changed; `previous_message_not_found` and `unavailable` compared nothing. */
function cacheMiss(message: Anthropic.Message): AtelierEventBody | undefined {
	const reason = message.diagnostics?.cache_miss_reason;
	if (!reason?.type.endsWith("_changed")) return undefined;
	const missedTokens = "cache_missed_input_tokens" in reason ? reason.cache_missed_input_tokens : 0;
	return { type: "cache_miss", reason: reason.type, missedTokens };
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
			tools: Object.freeze(toAnthropicTools(start.tools)),
			messages: [],
		};
		const maxRequests = start.maxRequestsPerTurn ?? this.#options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN;
		// The window lookup runs while the session starts; the first request waits for it, never the start.
		const { contextWindow, compactAt, keepRecentTokens } = this.#options;
		const compaction: Promise<CompactionConfig> = (
			contextWindow === undefined ? lookupWindow(client, state.model) : Promise.resolve(contextWindow)
		).then((window) => ({
			window,
			compactAt: compactThreshold({ window, maxTokens: state.maxTokens, override: compactAt }),
			keepRecent: keepRecentTokens ?? KEEP_RECENT_TOKENS,
		}));
		return new AnthropicApiSession(
			client,
			state,
			start.executeTool,
			maxRequests,
			this.#options.apiKey,
			compaction,
			start.compactionState,
			start.compacted,
		);
	}
}

/** The model's input window from the models API, once per session; any failure falls back to the default. */
async function lookupWindow(client: Anthropic, model: string): Promise<number> {
	try {
		const info = await client.models.retrieve(model, null, { maxRetries: 0, timeout: WINDOW_LOOKUP_TIMEOUT_MS });
		return info.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW;
	} catch {
		return DEFAULT_CONTEXT_WINDOW;
	}
}

/** The API's answer to a prompt larger than the window. */
function isOverflow(error: unknown): boolean {
	if (!(error instanceof APIError)) return false;
	if (error.status === 413) return true;
	return error.status === 400 && /prompt is too long|request_too_large|context window/i.test(error.message);
}

class AnthropicApiSession implements BackendSession {
	readonly #client: Anthropic;
	readonly #state: RequestState;
	readonly #executeTool: ToolExecutor;
	readonly #maxRequests: number;
	readonly #apiKey: string;
	readonly #compactionReady: Promise<CompactionConfig>;
	/** Set once the window lookup answered, before the first request. */
	#config: CompactionConfig | undefined;
	readonly #compactionState: (() => string | undefined) | undefined;
	readonly #compacted: ((summary: string) => void) | undefined;
	#abort: AbortController | undefined;
	#announced = false;
	#closed = false;
	/** Context size the last response reported, and the history length it covered. */
	#measured: { tokens: number; length: number } | undefined;
	/** A compaction ran and no response has measured the new history yet. */
	#unmeasured = false;
	#files: FileActivity = { read: [], edited: [] };
	/** Index of the user message that started the current turn; -1 between turns or once a summary holds it. */
	#turnStart = -1;
	/** The current turn's request, verbatim, once a summary had to carry it. */
	#turnPrompt: string | undefined;

	constructor(
		client: Anthropic,
		state: RequestState,
		executeTool: ToolExecutor,
		maxRequests: number,
		apiKey: string,
		compaction: Promise<CompactionConfig>,
		compactionState?: () => string | undefined,
		compacted?: (summary: string) => void,
	) {
		this.#client = client;
		this.#state = state;
		this.#executeTool = executeTool;
		this.#maxRequests = maxRequests;
		this.#apiKey = apiKey;
		this.#compactionReady = compaction;
		this.#compactionState = compactionState;
		this.#compacted = compacted;
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
		this.#turnStart = this.#state.messages.length - 1;
		this.#turnPrompt = undefined;
		if (!(await this.#ready(abort.signal))) {
			if (this.#abort === abort) this.#abort = undefined;
			this.#turnStart = -1;
			yield interruptedBeforeAnyRequest();
			return;
		}
		// A compaction that fails is not tried again in the same turn; an overflow gets one compaction.
		let thresholdFailed = false;
		let overflowTried = false;
		try {
			for (let request = 0; ; request++) {
				if (request >= this.#maxRequests) {
					yield errorEvent("turn_limit", `The turn reached its limit of ${this.#maxRequests} model requests.`, true);
					stopReason = "turn_limit";
					break;
				}
				if (!thresholdFailed && !this.#unmeasured && this.#contextTokens() >= this.#compaction.compactAt) {
					thresholdFailed = !(yield* this.#compact("threshold", abort.signal, meter));
					if (abort.signal.aborted) {
						stopReason = "interrupted";
						break;
					}
				}
				let message: Anthropic.Message;
				try {
					const stream = this.#client.messages.stream(buildRequest(this.#state), { signal: abort.signal });
					for await (const event of stream) {
						if (event.type !== "content_block_delta") continue;
						if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
						else if (event.delta.type === "thinking_delta")
							yield { type: "thinking_delta", text: event.delta.thinking };
					}
					message = await stream.finalMessage();
				} catch (error) {
					if (abort.signal.aborted || overflowTried || !isOverflow(error)) throw error;
					overflowTried = true;
					const compacted = yield* this.#compact("overflow", abort.signal, meter);
					if (abort.signal.aborted) {
						stopReason = "interrupted";
						break;
					}
					if (!compacted) throw error;
					continue;
				}
				const usage = toUsage(message.usage);
				meter.add(usage);
				this.#state.previousMessageId = message.id;
				const miss = cacheMiss(message);
				if (miss) yield miss;
				// Only complete messages enter the history; an interrupted stream leaves nothing behind.
				// The API rejects empty text blocks and empty assistant messages, so neither is kept.
				const content = message.content.filter((block) => block.type !== "text" || block.text !== "");
				if (content.length > 0) this.#state.messages.push({ role: "assistant", content });
				this.#measured = { tokens: contextTokens(usage), length: this.#state.messages.length };
				this.#unmeasured = false;
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
			// Between turns there is no request for a summary to carry.
			this.#turnStart = -1;
			this.#turnPrompt = undefined;
		}
		yield this.#finished(stopReason, meter);
	}

	async *compact(instructions?: string): AsyncIterable<AtelierEventBody> {
		if (this.#closed) throw new Error("The anthropic-api session is closed.");
		const abort = new AbortController();
		this.#abort = abort;
		if (!(await this.#ready(abort.signal))) {
			if (this.#abort === abort) this.#abort = undefined;
			yield interruptedBeforeAnyRequest();
			return;
		}
		const meter = new UsageMeter(this.#state.model);
		let ok = false;
		try {
			ok = yield* this.#compact("manual", abort.signal, meter, instructions);
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
		yield this.#finished(abort.signal.aborted ? "interrupted" : ok ? "end_turn" : "error", meter);
	}

	#finished(stopReason: string, meter: UsageMeter): AtelierEventBody {
		const costUsd = meter.costUsd;
		return {
			type: "turn_finished",
			stopReason,
			usage: meter.usage,
			...(costUsd === undefined ? {} : { costUsd }),
			requests: meter.requests,
			context: this.#context(),
		};
	}

	/**
	 * Waits for the window lookup the first time; false when the turn was
	 * interrupted first, so an interrupt never waits for the models API.
	 */
	async #ready(signal: AbortSignal): Promise<boolean> {
		if (this.#config) return true;
		const config = await untilAborted(this.#compactionReady, signal);
		if (config === undefined) return false;
		this.#config = config;
		return true;
	}

	/** The compaction settings; only read after `send` or `compact` awaited them. */
	get #compaction(): CompactionConfig {
		if (!this.#config) throw new Error("The context window is not known yet.");
		return this.#config;
	}

	#context(): ContextUsage {
		return { tokens: this.#contextTokens(), window: this.#compaction.window, compactAt: this.#compaction.compactAt };
	}

	/** The last measured size plus an estimate of what was appended since. */
	#contextTokens(): number {
		const measured = this.#measured ?? { tokens: 0, length: 0 };
		return this.#state.messages
			.slice(measured.length)
			.reduce((sum, message) => sum + estimateTokens(message), measured.tokens);
	}

	/**
	 * Replaces the history before a cut with its summary. Resolves to whether it
	 * did; on any failure the history is left as it was.
	 */
	async *#compact(
		reason: CompactionReason,
		signal: AbortSignal,
		meter: UsageMeter,
		instructions?: string,
	): AsyncGenerator<AtelierEventBody, boolean> {
		const tokensBefore = this.#contextTokens();
		yield { type: "compaction_started", reason, tokens: tokensBefore };
		const failed = (error: string, usage: Usage = { ...ZERO_USAGE }): AtelierEventBody => {
			const costUsd = costOfRequest(this.#state.model, usage);
			return {
				type: "compaction_finished",
				ok: false,
				reason,
				tokensBefore,
				kept: 0,
				usage,
				...(costUsd === undefined ? {} : { costUsd }),
				error,
			};
		};
		const messages = this.#state.messages;
		const cut = findCut(messages, this.#compaction.keepRecent);
		if (cut === undefined) {
			yield failed("There is not enough history to compact.");
			return false;
		}
		let response: Anthropic.Message;
		try {
			const request = buildSummaryRequest(this.#state, cut, instructions);
			response = await this.#client.messages.stream(request, { signal }).finalMessage();
		} catch (error) {
			yield failed(signal.aborted ? "Interrupted by the user." : this.#redact(describeError(error)));
			return false;
		}
		const usage = toUsage(response.usage);
		meter.add(usage);
		const summary = validateSummary(response);
		if (!summary.ok) {
			yield failed(summary.reason, usage);
			return false;
		}
		const carried = this.#turnStart < 0 ? this.#turnPrompt : turnPromptBefore(messages, this.#turnStart, cut);
		const files = fileActivity(messages.slice(0, cut), this.#files);
		const next = replaceHistory(messages, cut, {
			summary: summary.text,
			files,
			turnPrompt: carried,
			state: this.#compactionState?.(),
		});
		const removed = messages.slice(0, cut).reduce((sum, message) => sum + estimateTokens(message), 0);
		const tokensAfter = Math.max(0, tokensBefore - removed + estimateTokens(next[0] as Anthropic.MessageParam));
		this.#state.messages = next;
		this.#files = files;
		this.#measured = { tokens: tokensAfter, length: next.length };
		this.#unmeasured = true;
		if (this.#turnStart >= cut) this.#turnStart -= cut - 1;
		else {
			this.#turnStart = -1;
			this.#turnPrompt = carried;
		}
		this.#compacted?.(summary.text);
		const costUsd = costOfRequest(this.#state.model, usage);
		yield {
			type: "compaction_finished",
			ok: true,
			reason,
			tokensBefore,
			tokensAfter,
			kept: next.length - 1,
			usage,
			...(costUsd === undefined ? {} : { costUsd }),
		};
		return true;
	}

	#redact(message: string): string {
		return message.replaceAll(this.#apiKey, "[redacted]");
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
		const message = this.#redact(describeError(error));
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

/** A turn interrupted while it waited for the window: no request was made, and the window is not known yet. */
function interruptedBeforeAnyRequest(): AtelierEventBody {
	return { type: "turn_finished", stopReason: "interrupted", usage: { ...ZERO_USAGE }, requests: 0 };
}

/** Resolves with the promise's value, or with undefined as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const stop = () => resolve(undefined);
		signal.addEventListener("abort", stop, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", stop);
			resolve(value);
		});
	});
}
