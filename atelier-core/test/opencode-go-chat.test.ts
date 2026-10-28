import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BackendSession, ToolCall } from "../src/backend.ts";
import { createBackend } from "../src/backend-factory.ts";
import { ChatCompletionsError, chatCompletionsTransport } from "../src/backends/opencode-go/chat-completions.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { defineTool } from "../src/tools/types.ts";
import { VERSION } from "../src/version.ts";
import { FakeProvider, sse } from "./support/fake-provider.ts";

const KEY = `oc-${"test"}-key`;
/** A model the table does not know: OpenCode Go serves it through Chat Completions. */
const MODEL = "some-chat-model";

const echoTool = defineTool({
	name: "echo",
	description: "Echoes the text back.",
	inputShape: { text: z.string() },
	execute: async ({ text }) => ({ ok: true, output: `echo: ${text}`, summary: text, truncated: false }),
});

let provider: FakeProvider;

beforeEach(async () => {
	provider = await FakeProvider.start();
});

afterEach(async () => {
	await provider.close();
});

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
	id: "chatcmpl-1",
	object: "chat.completion.chunk",
	choices: [{ index: 0, delta, finish_reason: finish }],
});

const usageChunk = (usage: Record<string, unknown>) => ({ id: "chatcmpl-1", choices: [], usage });

function textReply(text: string): { sse: string } {
	return {
		sse: sse(
			[
				chunk({ role: "assistant", content: text }),
				chunk({}, "stop"),
				usageChunk({ prompt_tokens: 10, completion_tokens: 2 }),
			],
			{
				done: true,
			},
		),
	};
}

async function start(calls: ToolCall[] = [], model = MODEL): Promise<BackendSession> {
	const backend = await createBackend("opencode-go", {
		resolveOpenCodeGoKey: async () => KEY,
		opencodeGo: { baseUrl: provider.url, maxRetries: 0, model },
	});
	return backend.start({
		cwd: "/tmp",
		systemPromptAppend: "",
		tools: [echoTool],
		executeTool: async (call) => {
			calls.push(call);
			const input = call.input as { text?: unknown };
			return typeof input.text === "string"
				? { ok: true, output: `echo: ${input.text}` }
				: { ok: false, output: "text is required" };
		},
	});
}

async function collect(events: AsyncIterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const all: AtelierEventBody[] = [];
	for await (const event of events) all.push(event);
	return all;
}

describe("opencode-go on Chat Completions", () => {
	it("streams the text and the reasoning, and counts the cached tokens apart", async () => {
		provider.answer({
			sse: sse(
				[
					chunk({ role: "assistant", reasoning_content: "Let me think." }),
					chunk({ content: "Hel" }),
					chunk({ content: "lo" }),
					chunk({}, "stop"),
					usageChunk({
						prompt_tokens: 5000,
						completion_tokens: 30,
						prompt_tokens_details: { cached_tokens: 4000 },
					}),
				],
				{ done: true },
			),
		});
		const events = await collect((await start()).send("hi"));

		expect(events[0]).toMatchObject({ type: "session_started", backend: "opencode-go", model: MODEL });
		expect(events.filter((event) => event.type.endsWith("_delta"))).toEqual([
			{ type: "thinking_delta", text: "Let me think." },
			{ type: "text_delta", text: "Hel" },
			{ type: "text_delta", text: "lo" },
		]);
		expect(events.at(-1)).toMatchObject({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1000, output: 30, cacheRead: 4000, cacheWrite: 0 },
			context: { window: 200_000 },
		});

		const [request] = provider.received;
		expect(request?.path).toBe("/v1/chat/completions");
		expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(request?.headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(request?.headers["user-agent"]).toBe(`atelier/${VERSION}`);
		expect(request?.body).toMatchObject({
			model: MODEL,
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 16_000,
			tools: [
				{
					type: "function",
					function: { name: "echo", description: "Echoes the text back.", parameters: { type: "object" } },
				},
			],
		});
		const messages = request?.body.messages as { role: string; content: unknown }[];
		expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
		expect(messages[1]?.content).toBe("hi");
	});

	it("runs the tool calls it gets in pieces, and sends their results back as tool messages", async () => {
		provider.answer(
			{
				sse: sse(
					[
						chunk({
							role: "assistant",
							content: "Calling.",
							tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "echo", arguments: '{"te' } }],
						}),
						chunk({ tool_calls: [{ index: 0, function: { arguments: 'xt":"one"}' } }] }),
						chunk({
							tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "echo", arguments: "{bad" } }],
						}),
						// Some models end a turn with tool calls on "stop".
						chunk({}, "stop"),
						usageChunk({ prompt_tokens: 10, completion_tokens: 5 }),
					],
					{ done: true },
				),
			},
			textReply("Done."),
		);
		const calls: ToolCall[] = [];
		const events = await collect((await start(calls)).send("echo one"));

		expect(calls).toEqual([
			{ tool: "echo", input: { text: "one" }, callId: "call_a" },
			// Arguments that are not JSON reach the tool as no arguments, and it says what is missing.
			{ tool: "echo", input: {}, callId: "call_b" },
		]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn", requests: 2 });
		const second = provider.received[1]?.body.messages as Record<string, unknown>[];
		expect(second.slice(1)).toEqual([
			{ role: "user", content: "echo one" },
			{
				role: "assistant",
				content: "Calling.",
				tool_calls: [
					{ id: "call_a", type: "function", function: { name: "echo", arguments: '{"text":"one"}' } },
					{ id: "call_b", type: "function", function: { name: "echo", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "call_a", content: "echo: one" },
			{ role: "tool", tool_call_id: "call_b", content: "Error: text is required" },
		]);
	});

	it("moves to a Messages API model with the same history, without the reasoning it cannot verify", async () => {
		provider.answer(
			{
				sse: sse([chunk({ reasoning_content: "hmm" }), chunk({ content: "First." }, "stop")], { done: true }),
			},
			{
				sse: sse(
					[
						{
							type: "message_start",
							message: {
								id: "msg_1",
								type: "message",
								role: "assistant",
								model: "minimax-m3",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 5, output_tokens: 1 },
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Second." } },
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
						{ type: "message_stop" },
					],
					{ named: true },
				),
			},
		);
		const session = await start();
		await collect(session.send("one"));
		await session.configure?.({ model: "minimax-m3" });
		const events = await collect(session.send("two"));

		expect(events).toContainEqual({ type: "text_delta", text: "Second." });
		const [chat, messages] = provider.received;
		expect(chat?.path).toBe("/v1/chat/completions");
		expect(messages?.path).toBe("/v1/messages");
		expect(messages?.headers["x-opencode-session"]).toBe(chat?.headers["x-opencode-session"]);
		const history = messages?.body.messages as { role: string; content: { type: string }[] }[];
		expect(history.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
		expect(history[1]?.content.map(({ type }) => type)).toEqual(["text"]);
	});

	it("reports a refused key without the key, and does not retry it", async () => {
		provider.answer({ status: 401, json: { error: { message: `Invalid API key ${KEY}` } } });
		const events = await collect((await start()).send("hi"));
		const error = events.find((event) => event.type === "error");
		expect(error).toMatchObject({ type: "error", code: "authentication_error", recoverable: false });
		expect(JSON.stringify(events)).not.toContain(KEY);
		expect(provider.received).toHaveLength(1);
	});
});

describe("chatCompletionsTransport", () => {
	it("knows a prompt larger than the window", () => {
		const transport = chatCompletionsTransport({ apiKey: KEY, baseUrl: provider.url, headers: {} });
		const overflow = (message: string) => new ChatCompletionsError(400, message);
		expect(transport.isOverflow(overflow("This model's maximum context length is 128000 tokens"))).toBe(true);
		expect(transport.isOverflow(overflow("bad tool schema"))).toBe(false);
	});
});
