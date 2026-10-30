import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { type AtelierEventBody, errorEvent } from "../../events.ts";
import { VERSION } from "../../version.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "../anthropic-api/backend.ts";
import { anthropicTransport, type ModelTransport } from "../anthropic-api/transport.ts";
import { chatCompletionsTransport, USAGE_LIMIT } from "./chat-completions.ts";
import { DEFAULT_OPENCODE_GO_MODEL, OPENCODE_GO_BASE_URL, openCodeGoModel } from "./models.ts";

export const OPENCODE_GO_BACKEND_ID = "opencode-go";

/** Each request names its conversation, so OpenCode routes it to the same cache. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

export interface OpenCodeGoBackendOptions extends Omit<AnthropicApiBackendOptions, "id" | "connect"> {
	/** Injected in tests: a local server instead of OpenCode. */
	baseUrl?: string;
}

/** The headers of every request of one session: its conversation id, and Atelier as the client. */
export function openCodeGoHeaders(sessionId: string): Record<string, string> {
	return { [OPENCODE_SESSION_HEADER]: sessionId, "user-agent": `atelier/${VERSION}` };
}

const KEY_HINT =
	"OpenCode Go refused the key: store another with /login api-key opencode-go (atelier login api-key opencode-go), or check OPENCODE_API_KEY.";
const QUOTA_HINT =
	"OpenCode Go's usage limit is reached: it counts 5-hour, weekly and monthly limits; see https://opencode.ai/console.";

/**
 * The transport's errors as OpenCode Go means them: a spent plan (402, or 429 that names the limit) is
 * `quota_exceeded` and not retried, and a refused key says where the key comes from.
 */
function withOpenCodeErrors(transport: ModelTransport): ModelTransport {
	return {
		...transport,
		errorEvent(error, message): AtelierEventBody {
			const status = (error as { status?: unknown } | null)?.status;
			if (status === 402 || (status === 429 && USAGE_LIMIT.test(message)))
				return errorEvent("quota_exceeded", `${message}. ${QUOTA_HINT}`, false);
			const event = transport.errorEvent(error, message);
			return event.type === "error" && event.code === "authentication_error"
				? { ...event, message: `${message}. ${KEY_HINT}` }
				: event;
		},
	};
}

/**
 * The Anthropic SDK retries every 429. A spent plan (402, or a 429 that names the usage limit) only fails again, so
 * its answer is marked `x-should-retry: false`, a header the SDK obeys; anthropic-api's client is not wrapped.
 */
function withoutQuotaRetries(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await fetchFn(input, init);
		if (response.status !== 402 && response.status !== 429) return response;
		const text = await response.text();
		const headers = new Headers(response.headers);
		if (response.status === 402 || USAGE_LIMIT.test(text)) headers.set("x-should-retry", "false");
		return new Response(text, { status: response.status, statusText: response.statusText, headers });
	};
}

/** Reasoning a Chat Completions model left carries no signature, so a Messages API model cannot take it back. */
function withoutUnsigned(message: Anthropic.MessageParam): Anthropic.MessageParam {
	if (typeof message.content === "string") return message;
	const kept = message.content.filter((block) => block.type !== "thinking" || block.signature !== "");
	if (kept.length === message.content.length) return message;
	// Same role and block kinds as `message`, so the cast cannot change its type.
	return {
		...message,
		content: kept.length > 0 ? kept : [{ type: "text", text: "(no answer)" }],
	} as Anthropic.MessageParam;
}

/**
 * The Messages API at OpenCode Go: the SDK's transport, without what only Anthropic takes (`diagnostics`) or the
 * reasoning of Chat Completions models, and with the windows of the model table instead of the models API.
 */
function messagesTransport(client: Anthropic): ModelTransport {
	const transport = anthropicTransport(client, OPENCODE_GO_BACKEND_ID);
	return {
		...transport,
		request(params, signal) {
			const { diagnostics: _diagnostics, ...rest } = params;
			return transport.request({ ...rest, messages: rest.messages.map(withoutUnsigned) }, signal);
		},
		contextWindow: async (model) => openCodeGoModel(model).contextWindow,
	};
}

/**
 * Atelier's own loop on an OpenCode Go key: the `anthropic-api` session, with each model's requests sent in the
 * protocol OpenCode serves it with.
 */
export function createOpenCodeGoBackend(options: OpenCodeGoBackendOptions): AnthropicApiBackend {
	const { baseUrl = OPENCODE_GO_BASE_URL, ...rest } = options;
	return new AnthropicApiBackend({
		...rest,
		model: options.model ?? DEFAULT_OPENCODE_GO_MODEL,
		id: OPENCODE_GO_BACKEND_ID,
		connect: () => {
			const headers = openCodeGoHeaders(randomUUID());
			const messages = withOpenCodeErrors(
				messagesTransport(
					new Anthropic({
						apiKey: options.apiKey,
						baseURL: baseUrl,
						// The SDK sends the key as a bearer token; the Messages API's own header goes too.
						defaultHeaders: { ...headers, "x-api-key": options.apiKey },
						fetch: withoutQuotaRetries(options.fetch ?? globalThis.fetch),
						...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
					}),
				),
			);
			const chat = withOpenCodeErrors(
				chatCompletionsTransport({
					apiKey: options.apiKey,
					baseUrl,
					headers,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
				}),
			);
			return (model) => (openCodeGoModel(model).protocol === "anthropic-messages" ? messages : chat);
		},
	});
}
