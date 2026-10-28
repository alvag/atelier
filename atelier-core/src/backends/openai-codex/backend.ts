import { randomUUID } from "node:crypto";
import type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	ResumeState,
	SessionChange,
	ToolExecutor,
} from "../../backend.ts";
import { compactThreshold, KEEP_RECENT_TOKENS } from "../../compaction/compactor.ts";
import {
	type AtelierEventBody,
	type ContextUsage,
	describeError,
	errorEvent,
	type JsonValue,
	type Usage,
	ZERO_USAGE,
} from "../../events.ts";
import type { ThinkingLevel } from "../../profiles/index.ts";
import {
	buildResponsesBody,
	type ResponsesError,
	type ResponsesItem,
	type ResponsesTool,
	type ResponsesUsage,
	streamResponse,
} from "../../responses/client.ts";
import { systemPrompt } from "../anthropic-api/system-prompt.ts";
import { toAnthropicTools } from "../anthropic-api/tool-schema.ts";
import { CodexAccess, type CodexAccessOptions, NotSignedInError } from "./access.ts";
import { CODEX_CONTEXT_WINDOW, type CodexReasoning, codexReasoning, DEFAULT_CODEX_MODEL } from "./models.ts";

export const BACKEND_ID = "openai-codex";
export const DEFAULT_MAX_REQUESTS_PER_TURN = 50;
/** No output cap is sent; this is the room kept for the answer when deciding when to compact. */
const OUTPUT_RESERVE = 32_000;
const INTERRUPTED_TOOL = "Interrupted by the user.";

export interface OpenAiCodexBackendOptions extends CodexAccessOptions {
	model?: string;
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
		const window = this.#options.contextWindow ?? CODEX_CONTEXT_WINDOW;
		return new OpenAiCodexSession({
			access: new CodexAccess(this.#options),
			model: start.model ?? this.#options.model ?? DEFAULT_CODEX_MODEL,
			thinking: start.thinking,
			instructions: systemPrompt(start.cwd, start.systemPromptAppend),
			tools: responsesTools(start),
			executeTool: start.executeTool,
			maxRequests: start.maxRequestsPerTurn ?? this.#options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN,
			history: savedHistory(start.resume),
			compaction: {
				window,
				compactAt: compactThreshold({ window, maxTokens: OUTPUT_RESERVE, override: this.#options.compactAt }),
				keepRecent: this.#options.keepRecentTokens ?? KEEP_RECENT_TOKENS,
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
			const content = item.content
				.filter((part) => part.type === "output_text" && part.text !== "")
				.map((part) => ({ type: "output_text" as const, text: part.text }));
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
	maxRequests: number;
	history: ResponsesItem[];
	compaction: CompactionConfig;
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
	/** Context size the last response reported. */
	#tokens = 0;

	constructor(setup: SessionSetup) {
		this.#setup = setup;
		this.#access = setup.access;
		this.#model = setup.model;
		this.#thinking = setup.thinking;
		this.#reasoning = codexReasoning(setup.model, setup.thinking);
		this.#history = setup.history;
	}

	resumeState(): ResumeState | undefined {
		return this.#history.length === 0 ? undefined : { messages: this.#history as unknown as JsonValue[] };
	}

	async configure(change: SessionChange): Promise<void> {
		this.#model = change.model ?? this.#model;
		this.#thinking = change.thinking ?? this.#thinking;
		this.#reasoning = codexReasoning(this.#model, this.#thinking);
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
		let renewed = false;
		try {
			for (;;) {
				if (requests >= this.#setup.maxRequests) {
					yield errorEvent(
						"turn_limit",
						`The turn reached its limit of ${this.#setup.maxRequests} model requests.`,
						true,
					);
					stopReason = "turn_limit";
					break;
				}
				let output: ResponsesItem[];
				let incomplete: string | undefined;
				try {
					const endpoint = this.#access.endpoint(this.#id);
					output = [];
					for await (const event of streamResponse(endpoint, this.#body(), abort.signal)) {
						if (event.type === "text_delta") yield { type: "text_delta", text: event.text };
						else if (event.type === "reasoning_delta") yield { type: "thinking_delta", text: event.text };
						else {
							output = event.output;
							incomplete = event.status === "incomplete" ? (event.incompleteReason ?? "incomplete") : undefined;
							const used = toUsage(event.usage);
							usage = addUsage(usage, used);
							this.#tokens = used.input + used.cacheRead + used.output;
						}
					}
					requests++;
				} catch (error) {
					if (abort.signal.aborted) throw error;
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
				renewed = false;
				const kept = output.flatMap((item) => forHistory(item) ?? []);
				this.#history.push(...kept);
				const calls = kept.filter((item) => item.type === "function_call");
				if (calls.length === 0) {
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
		}
		yield { type: "turn_finished", stopReason, usage, requests, context: this.#context() };
	}

	#body(): Record<string, unknown> {
		const effort = this.#reasoning?.effort;
		return buildResponsesBody({
			model: this.#model,
			instructions: this.#setup.instructions,
			input: this.#history,
			tools: this.#setup.tools,
			// Always asked, so each response's reasoning comes back encrypted and the next request can carry it.
			reasoning: { ...(effort === undefined ? {} : { effort }), summary: "auto" },
			promptCacheKey: this.#id,
		});
	}

	#context(): ContextUsage {
		const { window, compactAt } = this.#setup.compaction;
		return { tokens: this.#tokens, window, compactAt };
	}

	/** Runs the calls in order; once interrupted, the rest get an error output so every call keeps its answer. */
	async #runTools(calls: (ResponsesItem & { type: "function_call" })[], signal: AbortSignal): Promise<void> {
		const steering: string[] = [];
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
			if (result.steering !== undefined) steering.push(result.steering);
		}
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

	effectiveEffort(): undefined {
		return undefined;
	}

	async interrupt(): Promise<void> {
		this.#abort?.abort();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#abort?.abort();
	}
}
