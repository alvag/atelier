import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { type AtelierEventBody, errorEvent } from "../../events.ts";
import { imageCompatibleRequest } from "./image-history.ts";

/** Used when the models API does not say the model's window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
const WINDOW_LOOKUP_TIMEOUT_MS = 5_000;

/** What a request streams as it runs: the model's text and thinking. */
export type ModelDelta = Extract<AtelierEventBody, { type: "text_delta" | "thinking_delta" }>;

/**
 * How the session's requests reach a model. The session builds every request as a Messages API request and keeps
 * its history in that shape; a transport sends it in its protocol and answers with a complete Messages API message.
 */
export interface ModelTransport {
	/** Streams one request: yields its deltas and returns the whole message; an interrupted request throws. */
	request(
		params: Anthropic.MessageCreateParamsNonStreaming,
		signal?: AbortSignal,
	): AsyncGenerator<ModelDelta, Anthropic.Message>;
	/** The model's input window; any failure falls back to a default, never to an error. */
	contextWindow(model: string): Promise<number>;
	/** Whether the error is the API's answer to a prompt larger than the window. */
	isOverflow(error: unknown): boolean;
	/** The `error` event for a failed request, with `message` already redacted. */
	errorEvent(error: unknown, message: string): AtelierEventBody;
}

/** Runs a request to its end, for the requests whose deltas nobody shows (summaries). */
export async function finalMessage(stream: AsyncGenerator<ModelDelta, Anthropic.Message>): Promise<Anthropic.Message> {
	for (;;) {
		const next = await stream.next();
		if (next.done) return next.value;
	}
}

/** The Messages API through the Anthropic SDK: what `anthropic-api` runs on. */
export function anthropicTransport(client: Anthropic, backend = "anthropic-api"): ModelTransport {
	return {
		async *request(params, signal) {
			const stream = client.messages.stream(
				imageCompatibleRequest(params, backend),
				signal === undefined ? undefined : { signal },
			);
			for await (const event of stream) {
				if (event.type !== "content_block_delta") continue;
				if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
				else if (event.delta.type === "thinking_delta") yield { type: "thinking_delta", text: event.delta.thinking };
			}
			return await stream.finalMessage();
		},
		contextWindow: (model) => lookupWindow(client, model),
		isOverflow,
		errorEvent: anthropicErrorEvent,
	};
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

export function anthropicErrorEvent(error: unknown, message: string): AtelierEventBody {
	if (!(error instanceof APIError)) return errorEvent("api_error", message, true);
	const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type;
	if (error.status === 429 || type === "rate_limit_error") return errorEvent("rate_limited", message, true);
	if (error.status === 529 || type === "overloaded_error") return errorEvent("overloaded", message, true);
	if (error.status === 401 || type === "authentication_error")
		return errorEvent("authentication_error", message, false);
	if (error.status === 400 || type === "invalid_request_error") return errorEvent("invalid_request", message, false);
	return errorEvent("api_error", message, error.status === undefined || error.status >= 500);
}
