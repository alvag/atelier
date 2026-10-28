import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BackendSession, ResumeState, ToolCall, ToolCallResult } from "../src/backend.ts";
import { createOpenCodeGoBackend } from "../src/backends/opencode-go/backend.ts";
import { toChatRequest } from "../src/backends/opencode-go/chat-completions.ts";
import { SUMMARY_HEADINGS } from "../src/compaction/compactor.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { defineTool } from "../src/tools/types.ts";
import { sse } from "./support/fake-provider.ts";

// No server: each test answers through an injected fetch, so nothing listens on a port.
const KEY = `oc-${"test"}-key`;

type Fetch = typeof globalThis.fetch;

const echoTool = defineTool({
	name: "echo",
	description: "Echoes the text back.",
	inputShape: { text: z.string() },
	execute: async ({ text }) => ({ ok: true, output: text, summary: text, truncated: false }),
});

const chunk = (delta: object, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });

const stream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

const chatReply = (text = "ok", usage?: object) =>
	stream(sse([chunk({ content: text }, "stop"), ...(usage ? [{ choices: [], usage }] : [])], { done: true }));

const messagesReply = () =>
	stream(
		sse(
			[
				{
					type: "message_start",
					message: {
						id: "msg",
						type: "message",
						role: "assistant",
						model: "minimax-m3",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			],
			{ named: true },
		),
	);

const refusedKey = () =>
	new Response(
		JSON.stringify({ type: "error", error: { type: "authentication_error", message: `Invalid key ${KEY}` } }),
		{
			status: 401,
			headers: { "content-type": "application/json" },
		},
	);

async function start(
	fetch: Fetch,
	model = "glm-5.3",
	executeTool: (call: ToolCall) => Promise<ToolCallResult> = async () => ({ ok: true, output: "ok" }),
	resume?: ResumeState,
): Promise<BackendSession> {
	return createOpenCodeGoBackend({ apiKey: KEY, fetch, model, baseUrl: "https://provider.invalid/go" }).start({
		cwd: "/tmp",
		systemPromptAppend: "",
		tools: [echoTool],
		executeTool,
		...(resume === undefined ? {} : { resume }),
	});
}

async function collect(events: AsyncIterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const all: AtelierEventBody[] = [];
	for await (const event of events) all.push(event);
	return all;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("opencode-go keeps its key out of sight", () => {
	it.each(["minimax-m3", "glm-5.3"])("on %s, in the refused key's error and in the saved history", async (model) => {
		const session = await start(async () => refusedKey(), model);
		const events = await collect(session.send("hi"));
		expect(events.find((event) => event.type === "error")).toMatchObject({
			code: "authentication_error",
			recoverable: false,
			message: expect.stringContaining("/login api-key opencode-go"),
		});
		expect(JSON.stringify([events, session.resumeState?.()])).not.toContain(KEY);
	});

	it("in the Anthropic SDK's debug log", async () => {
		vi.stubEnv("ANTHROPIC_LOG", "debug");
		const logged: unknown[] = [];
		for (const method of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, method).mockImplementation((...args) => {
				logged.push(args);
			});
		await collect((await start(async () => refusedKey(), "minimax-m3")).send("hi"));
		expect(JSON.stringify(logged)).not.toContain(KEY);
	});
});

describe("opencode-go's Chat Completions answers", () => {
	it("joins tool calls by their index, keeps steering and reasoning, and carries them across protocols and a resume", async () => {
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			if (requests.length > 1) return String(url).endsWith("messages") ? messagesReply() : chatReply();
			return stream(
				sse(
					[
						chunk({
							reasoning_content: "private thought",
							tool_calls: [{ index: 1, id: "b", function: { name: "echo", arguments: '{"text":"b"' } }],
						}),
						chunk(
							{
								tool_calls: [
									{ index: 0, id: "a", function: { name: "echo", arguments: '{"text":"a"}' } },
									{ index: 1, function: { arguments: "}" } },
								],
							},
							"tool_calls",
						),
					],
					{ done: true },
				),
			);
		}) as Fetch;
		const calls: ToolCall[] = [];
		const session = await start(fetch, "glm-5.3", async (call) => {
			calls.push(call);
			return { ok: true, output: call.callId ?? "", ...(call.callId === "a" ? { steering: "use tabs" } : {}) };
		});
		await collect(session.send("hi"));

		expect(calls.map((call) => [call.callId, call.input])).toEqual([
			["a", { text: "a" }],
			["b", { text: "b" }],
		]);
		const second = requests[1]?.body.messages as Record<string, unknown>[];
		expect(second.slice(-3)).toEqual([
			{ role: "tool", tool_call_id: "a", content: "a" },
			{ role: "tool", tool_call_id: "b", content: "b" },
			{ role: "user", content: "use tabs" },
		]);
		expect(second.find((message) => message.role === "assistant")?.reasoning_content).toBe("private thought");

		await session.configure?.({ model: "minimax-m3" });
		await collect(session.send("switch"));
		const onMessages = requests[2]?.body.messages as { role: string; content: { type: string }[] }[];
		expect(JSON.stringify(requests[2]?.body)).not.toContain("private thought");
		expect(onMessages.find((message) => message.role === "assistant")?.content.map(({ type }) => type)).toEqual([
			"tool_use",
			"tool_use",
		]);

		const saved = session.resumeState?.();
		expect(JSON.stringify(saved)).toContain("private thought");
		await collect((await start(fetch, "glm-5.3", undefined, saved)).send("resume"));
		expect(JSON.stringify(requests.at(-1)?.body)).toContain("private thought");
		expect(JSON.stringify(requests.at(-1)?.body)).not.toContain("signature");
	});

	it("counts cached reads and writes once, at OpenCode Go's prices", async () => {
		const usage = {
			prompt_tokens: 1000,
			completion_tokens: 30,
			prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
		};
		const events = await collect((await start(async () => chatReply("ok", usage), "kimi-k3")).send("hi"));
		expect(events.at(-1)).toMatchObject({
			usage: { input: 300, output: 30, cacheRead: 600, cacheWrite: 100 },
			costUsd: (300 * 3 + 30 * 15 + 600 * 0.3 + 100 * 3) / 1e6,
		});
	});

	it("ends an answer cut by its output budget as max_tokens", async () => {
		const events = await collect(
			(await start(async () => stream(sse([chunk({ content: "partial" }, "length")], { done: true })))).send("hi"),
		);
		expect(events.at(-1)).toMatchObject({ stopReason: "max_tokens" });
	});

	it("gives a summary the tools, which it may not call", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return chatReply(SUMMARY_HEADINGS.join("\n"));
		}) as Fetch;
		const session = await start(fetch);
		await collect(session.send("hi"));
		await session.summarize?.();
		expect(bodies[1]?.tools).toHaveLength(1);
		expect(bodies[1]?.tool_choice).toBe("none");
	});
});

describe("toChatRequest", () => {
	it("drops the signature of a Messages API model's thinking", () => {
		const request = toChatRequest({
			model: "glm-5.3",
			max_tokens: 10,
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "think", signature: "signed-value" },
						{ type: "text", text: "answer" },
					],
				},
			],
		});
		expect(request.messages).toEqual([{ role: "assistant", content: "answer", reasoning_content: "think" }]);
	});
});
