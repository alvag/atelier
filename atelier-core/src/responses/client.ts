import { setTimeout as sleep } from "node:timers/promises";

/**
 * A client of OpenAI's Responses API (`POST /responses`, streamed as server-sent events), shared by every backend that
 * speaks it: it knows the API, not who signs the requests. The endpoint gives the URL and the headers.
 */

export interface InputText {
	type: "input_text";
	text: string;
}

export interface InputImage {
	type: "input_image";
	image_url: string;
	detail: "auto" | "low" | "high";
}

export interface OutputText {
	type: "output_text";
	text: string;
	annotations?: unknown[];
}

/** An item of the conversation, as the API takes it in `input` and returns it in `output`. */
export type ResponsesItem =
	| {
			type: "message";
			role: "user" | "assistant" | "developer";
			content: (InputText | OutputText | InputImage)[];
			id?: string;
	  }
	| { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
	| { type: "function_call_output"; call_id: string; output: string }
	| {
			type: "reasoning";
			id?: string;
			summary: { type: "summary_text"; text: string }[];
			encrypted_content?: string | null;
	  };

export interface ResponsesTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ResponsesRequest {
	model: string;
	instructions: string;
	input: ResponsesItem[];
	tools?: ResponsesTool[];
	/** Sent only when given; the encrypted reasoning comes back with it, to send again with the history. */
	reasoning?: { effort?: string; summary?: "auto" | "concise" | "detailed" };
	promptCacheKey?: string;
	/** `none` keeps the tools in the request (and the cached prefix) but lets the model call none. */
	toolChoice?: "auto" | "none";
	/** Fields an endpoint adds to every request. */
	extra?: Record<string, unknown>;
}

export function buildResponsesBody(request: ResponsesRequest): Record<string, unknown> {
	return {
		model: request.model,
		instructions: request.instructions,
		input: request.input,
		...(request.tools?.length ? { tools: request.tools.map((tool) => ({ ...tool, strict: false })) } : {}),
		tool_choice: request.toolChoice ?? "auto",
		parallel_tool_calls: true,
		...(request.reasoning ? { reasoning: request.reasoning, include: ["reasoning.encrypted_content"] } : {}),
		...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
		// The history is the client's own: nothing is kept on OpenAI's side between requests.
		store: false,
		stream: true,
		...request.extra,
	};
}

export interface ResponsesEndpoint {
	url: string;
	/** Asked before each attempt, so a token refreshed meanwhile is the one sent. */
	headers: () => Promise<Record<string, string>>;
	fetch?: typeof globalThis.fetch;
	/** Attempts after the first for a busy or failing server (default 3). */
	maxRetries?: number;
	/** The first retry's wait, doubled on each one; tests set 0. */
	baseDelayMs?: number;
}

/** What a request's tokens were: `input` without the part read from the cache. */
export interface ResponsesUsage {
	input: number;
	cacheRead: number;
	output: number;
	reasoning: number;
}

export type ResponsesEvent =
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| {
			type: "done";
			status: "completed" | "incomplete";
			incompleteReason?: string;
			output: ResponsesItem[];
			usage: ResponsesUsage;
	  };

/**
 * Why a request failed: `auth` (the token was refused), `refused` (the endpoint refuses this client: 403, 404),
 * `usage_limit` (the subscription's limit, which waiting does not lift soon), `rate_limit`, `overflow` (the context is
 * too long), `server`, `network` or `other`.
 */
export type ResponsesErrorKind =
	| "auth"
	| "refused"
	| "usage_limit"
	| "rate_limit"
	| "overflow"
	| "server"
	| "network"
	| "other";

export class ResponsesError extends Error {
	override name = "ResponsesError";
	readonly kind: ResponsesErrorKind;
	readonly status: number | undefined;
	readonly errorCode: string | undefined;

	constructor(kind: ResponsesErrorKind, message: string, status?: number, errorCode?: string) {
		super(message);
		this.kind = kind;
		this.status = status;
		this.errorCode = errorCode;
	}
}

const USAGE_LIMIT =
	/usage_limit_reached|usage_not_included|insufficient_quota|subscription_sharing_\w*usage_limit\w*|quota exceeded/i;
const OVERFLOW = /context_length_exceeded|context window|maximum context length|prompt is too long/i;

interface ApiError {
	code?: string;
	message?: string;
	plan_type?: string;
	resets_at?: number;
}

function apiErrorOf(json: unknown): ApiError {
	const error = (json as { error?: unknown } | null)?.error ?? json;
	return typeof error === "object" && error !== null ? (error as ApiError) : {};
}

function usageLimitMessage(error: ApiError): string {
	const plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
	const minutes =
		typeof error.resets_at === "number"
			? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60_000))
			: undefined;
	const when = minutes === undefined ? "" : ` It resets in about ${minutes} min.`;
	return `You have hit your ChatGPT usage limit${plan}.${when}`;
}

/** The error a failed status or a failed event stands for. */
export function classifyError(status: number | undefined, json: unknown): ResponsesError {
	const error = apiErrorOf(json);
	const code = typeof error.code === "string" ? error.code : undefined;
	const message = typeof error.message === "string" && error.message !== "" ? error.message : undefined;
	const text = `${code ?? ""} ${message ?? ""}`;
	const at = status === undefined ? "" : ` (${status})`;
	if (USAGE_LIMIT.test(text))
		return new ResponsesError("usage_limit", `${usageLimitMessage(error)} ${message ?? ""}`.trim(), status, code);
	if (OVERFLOW.test(text) || status === 413)
		return new ResponsesError("overflow", `The context is too long${at}: ${message ?? code}`, status, code);
	const said = `${message ?? code ?? "no details"}${at}`;
	if (status === 401) return new ResponsesError("auth", `The sign-in was refused: ${said}`, status, code);
	if (status === 403 || status === 404)
		return new ResponsesError("refused", `The endpoint refused the request: ${said}`, status, code);
	if (status === 429) return new ResponsesError("rate_limit", `Too many requests: ${said}`, status, code);
	if (status !== undefined && status >= 500)
		return new ResponsesError("server", `The server failed: ${said}`, status, code);
	return new ResponsesError("other", `The request failed: ${said}`, status, code);
}

function retryDelay(response: Response, attempt: number, base: number): number {
	const ms = Number(response.headers.get("retry-after-ms"));
	if (Number.isFinite(ms) && response.headers.has("retry-after-ms")) return ms;
	const seconds = Number(response.headers.get("retry-after"));
	if (response.headers.has("retry-after") && Number.isFinite(seconds)) return seconds * 1000;
	return base * 2 ** attempt;
}

async function open(
	endpoint: ResponsesEndpoint,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Response> {
	const retries = endpoint.maxRetries ?? 3;
	const base = endpoint.baseDelayMs ?? 1_000;
	for (let attempt = 0; ; attempt++) {
		// Outside the network retry: a sign-in that cannot give a token fails as it is, at once.
		const headers = await endpoint.headers();
		let response: Response;
		try {
			response = await (endpoint.fetch ?? fetch)(endpoint.url, {
				method: "POST",
				headers: { ...headers, accept: "text/event-stream", "content-type": "application/json" },
				body: JSON.stringify(body),
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			if (attempt >= retries)
				throw new ResponsesError(
					"network",
					`Could not reach ${new URL(endpoint.url).host}: ${(error as Error).message}`,
				);
			await sleep(base * 2 ** attempt, undefined, signal ? { signal } : {});
			continue;
		}
		if (response.ok) return response;
		const text = await response.text().catch(() => "");
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = { error: { message: text.slice(0, 500) } };
		}
		const error = classifyError(response.status, json);
		if ((error.kind !== "server" && error.kind !== "rate_limit") || attempt >= retries) throw error;
		await sleep(retryDelay(response, attempt, base), undefined, signal ? { signal } : {});
	}
}

/** The JSON of one event's `data:` lines, or undefined when it carries none this client reads. */
function eventOf(block: string): Record<string, unknown> | undefined {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	if (data === "" || data === "[DONE]") return undefined;
	try {
		return JSON.parse(data) as Record<string, unknown>;
	} catch {
		// A line that is not JSON carries nothing this client reads.
		return undefined;
	}
}

/** The events of a server-sent stream, one JSON object each. */
async function* serverEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const decoder = new TextDecoder();
	let buffer = "";
	// A \r at a chunk's end may be the first half of a \r\n: it waits for the next chunk, or the stream's end.
	let pending = "";
	const read = (text: string, last: boolean) => {
		const joined = pending + text;
		pending = !last && joined.endsWith("\r") ? "\r" : "";
		// Lines may end in \r\n, \n or \r: all are read as \n.
		buffer += (pending ? joined.slice(0, -1) : joined).replace(/\r\n?/g, "\n");
	};
	/** The events the buffer ends; what follows the last blank line waits for more. */
	function* complete(): Generator<Record<string, unknown>> {
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const event = eventOf(buffer.slice(0, end));
			buffer = buffer.slice(end + 2);
			if (event !== undefined) yield event;
		}
	}
	for await (const chunk of response.body) {
		read(decoder.decode(chunk as Uint8Array, { stream: true }), false);
		yield* complete();
	}
	// At the end, the \r held back ends its line. An event without the blank line after it is dropped, as SSE says.
	read(decoder.decode(), true);
	yield* complete();
}

function usageOf(response: Record<string, unknown> | undefined): ResponsesUsage {
	const usage = (response?.usage ?? {}) as {
		input_tokens?: number;
		output_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
		output_tokens_details?: { reasoning_tokens?: number };
	};
	const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
	return {
		input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead),
		cacheRead,
		output: usage.output_tokens ?? 0,
		reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
	};
}

/** Sends one request and yields its text and reasoning as they come, then the items and usage of the response. */
export async function* streamResponse(
	endpoint: ResponsesEndpoint,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): AsyncGenerator<ResponsesEvent> {
	const response = await open(endpoint, body, signal);
	const output: ResponsesItem[] = [];
	for await (const event of serverEvents(response)) {
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string") yield { type: "text_delta", text: event.delta };
				break;
			case "response.reasoning_summary_text.delta":
				if (typeof event.delta === "string") yield { type: "reasoning_delta", text: event.delta };
				break;
			case "response.reasoning_summary_part.added":
				// Each part after the first is a paragraph of its own.
				if (typeof event.summary_index === "number" && event.summary_index > 0)
					yield { type: "reasoning_delta", text: "\n\n" };
				break;
			case "response.output_item.done":
				if (typeof event.item === "object" && event.item !== null) output.push(event.item as ResponsesItem);
				break;
			case "error":
				throw classifyError(undefined, event);
			case "response.failed":
				throw classifyError(undefined, (event.response as Record<string, unknown> | undefined)?.error ?? {});
			case "response.completed":
			case "response.done":
			case "response.incomplete": {
				const finished = event.response as Record<string, unknown> | undefined;
				const items = output.length > 0 ? output : ((finished?.output as ResponsesItem[] | undefined) ?? []);
				const reason = (finished?.incomplete_details as { reason?: unknown } | undefined)?.reason;
				const incomplete = event.type === "response.incomplete" || finished?.status === "incomplete";
				yield {
					type: "done",
					status: incomplete ? "incomplete" : "completed",
					...(incomplete && typeof reason === "string" ? { incompleteReason: reason } : {}),
					output: items,
					usage: usageOf(finished),
				};
				return;
			}
		}
	}
	throw new ResponsesError("network", "The response stream ended before the response finished");
}
