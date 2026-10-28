import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { VERSION } from "../../version.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "../anthropic-api/backend.ts";
import { anthropicTransport, type ModelTransport } from "../anthropic-api/transport.ts";
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

/**
 * The Messages API at OpenCode Go: the SDK's transport, without what only Anthropic takes (`diagnostics`), and with
 * the windows of the model table instead of the models API.
 */
function messagesTransport(client: Anthropic): ModelTransport {
	const transport = anthropicTransport(client);
	return {
		...transport,
		request(params, signal) {
			const { diagnostics: _diagnostics, ...rest } = params;
			return transport.request(rest, signal);
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
			const messages = messagesTransport(
				new Anthropic({
					apiKey: options.apiKey,
					baseURL: baseUrl,
					// The SDK sends the key as a bearer token; the Messages API's own header goes too.
					defaultHeaders: { ...headers, "x-api-key": options.apiKey },
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
				}),
			);
			return () => messages;
		},
	});
}
