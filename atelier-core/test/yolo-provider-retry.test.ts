import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicApiBackend } from "../src/backends/anthropic-api/backend.ts";
import type { ModelTransport } from "../src/backends/anthropic-api/transport.ts";
import { errorEvent } from "../src/events.ts";
import { Session } from "../src/index.ts";
import { LEFT_YOLO, YOLO_RULES } from "../src/prompt.ts";

const reply = (text: string) =>
	({
		id: "msg",
		type: "message",
		role: "assistant",
		model: "fake-model",
		content: [{ type: "text", text, citations: null }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
	}) as unknown as Anthropic.Message;

/** A transport whose first request fails before any output and whose later ones answer; it keeps each request. */
function failingFirst() {
	const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
	const transport: ModelTransport = {
		async *request(params) {
			requests.push(structuredClone(params));
			if (requests.length === 1) throw new Error("overloaded before output");
			yield { type: "text_delta", text: "ok" };
			return reply("ok");
		},
		contextWindow: async () => 200_000,
		isOverflow: () => false,
		errorEvent: (_error, message) => errorEvent("api_error", message, true),
	};
	return { requests, transport };
}

/** Where `needle` last appears in the request's messages, as JSON. */
const lastAt = (params: Anthropic.MessageCreateParamsNonStreaming | undefined, needle: string) =>
	JSON.stringify(params?.messages ?? []).lastIndexOf(JSON.stringify(needle).slice(1, -1));

describe("a mode note in a prompt the provider rejected", () => {
	it("is followed by the current mode when the backend may have kept the rejected prompt", async () => {
		const { requests, transport } = failingFirst();
		const backend = new AnthropicApiBackend({ apiKey: "test", maxRetries: 0, connect: () => () => transport });
		const session = await Session.start({ backend, cwd: process.cwd(), tools: [] });
		const send = async (prompt: string) => {
			for await (const _ of session.send(prompt)) {
			}
		};
		session.setPermissionMode("yolo");
		await send("first");
		session.setPermissionMode("normal");
		await send("retry in normal");
		await session.close();

		expect(requests).toHaveLength(2);
		// The backend kept the rejected prompt, yolo rules included.
		const firstLine = YOLO_RULES.split("\n")[0] as string;
		expect(lastAt(requests[1], firstLine)).toBeGreaterThan(-1);
		expect(lastAt(requests[1], LEFT_YOLO)).toBeGreaterThan(lastAt(requests[1], firstLine));
	});
});
