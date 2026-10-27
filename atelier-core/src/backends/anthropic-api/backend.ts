import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	BackendSummary,
	ResumeState,
	SessionChange,
	ToolExecutor,
} from "../../backend.ts";
import {
	buildHandoffRequest,
	buildSummaryRequest,
	compactThreshold,
	contextTokens,
	estimateTokens,
	type FileActivity,
	fileActivity,
	filesSection,
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
	type Effort,
	errorEvent,
	type JsonValue,
	type Usage,
	ZERO_USAGE,
} from "../../events.ts";
import { costOfRequest, type ThinkingOff, type ThinkingSend, thinkingToSend } from "../../pricing.ts";
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

/** A history message, with the effort (or `off`) an assistant answer was asked with; the API never sees `effort`. */
export type StoredMessage = Anthropic.MessageParam & { effort?: Effort | "off" };

/** What the summary request changes in the request state: the model and how it thinks. */
export type SummaryRequestState = Pick<RequestState, "model" | "effort" | "thinking">;

/** The summary request's model and level: the compaction entry's, and the session's where the entry sets none. */
function summaryRequest(
	model: string,
	thinking: SessionChange["thinking"],
	entry: NonNullable<SessionChange["compaction"]>,
): SummaryRequestState {
	const summaryModel = entry.model ?? model;
	const sent = thinkingToSend(summaryModel, entry.thinking ?? thinking, BACKEND_ID);
	return {
		model: summaryModel,
		...(sent?.effort === undefined ? {} : { effort: sent.effort }),
		...(sent?.thinking === undefined ? {} : { thinking: sent.thinking }),
	};
}

/** Totals a turn's requests; the summary may run on another model, so it is priced on its own. */
class TurnMeter {
	readonly #main: UsageMeter;
	readonly #summary: UsageMeter | undefined;

	constructor(model: string, summaryModel?: string) {
		this.#main = new UsageMeter(model);
		this.#summary = summaryModel === undefined ? undefined : new UsageMeter(summaryModel);
	}

	add(usage: Usage): void {
		this.#main.add(usage);
	}

	addSummary(usage: Usage): void {
		(this.#summary ?? this.#main).add(usage);
	}

	get usage(): Usage {
		const main = this.#main.usage;
		const summary = this.#summary?.usage ?? ZERO_USAGE;
		return {
			input: main.input + summary.input,
			output: main.output + summary.output,
			cacheRead: main.cacheRead + summary.cacheRead,
			cacheWrite: main.cacheWrite + summary.cacheWrite,
		};
	}

	get requests(): number {
		return this.#main.requests + (this.#summary?.requests ?? 0);
	}

	/** Undefined when either model has no price. */
	get costUsd(): number | undefined {
		if (this.#summary === undefined) return this.#main.costUsd;
		const main = this.#main.costUsd;
		const summary = this.#summary.costUsd;
		return main === undefined || summary === undefined ? undefined : main + summary;
	}
}

/** Everything a request is built from. The prefix (tools, system) is fixed when the session starts. */
export interface RequestState {
	model: string;
	maxTokens: number;
	/** Sent as `output_config.effort`; absent when none was asked or the model does not support it. */
	effort?: Effort;
	/** Sent as `thinking`, to turn thinking off; absent when none was asked or the model cannot turn it off. */
	thinking?: ThinkingOff;
	system: string;
	tools: readonly Anthropic.Tool[];
	/** Stored history: it only grows and never carries cache breakpoints. */
	messages: StoredMessage[];
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
		...(state.effort === undefined ? {} : { output_config: { effort: state.effort } }),
		...(state.thinking === undefined ? {} : { thinking: { type: state.thinking } }),
		messages: state.messages.map((message, index) =>
			index === state.messages.length - 1 ? withBreakpoint(toParam(message)) : toParam(message),
		),
		diagnostics: { previous_message_id: state.previousMessageId ?? null },
	};
}

/** The message as the API takes it: without the effort Atelier keeps next to it. */
function toParam(message: StoredMessage): Anthropic.MessageParam {
	if (message.effort === undefined) return message;
	const { effort: _effort, ...param } = message;
	return param;
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
		const model = start.model ?? this.#options.model ?? DEFAULT_API_MODEL;
		const sent = thinkingToSend(model, start.thinking, BACKEND_ID);
		const state: RequestState = {
			model,
			maxTokens: this.#options.maxTokens ?? DEFAULT_MAX_TOKENS,
			...(sent?.effort === undefined ? {} : { effort: sent.effort }),
			...(sent?.thinking === undefined ? {} : { thinking: sent.thinking }),
			system: systemPrompt(start.cwd, start.systemPromptAppend),
			tools: Object.freeze(toAnthropicTools(start.tools)),
			messages: savedMessages(start.resume),
		};
		// The summary request has its own model and level when the profile's compaction entry sets them.
		const summary =
			start.compaction === undefined ? undefined : summaryRequest(model, start.thinking, start.compaction);
		const maxRequests = start.maxRequestsPerTurn ?? this.#options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN;
		// The window lookup runs while the session starts; the first request waits for it, never the start.
		const { contextWindow, compactAt, keepRecentTokens } = this.#options;
		const compactionFor = (forModel: string): Promise<CompactionConfig> =>
			(contextWindow === undefined ? lookupWindow(client, forModel) : Promise.resolve(contextWindow)).then(
				(window) => ({
					window,
					compactAt: compactThreshold({ window, maxTokens: state.maxTokens, override: compactAt }),
					keepRecent: keepRecentTokens ?? KEEP_RECENT_TOKENS,
				}),
			);
		return new AnthropicApiSession(
			client,
			state,
			start.executeTool,
			maxRequests,
			this.#options.apiKey,
			compactionFor,
			sent?.report,
			start.compactionState,
			start.compacted,
			summary,
			start.thinking,
		);
	}
}

/** The history a saved session resumes with; rejects what is not a conversation the API would take. */
function savedMessages(resume: ResumeState | undefined): StoredMessage[] {
	if (resume === undefined) return [];
	if (!("messages" in resume)) throw new Error("The saved state is not an anthropic-api history.");
	const messages = structuredClone(resume.messages) as unknown[];
	const readable = messages.every((message) => {
		const candidate = message as { role?: unknown; content?: unknown } | null;
		return (
			typeof candidate === "object" &&
			candidate !== null &&
			(candidate.role === "user" || candidate.role === "assistant") &&
			(typeof candidate.content === "string" || Array.isArray(candidate.content))
		);
	});
	if (!readable) throw new Error("The saved history holds a message that is not a user or assistant message.");
	return messages as StoredMessage[];
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
	readonly #compactionFor: (model: string) => Promise<CompactionConfig>;
	#compactionReady: Promise<CompactionConfig>;
	/** What `session_started` says about the effort, as the last `configure` left it. */
	#effort: ThinkingSend["report"] | undefined;
	/** The level the session asked for, so a new model can take it differently. */
	#thinking: SessionChange["thinking"];
	/** Set once the window lookup answered, before the first request. */
	#config: CompactionConfig | undefined;
	readonly #compactionState: (() => string | undefined) | undefined;
	readonly #compacted: ((summary: string) => void) | undefined;
	/** Set when the summary request runs on another model or level than the session's. */
	#summary: SummaryRequestState | undefined;
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
		compactionFor: (model: string) => Promise<CompactionConfig>,
		effort: ThinkingSend["report"] | undefined,
		compactionState?: () => string | undefined,
		compacted?: (summary: string) => void,
		summary?: SummaryRequestState,
		thinking?: SessionChange["thinking"],
	) {
		this.#client = client;
		this.#state = state;
		this.#executeTool = executeTool;
		this.#maxRequests = maxRequests;
		this.#apiKey = apiKey;
		this.#compactionFor = compactionFor;
		this.#compactionReady = compactionFor(state.model);
		this.#thinking = thinking;
		this.#effort = effort;
		this.#compactionState = compactionState;
		this.#compacted = compacted;
		this.#summary = summary;
	}

	resumeState(): ResumeState | undefined {
		return this.#state.messages.length === 0 ? undefined : { messages: this.#state.messages as unknown as JsonValue[] };
	}

	async *send(prompt: string): AsyncIterable<AtelierEventBody> {
		if (this.#closed) throw new Error("The anthropic-api session is closed.");
		if (!this.#announced) {
			this.#announced = true;
			yield {
				type: "session_started",
				backend: BACKEND_ID,
				model: this.#state.model,
				authSource: "api_key",
				...(this.#effort === undefined ? {} : { effort: this.#effort }),
			};
		}
		const abort = new AbortController();
		this.#abort = abort;
		const meter = new TurnMeter(this.#state.model, this.#summary?.model);
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
				const effort = this.#state.thinking === undefined ? this.#state.effort : "off";
				if (content.length > 0)
					this.#state.messages.push({ role: "assistant", content, ...(effort === undefined ? {} : { effort }) });
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

	/** The next request carries the new model and what its level gives there; the history stays as it is. */
	async configure(change: SessionChange): Promise<void> {
		const state = this.#state;
		const model = change.model ?? state.model;
		const thinking = change.thinking ?? this.#thinking;
		const sent = thinkingToSend(model, thinking, BACKEND_ID);
		delete state.effort;
		delete state.thinking;
		if (sent?.effort !== undefined) state.effort = sent.effort;
		if (sent?.thinking !== undefined) state.thinking = sent.thinking;
		this.#effort = sent?.report;
		this.#thinking = thinking;
		// A new entry replaces the summary request's model and level; none makes it the session's own request.
		if (change.compaction !== undefined) {
			this.#summary = change.compaction === null ? undefined : summaryRequest(model, thinking, change.compaction);
		}
		if (model !== state.model) {
			state.model = model;
			// The window belongs to the model: the next request waits for the new one.
			this.#config = undefined;
			this.#compactionReady = this.#compactionFor(model);
		}
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
		const meter = new TurnMeter(this.#state.model, this.#summary?.model);
		let ok = false;
		try {
			ok = yield* this.#compact("manual", abort.signal, meter, instructions);
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
		yield this.#finished(abort.signal.aborted ? "interrupted" : ok ? "end_turn" : "error", meter);
	}

	/**
	 * One summary request over the whole history, for a session that leaves this backend. The history and the files
	 * counted stay as they are; the request is the compaction's, with the compaction entry's model and level.
	 */
	async summarize(): Promise<BackendSummary> {
		if (this.#closed) throw new Error("The anthropic-api session is closed.");
		const messages = this.#state.messages;
		if (messages.length === 0) throw new Error("There is no conversation to summarize.");
		const state = this.#summaryState();
		let response: Anthropic.Message;
		try {
			response = await this.#client.messages.stream(buildHandoffRequest(state)).finalMessage();
		} catch (error) {
			throw new Error(this.#redact(describeError(error)));
		}
		const usage = toUsage(response.usage);
		const summary = validateSummary(response);
		if (!summary.ok) throw new Error(summary.reason);
		const costUsd = costOfRequest(state.model, usage);
		return {
			text: `${summary.text}\n\n${filesSection(fileActivity(messages, this.#files))}`,
			usage,
			requests: 1,
			...(costUsd === undefined ? {} : { costUsd }),
		};
	}

	#finished(stopReason: string, meter: TurnMeter): AtelierEventBody {
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
		meter: TurnMeter,
		instructions?: string,
	): AsyncGenerator<AtelierEventBody, boolean> {
		const tokensBefore = this.#contextTokens();
		yield { type: "compaction_started", reason, tokens: tokensBefore };
		const failed = (error: string, usage: Usage = { ...ZERO_USAGE }): AtelierEventBody => {
			const costUsd = costOfRequest(this.#summary?.model ?? this.#state.model, usage);
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
			const request = buildSummaryRequest(this.#summaryState(), cut, instructions);
			response = await this.#client.messages.stream(request, { signal }).finalMessage();
		} catch (error) {
			yield failed(signal.aborted ? "Interrupted by the user." : this.#redact(describeError(error)));
			return false;
		}
		const usage = toUsage(response.usage);
		meter.addSummary(usage);
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
		const costUsd = costOfRequest(this.#summary?.model ?? this.#state.model, usage);
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

	/** The state the summary request is built from: the session's, with the compaction entry's model and level. */
	#summaryState(): RequestState {
		if (this.#summary === undefined) return this.#state;
		const { effort: _effort, thinking: _thinking, ...rest } = this.#state;
		return { ...rest, ...this.#summary };
	}

	#redact(message: string): string {
		return message.replaceAll(this.#apiKey, "[redacted]");
	}

	/**
	 * Runs tool_use blocks in order; once interrupted, the rest get an error result so the history stays valid. What the
	 * user steered with a result follows all of them as text, since tool results come first in a user message.
	 */
	async #runTools(content: Anthropic.ContentBlock[], signal: AbortSignal): Promise<Anthropic.ContentBlockParam[]> {
		const results: Anthropic.ToolResultBlockParam[] = [];
		const steering: Anthropic.TextBlockParam[] = [];
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
			if (result.steering !== undefined) steering.push({ type: "text", text: result.steering });
		}
		return [...results, ...steering];
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
