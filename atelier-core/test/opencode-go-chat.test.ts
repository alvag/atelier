import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BackendSession, ToolCall } from "../src/backend.ts";
import { createBackend } from "../src/backend-factory.ts";
import {
	ChatCompletionsError,
	chatCompletionsTransport,
	toChatRequest,
} from "../src/backends/opencode-go/chat-completions.ts";
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

async function start(calls: ToolCall[] = [], model = MODEL, maxRetries = 0): Promise<BackendSession> {
	const backend = await createBackend("opencode-go", {
		resolveOpenCodeGoKey: async () => KEY,
		opencodeGo: { baseUrl: provider.url, maxRetries, model },
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

	it("reports a refused key without the key, says how to change it, and does not retry it", async () => {
		provider.answer({ status: 401, json: { error: { message: `Invalid API key ${KEY}` } } });
		const events = await collect((await start([], MODEL, 2)).send("hi"));
		const error = events.find((event) => event.type === "error");
		expect(error).toMatchObject({ type: "error", code: "authentication_error", recoverable: false });
		expect((error as { message: string }).message).toBe(
			"401 Invalid API key [redacted]. OpenCode Go refused the key: store another with /login api-key opencode-go (atelier login api-key opencode-go), or check OPENCODE_API_KEY.",
		);
		expect(JSON.stringify(events)).not.toContain(KEY);
		expect(provider.received).toHaveLength(1);
	});

	it("says when the plan's usage limit is reached, on either protocol, and does not retry it", async () => {
		provider.answer(
			{ status: 429, json: { error: { message: "Monthly usage limit reached" } } },
			{ status: 402, json: { type: "error", error: { type: "billing_error", message: "Insufficient balance" } } },
		);
		const chat = await collect((await start([], MODEL, 2)).send("hi"));
		const messages = await collect((await start([], "minimax-m3", 2)).send("hi"));
		for (const events of [chat, messages]) {
			const error = events.find((event) => event.type === "error") as {
				code: string;
				message: string;
				recoverable: boolean;
			};
			expect(error).toMatchObject({ code: "quota_exceeded", recoverable: false });
			expect(error.message).toContain(
				"OpenCode Go's usage limit is reached: it counts 5-hour, weekly and monthly limits; see https://opencode.ai/console.",
			);
		}
		expect(provider.received).toHaveLength(2);
	});

	it("retries a request the provider could not serve, before anything streamed", async () => {
		provider.answer({ status: 503, json: { error: { message: "busy" } } }, textReply("Back."));
		const events = await collect((await start([], MODEL, 1)).send("hi"));
		expect(events).toContainEqual({ type: "text_delta", text: "Back." });
		expect(provider.received).toHaveLength(2);
	});

	it("fails a stream that ends before it says it is complete, and runs none of its tool calls", async () => {
		provider.answer({
			// Cut at a chunk boundary: no finish_reason and no [DONE].
			sse: sse([
				chunk({
					role: "assistant",
					content: "Calling.",
					tool_calls: [
						{ index: 0, id: "call_a", type: "function", function: { name: "echo", arguments: '{"text":"o' } },
					],
				}),
			]),
		});
		const calls: ToolCall[] = [];
		const events = await collect((await start(calls)).send("hi"));
		expect(calls).toEqual([]);
		expect(events.find((event) => event.type === "error")).toMatchObject({
			code: "api_error",
			message: "The Chat Completions stream ended before the answer was complete.",
			recoverable: true,
		});
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
	});

	/** An answer that says "Calling." and starts an echo call, then half of the event that carries its arguments. */
	const halfCall = (() => {
		const start = chunk({
			role: "assistant",
			content: "Calling.",
			tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "echo", arguments: "" } }],
		});
		const rest = `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":"over"}' } }] }))}`;
		return sse([start]) + rest.slice(0, rest.indexOf("over"));
	})();

	/** The turn of a cut answer: an error, no tool run, nothing of the answer kept for the next request. */
	async function cutTurn(answer: { sse: string; cut?: boolean }): Promise<AtelierEventBody | undefined> {
		provider.answer(answer);
		const calls: ToolCall[] = [];
		const session = await start(calls);
		const events = await collect(session.send("hi"));
		expect(events).toContainEqual({ type: "text_delta", text: "Calling." });
		expect(calls).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
		expect(JSON.stringify(session.resumeState?.())).not.toContain("Calling.");
		return events.find((event) => event.type === "error");
	}

	it("fails a stream whose body ends in the middle of an event, inside a tool call's arguments", async () => {
		expect(await cutTurn({ sse: halfCall })).toMatchObject({
			code: "api_error",
			message: "The Chat Completions stream ended before the answer was complete.",
			recoverable: true,
		});
	});

	it("fails a stream whose connection drops in the middle of a tool call", async () => {
		expect(await cutTurn({ sse: halfCall, cut: true })).toMatchObject({
			code: "api_error",
			// What the connection said, kept at the end.
			message: "The Chat Completions stream was cut before the answer was complete (terminated).",
			recoverable: true,
		});
	});

	it("takes a stream that ends with its finish_reason, even without [DONE]", async () => {
		provider.answer({ sse: sse([chunk({ content: "Whole." }), chunk({}, "stop")]) });
		const events = await collect((await start()).send("hi"));
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	});

	it("tells a rate limit apart from the usage limit", async () => {
		provider.answer({ status: 429, json: { error: { message: "Too many requests" } } });
		const events = await collect((await start()).send("hi"));
		expect(events.find((event) => event.type === "error")).toMatchObject({ code: "rate_limited", recoverable: true });
	});
});

describe("toChatRequest", () => {
	const base = {
		max_tokens: 100,
		messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "a" }] }],
	};

	it("sends the effort as reasoning_effort, and the model's own value to turn it off", () => {
		expect(toChatRequest({ ...base, model: "glm-5.3", output_config: { effort: "high" } })).toMatchObject({
			reasoning_effort: "high",
		});
		expect(toChatRequest({ ...base, model: "hy3", thinking: { type: "disabled" } })).toMatchObject({
			reasoning_effort: "none",
		});
		expect(toChatRequest({ ...base, model: "glm-5.3" })).not.toHaveProperty("reasoning_effort");
	});

	it("keeps the tools out of reach when the request says none, as a summary does", () => {
		const tools = [{ name: "echo", input_schema: { type: "object" as const } }];
		const none = toChatRequest({ ...base, model: "glm-5.3", tools, tool_choice: { type: "none" } });
		expect(none).toMatchObject({ tool_choice: "none" });
		expect(toChatRequest({ ...base, model: "glm-5.3", tools })).not.toHaveProperty("tool_choice");
	});

	it("gives DeepSeek's assistant messages a reasoning_content, which it requires, and no one else's", () => {
		const reasoning = (model: string) =>
			(toChatRequest({ ...base, model }).messages as Record<string, unknown>[])[0]?.reasoning_content;
		expect(reasoning("deepseek-v4-pro")).toBe("");
		expect(reasoning("glm-5.3")).toBeUndefined();
	});
});

/** Waits for a condition instead of a fixed delay. */
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
}

describe("the connection of a Chat Completions answer", () => {
	it("is closed once [DONE] arrives, even when the server leaves it open", async () => {
		provider.answer({
			sse: sse([chunk({ content: "Hi." }, "stop"), usageChunk({ prompt_tokens: 1, completion_tokens: 1 })], {
				done: true,
			}),
			keepOpen: true,
		});
		const events = await collect((await start()).send("hi"));
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
		await until(() => provider.closed === 1);
	});

	/** A transport whose answer streams `body` and records whether its reader was cancelled. */
	function recorded(body: string): {
		transport: ReturnType<typeof chatCompletionsTransport>;
		cancelled: () => boolean;
	} {
		let cancelled = false;
		const fetch = (async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						// Left open after `body`, as a server that does not end the answer.
						controller.enqueue(new TextEncoder().encode(body));
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)) as typeof globalThis.fetch;
		return {
			transport: chatCompletionsTransport({ apiKey: KEY, baseUrl: "https://provider.invalid/go", headers: {}, fetch }),
			cancelled: () => cancelled,
		};
	}

	const params = { model: MODEL, max_tokens: 10, messages: [{ role: "user" as const, content: "hi" }] };

	it.each([
		["an error chunk", sse([{ error: { message: "overloaded" } }])],
		["a line that is not JSON", "data: {not json\n\n"],
	])("is cancelled when the answer stops at %s", async (_name, body) => {
		const { transport, cancelled } = recorded(body);
		const stream = transport.request(params);
		await expect(stream.next()).rejects.toThrow();
		expect(cancelled()).toBe(true);
	});

	it("is cancelled when whoever reads the answer stops early", async () => {
		const { transport, cancelled } = recorded(sse([chunk({ content: "Hel" })]));
		const stream = transport.request(params);
		expect(await stream.next()).toEqual({ done: false, value: { type: "text_delta", text: "Hel" } });
		await stream.return(undefined as never);
		expect(cancelled()).toBe(true);
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
