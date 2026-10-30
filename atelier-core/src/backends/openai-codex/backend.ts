import { randomUUID } from "node:crypto";
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
	checkSummaryText,
	compactThreshold,
	type FileActivity,
	filesSection,
	KEEP_RECENT_TOKENS,
	SUMMARY_INSTRUCTION,
	summaryInstruction,
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
import { imageInputProblem, imageOmission } from "../../image-support.ts";
import type { ThinkingLevel } from "../../profiles/index.ts";
import {
	buildResponsesBody,
	type InputImage,
	type InputText,
	type ResponsesError,
	type ResponsesItem,
	type ResponsesTool,
	type ResponsesUsage,
	streamResponse,
} from "../../responses/client.ts";
import { systemPrompt } from "../anthropic-api/system-prompt.ts";
import { toAnthropicTools } from "../anthropic-api/tool-schema.ts";
import { CodexAccess, type CodexAccessOptions, NotSignedInError } from "./access.ts";
import {
	estimateItem,
	findItemCut,
	itemFileActivity,
	outputText,
	replaceItems,
	turnPromptBeforeItem,
	withInstruction,
} from "./compaction.ts";
import { type CodexReasoning, codexContextWindow, codexReasoning, DEFAULT_CODEX_MODEL } from "./models.ts";

export const BACKEND_ID = "openai-codex";
/** No output cap is sent; this is the room kept for the answer when deciding when to compact. */
const OUTPUT_RESERVE = 32_000;
const INTERRUPTED_TOOL = "Interrupted by the user.";

export interface OpenAiCodexBackendOptions extends CodexAccessOptions {
	model?: string;
	/** Caps the model requests of every turn; without it (nor the start option) a turn runs until the model stops. */
	maxRequestsPerTurn?: number;
	contextWindow?: number;
	/** Context tokens that start a compaction (`ATELIER_COMPACT_AT`). */
	compactAt?: number;
	keepRecentTokens?: number;
}

export interface CompactionConfig {
	window: number;
	compactAt: number;
	keepRecent: number;
}

/**
 * Atelier's own loop on OpenAI's Responses API with the ChatGPT subscription: the legacy Codex endpoint, or
 * api.openai.com with Sign in with ChatGPT (see `access.ts`). The history is Atelier's, sent whole on each request.
 */
export class OpenAiCodexBackend implements AgentBackend {
	readonly id = BACKEND_ID;
	readonly #options: OpenAiCodexBackendOptions;

	constructor(options: OpenAiCodexBackendOptions) {
		this.#options = options;
	}

	async start(start: BackendStartOptions): Promise<BackendSession> {
		const model = start.model ?? this.#options.model ?? DEFAULT_CODEX_MODEL;
		const keepRecent = this.#options.keepRecentTokens ?? KEEP_RECENT_TOKENS;
		const { contextWindow, compactAt } = this.#options;
		return new OpenAiCodexSession({
			access: new CodexAccess(this.#options),
			model,
			thinking: start.thinking,
			instructions: systemPrompt(start.cwd, start.systemPromptAppend),
			tools: responsesTools(start),
			executeTool: start.executeTool,
			maxRequests: start.maxRequestsPerTurn ?? this.#options.maxRequestsPerTurn,
			history: savedHistory(start.resume),
			compactionState: start.compactionState,
			compacted: start.compacted,
			summary: start.compaction,
			compaction: (forModel) => {
				const window = contextWindow ?? codexContextWindow(forModel);
				return {
					window,
					compactAt: compactThreshold({ window, outputReserve: OUTPUT_RESERVE, override: compactAt }),
					keepRecent,
				};
			},
		});
	}
}

function responsesTools(start: BackendStartOptions): ResponsesTool[] {
	return toAnthropicTools(start.tools).map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description ?? "",
		parameters: tool.input_schema as Record<string, unknown>,
	}));
}

const ITEM_TYPES: ReadonlySet<string> = new Set(["message", "function_call", "function_call_output", "reasoning"]);

/** The history a saved session resumes with; rejects what is not a Responses conversation. */
function savedHistory(resume: ResumeState | undefined): ResponsesItem[] {
	if (resume === undefined) return [];
	if (!("messages" in resume)) throw new Error("The saved state is not an openai-codex history.");
	const items = structuredClone(resume.messages) as unknown[];
	const readable = items.every((item) => ITEM_TYPES.has((item as { type?: unknown } | null)?.type as string));
	if (!readable) throw new Error("The saved history holds an item that is not a Responses item.");
	return items as ResponsesItem[];
}

/**
 * An output item as the next request takes it: without the ids and statuses of items that were not stored, which
 * the API would look up and not find. Reasoning keeps its id: its encrypted content stands for it.
 */
function forHistory(item: ResponsesItem): ResponsesItem | undefined {
	switch (item.type) {
		case "message": {
			const content = item.content.flatMap((part) =>
				part.type === "output_text" && part.text !== "" ? [{ type: "output_text" as const, text: part.text }] : [],
			);
			return content.length === 0 ? undefined : { type: "message", role: item.role, content };
		}
		case "function_call":
			return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments };
		case "reasoning":
			return {
				type: "reasoning",
				...(item.id === undefined ? {} : { id: item.id }),
				summary: item.summary,
				...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
			};
		default:
			return undefined;
	}
}

function toUsage(usage: ResponsesUsage): Usage {
	return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: 0 };
}

function addUsage(total: Usage, usage: Usage): Usage {
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
	};
}

export interface SessionSetup {
	access: CodexAccess;
	model: string;
	thinking: ThinkingLevel | undefined;
	instructions: string;
	tools: ResponsesTool[];
	executeTool: ToolExecutor;
	/** Undefined: no limit, the turn runs until the model stops, an interrupt or an error. */
	maxRequests: number | undefined;
	history: ResponsesItem[];
	/** The compaction of each model the session runs: the window depends on it. */
	compaction: (model: string) => CompactionConfig;
	compactionState: (() => string | undefined) | undefined;
	compacted: ((summary: string) => void) | undefined;
	/** The model and level of the summary request, when the profile's compaction entry sets them. */
	summary: { model?: string; thinking?: ThinkingLevel } | undefined;
}

/** A request failed after it showed text or thinking: it is not sent again, since the user already saw part of it. */
class AfterOutputError extends Error {
	override name = "AfterOutputError";
	readonly failure: unknown;

	constructor(failure: unknown) {
		super(describeError(failure));
		this.failure = failure;
	}
}

/** What one request gave: its items, why it stopped short, and its usage. */
interface Answer {
	output: ResponsesItem[];
	incomplete: string | undefined;
	usage: Usage;
}

class OpenAiCodexSession implements BackendSession {
	readonly #setup: SessionSetup;
	readonly #access: CodexAccess;
	/** Names the conversation to OpenAI's prompt cache, and to the Codex endpoint. */
	readonly #id = randomUUID();
	#model: string;
	#thinking: ThinkingLevel | undefined;
	#reasoning: CodexReasoning | undefined;
	#history: ResponsesItem[];
	#abort: AbortController | undefined;
	#announced = false;
	#closed = false;
	/** Context size the last response reported, and the history length it covered. */
	#measured = { tokens: 0, length: 0 };
	/** A compaction ran and no response has measured the new history yet. */
	#unmeasured = false;
	#files: FileActivity = { read: [], edited: [] };
	#summary: SessionSetup["summary"];
	#compaction: CompactionConfig;
	/** Index of the user message that started the current turn; -1 between turns or once a summary holds it. */
	#turnStart = -1;
	/** The current turn's request, verbatim, once a summary had to carry it. */
	#turnPrompt: string | undefined;

	constructor(setup: SessionSetup) {
		this.#setup = setup;
		this.#access = setup.access;
		this.#model = setup.model;
		this.#thinking = setup.thinking;
		this.#reasoning = codexReasoning(setup.model, setup.thinking);
		this.#compaction = setup.compaction(setup.model);
		this.#history = setup.history;
		this.#summary = setup.summary;
	}

	currentModel(): string {
		return this.#model;
	}

	resumeState(): ResumeState | undefined {
		return this.#history.length === 0 ? undefined : { messages: this.#history as unknown as JsonValue[] };
	}

	/** The level as the start or the last `configure` left it: what `session_started` says about the effort. */
	effortReport(): CodexReasoning["report"] | undefined {
		return this.#reasoning?.report;
	}

	async configure(change: SessionChange): Promise<void> {
		this.#model = change.model ?? this.#model;
		this.#thinking = change.thinking ?? this.#thinking;
		this.#reasoning = codexReasoning(this.#model, this.#thinking);
		this.#compaction = this.#setup.compaction(this.#model);
		if (change.compaction !== undefined) this.#summary = change.compaction ?? undefined;
	}

	async *send(prompt: string): AsyncIterable<AtelierEventBody> {
		if (this.#closed) throw new Error("The openai-codex session is closed.");
		if (!this.#announced) {
			this.#announced = true;
			yield {
				type: "session_started",
				backend: BACKEND_ID,
				model: this.#model,
				authSource: "subscription",
				...(this.#reasoning === undefined ? {} : { effort: this.#reasoning.report }),
			};
		}
		const abort = new AbortController();
		this.#abort = abort;
		let usage: Usage = { ...ZERO_USAGE };
		let requests = 0;
		let stopReason = "error";
		this.#history.push({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
		this.#turnStart = this.#history.length - 1;
		this.#turnPrompt = undefined;
		const meter = { usage: { ...ZERO_USAGE }, requests: 0 };
		// A compaction that fails is not tried again in the same turn; an overflow gets one compaction.
		let thresholdFailed = false;
		let overflowTried = false;
		try {
			for (;;) {
				if (this.#setup.maxRequests !== undefined && requests >= this.#setup.maxRequests) {
					yield errorEvent(
						"turn_limit",
						`The turn reached its limit of ${this.#setup.maxRequests} model requests.`,
						true,
					);
					stopReason = "turn_limit";
					break;
				}
				if (!thresholdFailed && !this.#unmeasured && this.#contextTokens() > this.#compaction.compactAt) {
					thresholdFailed = !(yield* this.#compact("threshold", abort.signal, meter));
					if (abort.signal.aborted) {
						stopReason = "interrupted";
						break;
					}
				}
				let answer: Answer;
				try {
					answer = yield* this.#request(this.#body(), abort.signal, true);
					requests++;
				} catch (error) {
					if (abort.signal.aborted) throw error;
					// What the user already saw cannot be taken back: the request is not sent again, and the next turn
					// starts from the history as it was.
					if (error instanceof AfterOutputError) {
						const event = this.#error(error.failure);
						yield event.type === "error" ? { ...event, recoverable: true } : event;
						break;
					}
					if ((error as Partial<ResponsesError>).kind === "overflow" && !overflowTried) {
						overflowTried = true;
						const compacted = yield* this.#compact("overflow", abort.signal, meter);
						if (abort.signal.aborted) {
							stopReason = "interrupted";
							break;
						}
						if (compacted) continue;
					}
					throw error;
				}
				usage = addUsage(usage, answer.usage);
				const kept = answer.output.flatMap((item) => forHistory(item) ?? []);
				this.#history.push(...kept);
				this.#measured = {
					tokens: answer.usage.input + answer.usage.cacheRead + answer.usage.output,
					length: this.#history.length,
				};
				this.#unmeasured = false;
				const calls = kept.filter((item) => item.type === "function_call");
				if (calls.length === 0) {
					const incomplete = answer.incomplete;
					stopReason =
						incomplete === undefined ? "end_turn" : incomplete === "max_output_tokens" ? "max_tokens" : incomplete;
					break;
				}
				await this.#runTools(calls, abort.signal);
				if (abort.signal.aborted) {
					stopReason = "interrupted";
					break;
				}
			}
		} catch (error) {
			if (abort.signal.aborted) stopReason = "interrupted";
			else yield this.#error(error);
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
			// Between turns there is no request for a summary to carry.
			this.#turnStart = -1;
			this.#turnPrompt = undefined;
		}
		usage = addUsage(usage, meter.usage);
		requests += meter.requests;
		yield { type: "turn_finished", stopReason, usage, requests, context: this.#context() };
	}

	/** A request over `input` (the history by default) with the session's model and reasoning, or the summary's. */
	#body(options: { input?: ResponsesItem[]; summary?: boolean } = {}): Record<string, unknown> {
		const model = options.summary ? (this.#summary?.model ?? this.#model) : this.#model;
		const reasoning = options.summary
			? codexReasoning(model, this.#summary?.thinking ?? this.#thinking)
			: this.#reasoning;
		const effort = reasoning?.effort;
		return buildResponsesBody({
			model,
			instructions: this.#setup.instructions,
			input:
				imageInputProblem(BACKEND_ID, model) === undefined
					? (options.input ?? this.#history)
					: (options.input ?? this.#history).map((item) =>
							item.type !== "message"
								? item
								: {
										...item,
										content: item.content.map((part) =>
											part.type === "input_image" ? { type: "input_text" as const, text: imageOmission(model) } : part,
										),
									},
						),
			tools: this.#setup.tools,
			...(options.summary ? { toolChoice: "none" as const } : {}),
			// Always asked, so each response's reasoning comes back encrypted and the next request can carry it.
			reasoning: { ...(effort === undefined ? {} : { effort }), summary: "auto" },
			promptCacheKey: this.#id,
		});
	}

	/**
	 * Sends one request as `#ask` does, and once more after refreshing a token OpenAI refused, or with Sign in with
	 * ChatGPT when the Codex endpoint refused Atelier. A request that already showed something is never sent again.
	 */
	async *#request(
		body: Record<string, unknown>,
		signal: AbortSignal | undefined,
		show: boolean,
	): AsyncGenerator<AtelierEventBody, Answer> {
		let renewed = false;
		for (;;) {
			try {
				return yield* this.#ask(body, signal, show);
			} catch (error) {
				if (signal?.aborted || error instanceof AfterOutputError) throw error;
				const kind = (error as Partial<ResponsesError>).kind;
				if (kind === "auth" && !renewed) {
					renewed = true;
					await this.#access.renew();
					continue;
				}
				if (kind === "refused" && this.#access.fallBack()) {
					yield errorEvent(
						"variant_changed",
						`ChatGPT's Codex endpoint refused Atelier (${this.#redact(describeError(error))}); this session continues with Sign in with ChatGPT.`,
						true,
					);
					continue;
				}
				throw error;
			}
		}
	}

	/**
	 * Sends one request; with `show`, its text and reasoning are yielded as they come. A failure after any of them was
	 * yielded is an `AfterOutputError`.
	 */
	async *#ask(
		body: Record<string, unknown>,
		signal: AbortSignal | undefined,
		show: boolean,
	): AsyncGenerator<AtelierEventBody, Answer> {
		let answer: Answer | undefined;
		let shown = false;
		try {
			for await (const event of streamResponse(this.#access.endpoint(this.#id), body, signal)) {
				if (event.type === "text_delta" && show) {
					shown = true;
					yield { type: "text_delta", text: event.text };
				} else if (event.type === "reasoning_delta" && show) {
					shown = true;
					yield { type: "thinking_delta", text: event.text };
				} else if (event.type === "done")
					answer = {
						output: event.output,
						incomplete: event.status === "incomplete" ? (event.incompleteReason ?? "incomplete") : undefined,
						usage: toUsage(event.usage),
					};
			}
		} catch (error) {
			throw shown && !signal?.aborted ? new AfterOutputError(error) : error;
		}
		if (answer === undefined) throw new Error("The response ended without an answer.");
		return answer;
	}

	/** The summary's text, or why it cannot replace the history. */
	#checkSummary(answer: Answer): { ok: true; text: string } | { ok: false; reason: string } {
		if (answer.incomplete !== undefined) return { ok: false, reason: `The summary stopped with ${answer.incomplete}.` };
		return checkSummaryText(outputText(answer.output));
	}

	#context(): ContextUsage {
		const { window, compactAt } = this.#compaction;
		// Until an answer measures the compacted history, its size is only an estimate.
		return {
			tokens: this.#contextTokens(),
			window,
			compactAt,
			...(this.#unmeasured ? { unknown: true as const } : {}),
		};
	}

	/** The last measured size plus an estimate of what was appended since. */
	#contextTokens(): number {
		return this.#history
			.slice(this.#measured.length)
			.reduce((sum, item) => sum + estimateItem(item), this.#measured.tokens);
	}

	/** Replaces the history before a cut with its summary; resolves to whether it did. A failure leaves it as it was. */
	async *#compact(
		reason: CompactionReason,
		signal: AbortSignal,
		meter: { usage: Usage; requests: number },
		instructions?: string,
	): AsyncGenerator<AtelierEventBody, boolean> {
		const tokensBefore = this.#contextTokens();
		yield { type: "compaction_started", reason, tokens: tokensBefore };
		const failed = (error: string, usage: Usage = { ...ZERO_USAGE }): AtelierEventBody => ({
			type: "compaction_finished",
			ok: false,
			reason,
			tokensBefore,
			kept: 0,
			usage,
			error,
		});
		const items = this.#history;
		const cut = findItemCut(items, this.#compaction.keepRecent);
		if (cut === undefined) {
			yield failed("There is not enough history to compact.");
			return false;
		}
		let answer: Answer;
		try {
			const input = withInstruction(items.slice(0, cut), summaryInstruction(instructions));
			answer = yield* this.#request(this.#body({ input, summary: true }), signal, false);
		} catch (error) {
			yield failed(signal.aborted ? "Interrupted by the user." : this.#redact(describeError(error)));
			return false;
		}
		meter.usage = addUsage(meter.usage, answer.usage);
		meter.requests++;
		const summary = this.#checkSummary(answer);
		if (!summary.ok) {
			yield failed(summary.reason, answer.usage);
			return false;
		}
		const carried = this.#turnStart < 0 ? this.#turnPrompt : turnPromptBeforeItem(items, this.#turnStart, cut);
		const files = itemFileActivity(items.slice(0, cut), this.#files);
		const next = replaceItems(items, cut, {
			summary: summary.text,
			files,
			turnPrompt: carried,
			state: this.#setup.compactionState?.(),
		});
		const removed = items.slice(0, cut).reduce((sum, item) => sum + estimateItem(item), 0);
		const tokensAfter = Math.max(0, tokensBefore - removed + estimateItem(next[0] as ResponsesItem));
		this.#history = next;
		this.#files = files;
		this.#measured = { tokens: tokensAfter, length: next.length };
		this.#unmeasured = true;
		if (this.#turnStart >= cut) this.#turnStart -= cut - 1;
		else {
			this.#turnStart = -1;
			this.#turnPrompt = carried;
		}
		this.#setup.compacted?.(summary.text);
		yield {
			type: "compaction_finished",
			ok: true,
			reason,
			tokensBefore,
			tokensAfter,
			kept: next.length - 1,
			usage: answer.usage,
		};
		return true;
	}

	async *compact(instructions?: string): AsyncIterable<AtelierEventBody> {
		if (this.#closed) throw new Error("The openai-codex session is closed.");
		const abort = new AbortController();
		this.#abort = abort;
		const meter = { usage: { ...ZERO_USAGE }, requests: 0 };
		let ok = false;
		try {
			ok = yield* this.#compact("manual", abort.signal, meter, instructions);
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
		yield {
			type: "turn_finished",
			stopReason: abort.signal.aborted ? "interrupted" : ok ? "end_turn" : "error",
			usage: meter.usage,
			requests: meter.requests,
			context: this.#context(),
		};
	}

	/** One summary request over the whole history, for a session that leaves this backend; the history stays as it is. */
	async summarize(): Promise<BackendSummary> {
		if (this.#closed) throw new Error("The openai-codex session is closed.");
		if (this.#history.length === 0) throw new Error("There is no conversation to summarize.");
		const input = withInstruction(this.#history, SUMMARY_INSTRUCTION);
		let answer: Answer;
		try {
			const asking = this.#request(this.#body({ input, summary: true }), undefined, false);
			for (;;) {
				const next = await asking.next();
				if (next.done) {
					answer = next.value;
					break;
				}
			}
		} catch (error) {
			throw new Error(this.#redact(describeError(error)));
		}
		const summary = this.#checkSummary(answer);
		if (!summary.ok) throw new Error(summary.reason);
		return {
			text: `${summary.text}\n\n${filesSection(itemFileActivity(this.#history, this.#files))}`,
			usage: answer.usage,
			requests: 1,
		};
	}

	/** Runs the calls in order; once interrupted, the rest get an error output so every call keeps its answer. */
	async #runTools(calls: (ResponsesItem & { type: "function_call" })[], signal: AbortSignal): Promise<void> {
		const steering: string[] = [];
		const images: (InputText | InputImage)[] = [];
		for (const call of calls) {
			if (signal.aborted) {
				this.#history.push({ type: "function_call_output", call_id: call.call_id, output: INTERRUPTED_TOOL });
				continue;
			}
			let input: JsonValue;
			try {
				input = JSON.parse(call.arguments === "" ? "{}" : call.arguments) as JsonValue;
			} catch {
				this.#history.push({
					type: "function_call_output",
					call_id: call.call_id,
					output: `The arguments are not valid JSON: ${call.arguments.slice(0, 200)}`,
				});
				continue;
			}
			const result = await this.#setup.executeTool({ tool: call.name, input, callId: call.call_id }, signal);
			this.#history.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: result.ok ? result.output : `Error: ${result.output}`,
			});
			if (result.images?.length)
				images.push(
					{ type: "input_text", text: `Images from tool result ${call.call_id}:` },
					...result.images.map(
						(image): InputImage => ({
							type: "input_image",
							image_url: `data:${image.mimeType};base64,${image.data}`,
							detail: "auto",
						}),
					),
				);
			if (result.steering !== undefined) steering.push(result.steering);
		}
		if (images.length > 0) this.#history.push({ type: "message", role: "user", content: images });
		if (steering.length > 0)
			this.#history.push({
				type: "message",
				role: "user",
				content: steering.map((text) => ({ type: "input_text", text })),
			});
	}

	#redact(message: string): string {
		return this.#access.secrets().reduce((text, secret) => text.replaceAll(secret, "[redacted]"), message);
	}

	#error(error: unknown): AtelierEventBody {
		const message = this.#redact(describeError(error));
		if (error instanceof NotSignedInError) return errorEvent("not_logged_in", message, false);
		switch ((error as Partial<ResponsesError>).kind) {
			case "auth":
				return errorEvent("authentication_error", message, false);
			case "usage_limit":
				return errorEvent("usage_limit", message, false);
			case "rate_limit":
				return errorEvent("rate_limited", message, true);
			case "server":
			case "network":
				return errorEvent("api_error", message, true);
			case "overflow":
				return errorEvent("context_overflow", message, false);
			default:
				return errorEvent("api_error", message, false);
		}
	}

	async interrupt(): Promise<void> {
		this.#abort?.abort();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#abort?.abort();
	}
}
