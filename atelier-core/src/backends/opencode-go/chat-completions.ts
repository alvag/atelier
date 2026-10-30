import type Anthropic from "@anthropic-ai/sdk";
import { type AtelierEventBody, errorEvent } from "../../events.ts";
import { imageCompatibleRequest } from "../anthropic-api/image-history.ts";
import type { ModelDelta, ModelTransport } from "../anthropic-api/transport.ts";
import { openCodeGoModel } from "./models.ts";

/** A Chat Completions answer that was not a stream: its HTTP status and what the provider said. */
export class ChatCompletionsError extends Error {
	override name = "ChatCompletionsError";
	readonly status: number | undefined;

	constructor(status: number | undefined, message: string) {
		super(status === undefined ? message : `${status} ${message}`);
		this.status = status;
	}
}

export interface ChatCompletionsOptions {
	apiKey: string;
	/** Requests go to `<baseUrl>/v1/chat/completions`. */
	baseUrl: string;
	/** Sent with every request: the conversation's id and Atelier as the client. */
	headers: Record<string, string>;
	fetch?: typeof globalThis.fetch;
	/** Retries of a request refused for load (429 but the usage limit, 5xx) or lost before it answered; 2 by default. */
	maxRetries?: number;
}

const RETRY_BASE_MS = 500;

/** What OpenCode says when the plan's usage, not the request rate, is spent: its 5-hour, weekly or monthly limit. */
export const USAGE_LIMIT =
	/usage limit|quota|allowance|balance|credits|monthly|weekly|\b(?:5|five)[\s-]?h(?:ours?|r)?\b|hourly limit/i;

/** Whether trying again later may work: load and lost connections, never a spent plan or a refused request. */
function worthRetrying(error: unknown): boolean {
	if (!(error instanceof ChatCompletionsError)) return true;
	if (error.status === 429) return !USAGE_LIMIT.test(error.message);
	return error.status !== undefined && error.status >= 500;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

type ChatContent = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type ChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | ChatContent[] }
	| { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string }
	| { role: "tool"; tool_call_id: string; content: string };

interface ChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

const textOf = (content: string | readonly { type: string; text?: string }[]): string =>
	typeof content === "string"
		? content
		: content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");

/** A user message: its tool results, each as a `tool` message, and its text as a `user` message, in order. */
function userMessages(message: Anthropic.MessageParam, model: string): ChatMessage[] {
	if (typeof message.content === "string") return [{ role: "user", content: message.content }];
	const out: ChatMessage[] = [];
	let content: ChatContent[] = [];
	const images: ChatContent[] = [];
	const flush = () => {
		if (content.length > 0)
			out.push({
				role: "user",
				content: content.some((part) => part.type === "image_url") ? content : textOf(content),
			});
		content = [];
	};
	const imagePart = (block: Anthropic.ImageBlockParam): ChatContent => {
		const source = block.source;
		if (source.type === "file")
			return {
				type: "text",
				text: `[image omitted: ${model} cannot receive this image source through Chat Completions]`,
			};
		return {
			type: "image_url",
			image_url: { url: source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url },
		};
	};
	for (const block of message.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		else if (block.type === "image") content.push(imagePart(block));
		else if (block.type === "tool_result") {
			flush();
			const output = block.content === undefined ? "" : textOf(block.content);
			if (Array.isArray(block.content)) {
				const pictures = block.content.filter((part) => part.type === "image").map(imagePart);
				if (pictures.length > 0)
					images.push({ type: "text", text: `Images from tool result ${block.tool_use_id}:` }, ...pictures);
			}
			// Chat Completions has no error flag: the model reads it in the text.
			out.push({
				role: "tool",
				tool_call_id: block.tool_use_id,
				content: block.is_error ? `Error: ${output}` : output,
			});
		}
	}
	// A user image between tool replies would leave the assistant's other calls unanswered.
	content = [...images, ...content];
	flush();
	return out;
}

function assistantMessage(message: Anthropic.MessageParam, replaysReasoning: boolean): ChatMessage {
	const always = replaysReasoning ? { reasoning_content: "" } : {};
	if (typeof message.content === "string") return { role: "assistant", content: message.content, ...always };
	const text: string[] = [];
	const reasoning: string[] = [];
	const calls: ChatToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "text") text.push(block.text);
		else if (block.type === "thinking") reasoning.push(block.thinking);
		else if (block.type === "tool_use")
			calls.push({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
			});
	}
	return {
		role: "assistant",
		content: text.length === 0 ? null : text.join(""),
		...(calls.length === 0 ? {} : { tool_calls: calls }),
		...(reasoning.length === 0 ? always : { reasoning_content: reasoning.join("\n") }),
	};
}

/** The Messages API request the session built, as a Chat Completions request. */
export function toChatRequest(params: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> {
	params = imageCompatibleRequest(params, "opencode-go");
	const model = openCodeGoModel(params.model);
	const system = params.system === undefined ? "" : textOf(params.system);
	const messages: ChatMessage[] = [
		...(system === "" ? [] : [{ role: "system" as const, content: system }]),
		...params.messages.flatMap((message) =>
			message.role === "user"
				? userMessages(message, params.model)
				: [assistantMessage(message, model.replaysReasoning === true)],
		),
	];
	const tools = (params.tools ?? []).flatMap((tool) =>
		"input_schema" in tool
			? [
					{
						type: "function",
						function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema },
					},
				]
			: [],
	);
	const effort = params.output_config?.effort;
	const off = params.thinking?.type === "disabled" ? model.off : undefined;
	return {
		model: params.model,
		messages,
		...(tools.length === 0 ? {} : { tools }),
		// A summary keeps the tools for the cached prefix but must not call them.
		...(params.tool_choice?.type === "none" ? { tool_choice: "none" } : {}),
		max_tokens: params.max_tokens,
		...(effort === undefined || effort === null ? {} : { reasoning_effort: effort }),
		...(off === undefined ? {} : { reasoning_effort: off }),
		stream: true,
		stream_options: { include_usage: true },
	};
}

interface ChatChunk {
	id?: string;
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
		};
		finish_reason?: string | null;
	}[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	};
	error?: { message?: string };
}

/** A connection lost in the middle of the answer, with what it said (undici's "terminated", say) at the end. */
function cutStream(error: unknown): unknown {
	if (error instanceof Error && error.name === "AbortError") return error;
	const said = error instanceof Error ? error.message : String(error);
	return new ChatCompletionsError(
		undefined,
		`The Chat Completions stream was cut before the answer was complete (${said}).`,
	);
}

/**
 * The body's bytes: the first read, already made, then the rest; a read that fails later is a stream cut. However the
 * reading stops (`[DONE]`, an error, an abort, a reader that leaves early), the body is cancelled, so the connection
 * is not left held.
 */
async function* bytesFrom(
	first: ReadableStreamReadResult<Uint8Array>,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
	const read = () => reader.read().catch((error: unknown) => Promise.reject(cutStream(error)));
	try {
		for (let next = first; !next.done; next = await read()) yield next.value;
	} finally {
		// Settles at once on a body already ended or errored; a failure here changes nothing.
		await reader.cancel().catch(() => {});
	}
}

/** The `[DONE]` line that closes a stream. */
const DONE = Symbol("done");

/** The JSON of each `data:` line of an event stream, then `DONE` when the stream says it ended. */
async function* events(body: AsyncIterable<Uint8Array>): AsyncGenerator<ChatChunk | typeof DONE> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const bytes of body) {
		buffer += decoder.decode(bytes, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "[DONE]") {
				yield DONE;
				return;
			}
			if (data !== "") yield JSON.parse(data) as ChatChunk;
		}
	}
}

/** Tokens as the session counts them: the prompt's cached reads and writes apart from the rest of it. */
function toUsage(usage: ChatChunk["usage"]): Anthropic.Usage {
	const prompt = usage?.prompt_tokens ?? 0;
	const cacheRead =
		usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.cached_tokens ?? 0;
	const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
	return {
		input_tokens: Math.max(0, prompt - cacheRead - cacheWrite),
		output_tokens: usage?.completion_tokens ?? 0,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
	} as Anthropic.Usage;
}

/** Arguments that are not a JSON object reach the tool as none, and the tool says what is missing. */
function parseArguments(raw: string): unknown {
	try {
		const parsed: unknown = JSON.parse(raw === "" ? "{}" : raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function failure(response: Response): Promise<ChatCompletionsError> {
	const text = await response.text().catch(() => "");
	let message = text || response.statusText;
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
		message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message ?? message;
	} catch {
		// Not JSON: the text as it came.
	}
	return new ChatCompletionsError(response.status, message);
}

/**
 * Chat Completions at OpenCode Go, behind the session's Messages API requests: the history goes over as chat
 * messages, and the streamed answer comes back as one Messages API message, its reasoning as a thinking block with
 * no signature.
 */
export function chatCompletionsTransport(options: ChatCompletionsOptions): ModelTransport {
	const fetchFn = options.fetch ?? globalThis.fetch;
	const maxRetries = options.maxRetries ?? 2;
	const post = async (body: string, signal: AbortSignal | undefined): Promise<AsyncIterable<Uint8Array>> => {
		const response = await fetchFn(`${options.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				...options.headers,
				authorization: `Bearer ${options.apiKey}`,
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body,
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok || response.body === null) throw await failure(response);
		// The first read belongs to the attempt: a connection lost before the body's first byte is tried again.
		const reader = response.body.getReader();
		const first = await reader.read();
		return bytesFrom(first, reader);
	};
	/** Only until the answer's first byte: a stream cut later is not sent again, since its deltas were already shown. */
	const connect = async (body: string, signal: AbortSignal | undefined): Promise<AsyncIterable<Uint8Array>> => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await post(body, signal);
			} catch (error) {
				if (signal?.aborted || attempt >= maxRetries || !worthRetrying(error)) throw error;
			}
			await pause(RETRY_BASE_MS * 2 ** attempt, signal);
		}
	};
	return {
		async *request(params, signal): AsyncGenerator<ModelDelta, Anthropic.Message> {
			const body = await connect(JSON.stringify(toChatRequest(params)), signal);
			let id = "chatcmpl";
			let text = "";
			let reasoning = "";
			let finish: string | null | undefined;
			let usage: ChatChunk["usage"];
			const calls: { id: string; name: string; arguments: string }[] = [];
			let done = false;
			for await (const chunk of events(body)) {
				if (chunk === DONE) {
					done = true;
					break;
				}
				if (chunk.error) throw new ChatCompletionsError(undefined, chunk.error.message ?? "stream error");
				id = chunk.id ?? id;
				usage = chunk.usage ?? usage;
				const choice = chunk.choices?.[0];
				if (choice === undefined) continue;
				finish = choice.finish_reason ?? finish;
				const delta = choice.delta ?? {};
				const thought = delta.reasoning_content ?? delta.reasoning;
				if (thought) {
					reasoning += thought;
					yield { type: "thinking_delta", text: thought };
				}
				if (delta.content) {
					text += delta.content;
					yield { type: "text_delta", text: delta.content };
				}
				for (const call of delta.tool_calls ?? []) {
					calls[call.index] ??= { id: "", name: "", arguments: "" };
					const slot = calls[call.index] as { id: string; name: string; arguments: string };
					if (call.id) slot.id = call.id;
					if (call.function?.name) slot.name += call.function.name;
					slot.arguments += call.function?.arguments ?? "";
				}
			}
			// A body that just stops was cut: its text and tool calls may be halves, so nothing of it is kept or run.
			if (!done && (finish === undefined || finish === null))
				throw new ChatCompletionsError(undefined, "The Chat Completions stream ended before the answer was complete.");
			const toolUses = calls.flatMap((call, index) =>
				call === undefined
					? []
					: [
							{
								type: "tool_use",
								id: call.id || `call_${index}`,
								name: call.name,
								input: parseArguments(call.arguments),
							},
						],
			);
			const content = [
				...(reasoning === "" ? [] : [{ type: "thinking", thinking: reasoning, signature: "" }]),
				...(text === "" ? [] : [{ type: "text", text }]),
				...toolUses,
			];
			const stopReason = toolUses.length > 0 ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
			return {
				id,
				type: "message",
				role: "assistant",
				model: params.model,
				content,
				stop_reason: stopReason,
				stop_sequence: null,
				usage: toUsage(usage),
			} as unknown as Anthropic.Message;
		},
		contextWindow: async (model) => openCodeGoModel(model).contextWindow,
		isOverflow: (error) =>
			error instanceof ChatCompletionsError &&
			(error.status === 413 ||
				(error.status === 400 &&
					/context length|context window|too long|maximum context|token limit/i.test(error.message))),
		errorEvent: chatErrorEvent,
	};
}

function chatErrorEvent(error: unknown, message: string): AtelierEventBody {
	if (!(error instanceof ChatCompletionsError)) return errorEvent("api_error", message, true);
	if (error.status === 401 || error.status === 403) return errorEvent("authentication_error", message, false);
	if (error.status === 429) return errorEvent("rate_limited", message, true);
	if (error.status === 400) return errorEvent("invalid_request", message, false);
	return errorEvent("api_error", message, error.status === undefined || error.status >= 500);
}
