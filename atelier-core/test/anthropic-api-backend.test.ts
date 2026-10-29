import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BackendSession, BackendStartOptions, SessionChange, ToolCall, ToolCallResult } from "../src/backend.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "../src/backends/anthropic-api/backend.ts";
import type { AtelierEvent, AtelierEventBody } from "../src/events.ts";
import { FakeBackend } from "../src/fake-backend.ts";
import { FakeMemory } from "../src/memory/port.ts";
import { costOfRequest } from "../src/pricing.ts";
import { Session } from "../src/session.ts";
import { defineTool } from "../src/tools/types.ts";

const API_KEY = "sk-ant-test-SECRET-123";

type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface Reply {
	blocks: Block[];
	stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	/** Stop after the first text delta and wait for the request to be aborted. */
	hang?: boolean;
	id?: string;
	diagnostics?: unknown;
}

type Scripted = Reply | { status: number; errorType: string; message: string } | { streamError: string };

function sseOf(reply: Reply): { head: string; tail: string } {
	const usage = reply.usage ?? {};
	const events: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: reply.id ?? "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					diagnostics: reply.diagnostics ?? null,
					usage: {
						input_tokens: usage.input ?? 10,
						output_tokens: 1,
						cache_read_input_tokens: usage.cacheRead ?? 0,
						cache_creation_input_tokens: usage.cacheWrite ?? 0,
					},
				},
			},
		],
	];
	reply.blocks.forEach((block, index) => {
		if (block.type === "text") {
			events.push([
				"content_block_start",
				{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
			]);
			events.push([
				"content_block_delta",
				{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
			]);
		} else if (block.type === "thinking") {
			events.push([
				"content_block_start",
				{ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
			]);
			events.push([
				"content_block_delta",
				{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } },
			]);
			events.push([
				"content_block_delta",
				{ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } },
			]);
		} else {
			events.push([
				"content_block_start",
				{
					type: "content_block_start",
					index,
					content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
				},
			]);
			events.push([
				"content_block_delta",
				{
					type: "content_block_delta",
					index,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
				},
			]);
		}
		events.push(["content_block_stop", { type: "content_block_stop", index }]);
	});
	events.push([
		"message_delta",
		{
			type: "message_delta",
			delta: { stop_reason: reply.stopReason ?? "end_turn", stop_sequence: null },
			usage: { output_tokens: usage.output ?? 5 },
		},
	]);
	events.push(["message_stop", { type: "message_stop" }]);
	const lines = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
	// head = message_start + the first block's start and delta: enough to see streamed text before a hang.
	return { head: lines.slice(0, 3).join(""), tail: lines.slice(3).join("") };
}

/** A fake Messages API: answers each request with the next scripted reply and records the request bodies. */
function fakeApi(script: Scripted[], options: { modelWindow?: number; modelsAnswer?: Promise<void> } = {}) {
	const bodies: Record<string, unknown>[] = [];
	const headers: Headers[] = [];
	const lookups: string[] = [];
	const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		// The models API: the window lookup when a session starts, answered apart from the script.
		if ((init?.method ?? "GET") === "GET") {
			lookups.push(String(url));
			await options.modelsAnswer;
			if (options.modelWindow === undefined)
				return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no" } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			return new Response(
				JSON.stringify({
					type: "model",
					id: "claude-sonnet-5-5",
					max_input_tokens: options.modelWindow,
					max_tokens: 64_000,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		bodies.push(JSON.parse(String(init?.body)));
		headers.push(new Headers(init?.headers));
		const next = script.shift();
		if (!next) throw new Error("No scripted reply left.");
		if ("status" in next) {
			return new Response(JSON.stringify({ type: "error", error: { type: next.errorType, message: next.message } }), {
				status: next.status,
				headers: { "content-type": "application/json" },
			});
		}
		const encoder = new TextEncoder();
		const signal = init?.signal;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				if ("streamError" in next) {
					controller.enqueue(
						encoder.encode(
							`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: next.streamError, message: "Overloaded" } })}\n\n`,
						),
					);
					controller.close();
					return;
				}
				const { head, tail } = sseOf(next);
				controller.enqueue(encoder.encode(head));
				if (next.hang) {
					signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
					return;
				}
				controller.enqueue(encoder.encode(tail));
				controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch: fetch as typeof globalThis.fetch, bodies, headers, lookups };
}

const echoTool = defineTool({
	name: "echo",
	description: "Echoes the text back.",
	inputShape: { text: z.string() },
	execute: async ({ text }) => ({ ok: true, output: `echo: ${text}`, summary: text, truncated: false }),
});

interface Harness {
	session: BackendSession;
	calls: ToolCall[];
	api: ReturnType<typeof fakeApi>;
}

async function start(
	script: Scripted[],
	execute: (call: ToolCall) => Promise<ToolCallResult> = async (call) => ({
		ok: true,
		output: `ran ${call.tool}`,
	}),
	options: Partial<AnthropicApiBackendOptions> = {},
	summaries?: string[],
	startOptions: Partial<BackendStartOptions> = {},
): Promise<Harness> {
	const api = fakeApi(script);
	const calls: ToolCall[] = [];
	const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0, ...options });
	const session = await backend.start({
		cwd: "/work",
		systemPromptAppend: "APPEND",
		tools: [echoTool],
		executeTool: async (call) => {
			calls.push(call);
			return execute(call);
		},
		...(summaries === undefined ? {} : { compacted: (summary: string) => void summaries.push(summary) }),
		...startOptions,
	});
	return { session, calls, api };
}

async function collect(events: AsyncIterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const out: AtelierEventBody[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const finished = (events: AtelierEventBody[]) => events.filter((e) => e.type === "turn_finished");
const messagesOf = (body: Record<string, unknown> | undefined) =>
	body?.messages as { role: string; content: unknown }[];
/** A request as stored history: the moving cache breakpoint is only added to what is sent. */
const withoutBreakpoints = (value: unknown) =>
	JSON.parse(JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v)));

describe("AnthropicApiBackend", () => {
	it("streams a text turn and reports the session, usage and cost", async () => {
		const { session, api } = await start([
			{
				blocks: [
					{ type: "thinking", thinking: "Plan." },
					{ type: "text", text: "Hello" },
				],
				usage: { input: 1_000_000, output: 1_000_000 },
			},
		]);
		const events = await collect(session.send("Hi"));
		expect(events).toEqual([
			{ type: "session_started", backend: "anthropic-api", model: "claude-sonnet-5-5", authSource: "api_key" },
			{ type: "thinking_delta", text: "Plan." },
			{ type: "text_delta", text: "Hello" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
				costUsd: 12,
				requests: 1,
				context: { tokens: 2000000, window: 200_000, compactAt: 167_616 },
			},
		]);
		const body = api.bodies[0];
		expect(body?.model).toBe("claude-sonnet-5-5");
		expect(body).not.toHaveProperty("output_config");
		expect(body?.stream).toBe(true);
		expect(JSON.stringify(body?.system)).toContain("/work");
		expect(JSON.stringify(body?.system)).toContain("APPEND");
		expect(withoutBreakpoints(messagesOf(body))).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
		// SDK 1.x sends the key as a bearer token and pins API version 2026-10-21.
		expect(api.headers[0]?.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(api.headers[0]?.get("anthropic-version")).toBe("2026-10-21");
	});

	it("announces the session only on the first turn and honors the start model", async () => {
		const api = fakeApi([{ blocks: [{ type: "text", text: "a" }] }, { blocks: [{ type: "text", text: "b" }] }]);
		const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
		const session = await backend.start({
			cwd: "/work",
			model: "claude-opus-5-5",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		const first = await collect(session.send("one"));
		const second = await collect(session.send("two"));
		expect(first[0]).toMatchObject({ type: "session_started", model: "claude-opus-5-5" });
		expect(second.some((e) => e.type === "session_started")).toBe(false);
		expect(api.bodies[1]?.model).toBe("claude-opus-5-5");
		expect(messagesOf(api.bodies[1])).toHaveLength(3);
	});

	it("sends the requested effort as output_config.effort on every request and says it when the session starts", async () => {
		const { session, api } = await start(
			[
				{ blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }], stopReason: "tool_use" },
				{ blocks: [{ type: "text", text: "done" }] },
			],
			undefined,
			{},
			undefined,
			{ thinking: "high" },
		);
		const events = await collect(session.send("Hi"));
		expect(events[0]).toEqual({
			type: "session_started",
			backend: "anthropic-api",
			model: "claude-sonnet-5-5",
			authSource: "api_key",
			effort: "high",
		});
		expect(api.bodies.map((body) => body.output_config)).toEqual([{ effort: "high" }, { effort: "high" }]);
		// The effort each answer was asked with stays in Atelier's history, never in what the API receives.
		expect(JSON.stringify(messagesOf(api.bodies[1]))).not.toContain("effort");
	});

	it("sends the new model and effort in the next request after configure, and prices the turn by the new model", async () => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "one" }] }, { blocks: [{ type: "text", text: "two" }] }],
			undefined,
			{ contextWindow: 200_000 },
			undefined,
			{ model: "claude-sonnet-5-5", thinking: "low" },
		);
		await collect(session.send("a"));
		await session.configure?.({ model: "claude-opus-5-5", thinking: "max" });
		const second = await collect(session.send("b"));
		expect(api.bodies.map((body) => body.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
		expect(api.bodies.map((body) => body.output_config)).toEqual([{ effort: "low" }, { effort: "max" }]);
		// The history stays: the new model reads the conversation so far.
		expect(JSON.stringify(messagesOf(api.bodies[1]))).toContain("one");
		const done = second.at(-1);
		expect(done).toMatchObject({
			type: "turn_finished",
			costUsd: costOfRequest("claude-opus-5-5", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
		});
	});

	it("drops the effort the new model does not take, and sends nothing about it", async () => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "one" }] }, { blocks: [{ type: "text", text: "two" }] }],
			undefined,
			{ contextWindow: 200_000 },
			undefined,
			{ model: "claude-sonnet-5-5", thinking: "xhigh" },
		);
		await collect(session.send("a"));
		await session.configure?.({ model: "claude-sonnet-4-6" });
		await collect(session.send("b"));
		expect(api.bodies[1]?.model).toBe("claude-sonnet-4-6");
		expect(api.bodies[1]).not.toHaveProperty("output_config");
	});

	it("turns thinking off where the model says how, and back on", async () => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "one" }] }, { blocks: [{ type: "text", text: "two" }] }],
			undefined,
			{ contextWindow: 200_000 },
			undefined,
			{ model: "claude-haiku-5-5", thinking: "high" },
		);
		await session.configure?.({ thinking: "off" });
		await collect(session.send("a"));
		await session.configure?.({ thinking: "medium" });
		await collect(session.send("b"));
		expect(api.bodies[0]?.thinking).toEqual({ type: "disabled" });
		expect(api.bodies[0]).not.toHaveProperty("output_config");
		expect(api.bodies[1]?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(api.bodies[1]?.output_config).toEqual({ effort: "medium" });
	});

	it("looks up the window of the new model, so the context says its size", async () => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "one" }] }, { blocks: [{ type: "text", text: "two" }] }],
			undefined,
			{},
			undefined,
			{ model: "claude-sonnet-5-5" },
		);
		await collect(session.send("a"));
		const before = api.lookups.length;
		await session.configure?.({ model: "claude-opus-5-5" });
		const events = await collect(session.send("b"));
		expect(api.lookups.length).toBe(before + 1);
		expect(api.lookups.at(-1)).toContain("claude-opus-5-5");
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", context: { window: expect.any(Number) } });
	});

	it("does not send an effort the model does not support, and says the level was not sent", async () => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "ok" }] }],
			undefined,
			{ model: "claude-opus-4-6" },
			undefined,
			{ thinking: "xhigh" },
		);
		const events = await collect(session.send("Hi"));
		expect(events[0]).toMatchObject({ type: "session_started", model: "claude-opus-4-6", effort: "xhigh not sent" });
		expect(api.bodies[0]).not.toHaveProperty("output_config");
	});

	it("sends minimal as effort low", async () => {
		const { session, api } = await start([{ blocks: [{ type: "text", text: "ok" }] }], undefined, {}, undefined, {
			thinking: "minimal",
		});
		const events = await collect(session.send("Hi"));
		expect(events[0]).toMatchObject({ type: "session_started", effort: "low" });
		expect(api.bodies[0]?.output_config).toEqual({ effort: "low" });
	});

	it.each([
		["claude-haiku-5-5", "disabled"],
		["claude-opus-5", "disabled"],
		["claude-sonnet-5-5", "between_tools"],
	])("turns thinking off on %s with %s, sends no effort and says off", async (model, type) => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "ok" }] }],
			undefined,
			{ model },
			undefined,
			{
				thinking: "off",
			},
		);
		const events = await collect(session.send("Hi"));
		expect(events[0]).toMatchObject({ type: "session_started", model, effort: "off" });
		expect(api.bodies[0]?.thinking).toEqual({ type });
		expect(api.bodies[0]).not.toHaveProperty("output_config");
	});

	it("does not turn thinking off on Opus 5.5, which answers 400 to it, and says off was not sent", async () => {
		const { session, api } = await start(
			[{ blocks: [{ type: "text", text: "ok" }] }],
			undefined,
			{ model: "claude-opus-5-5" },
			undefined,
			{ thinking: "off" },
		);
		const events = await collect(session.send("Hi"));
		expect(events[0]).toMatchObject({ type: "session_started", model: "claude-opus-5-5", effort: "off not sent" });
		expect(api.bodies[0]?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(api.bodies[0]).not.toHaveProperty("output_config");
	});

	it("sends no effort field when no level was asked, and asks for the thinking summarized", async () => {
		const { session, api } = await start([{ blocks: [{ type: "text", text: "ok" }] }]);
		const events = await collect(session.send("Hi"));
		expect(events[0]).not.toHaveProperty("effort");
		expect(api.bodies[0]?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(api.bodies[0]).not.toHaveProperty("output_config");
	});

	it("asks for no thinking on a model where it is off by default, which adaptive would turn on", async () => {
		const { session, api } = await start([{ blocks: [{ type: "text", text: "ok" }] }], undefined, {
			model: "claude-opus-4-6",
		});
		await collect(session.send("Hi"));
		expect(api.bodies[0]).not.toHaveProperty("thinking");
	});

	it("runs tools in order across several requests and keeps the history valid", async () => {
		const { session, calls, api } = await start([
			{
				blocks: [
					{ type: "text", text: "Two calls." },
					{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } },
					{ type: "tool_use", id: "tu_2", name: "echo", input: { text: "b" } },
				],
				stopReason: "tool_use",
				usage: { input: 100, output: 10 },
			},
			{
				blocks: [{ type: "tool_use", id: "tu_3", name: "echo", input: { text: "c" } }],
				stopReason: "tool_use",
				usage: { input: 50, output: 5, cacheRead: 200 },
			},
			{ blocks: [{ type: "text", text: "Done." }], usage: { input: 20, output: 2, cacheWrite: 30 } },
		]);
		const events = await collect(session.send("go"));
		expect(calls).toEqual([
			{ tool: "echo", input: { text: "a" }, callId: "tu_1" },
			{ tool: "echo", input: { text: "b" }, callId: "tu_2" },
			{ tool: "echo", input: { text: "c" }, callId: "tu_3" },
		]);
		expect(finished(events)).toEqual([
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 170, output: 17, cacheRead: 200, cacheWrite: 30 },
				costUsd: (170 * 2 + 17 * 10 + 200 * 0.1 + 30 * 2.5) / 1_000_000,
				requests: 3,
				context: { tokens: 52, window: 200_000, compactAt: 167_616 },
			},
		]);
		expect(api.bodies).toHaveLength(3);
		const last = messagesOf(api.bodies[2]);
		expect(last.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(withoutBreakpoints(last[2]?.content)).toEqual([
			{ type: "tool_result", tool_use_id: "tu_1", content: "ran echo" },
			{ type: "tool_result", tool_use_id: "tu_2", content: "ran echo" },
		]);
		expect(withoutBreakpoints(last[4]?.content)).toEqual([
			{ type: "tool_result", tool_use_id: "tu_3", content: "ran echo" },
		]);
		// The prefix never changes between requests of a session.
		expect(api.bodies[2]?.tools).toEqual(api.bodies[0]?.tools);
		expect(api.bodies[2]?.system).toEqual(api.bodies[0]?.system);
		// Earlier requests are not rewritten afterwards: each body is a prefix of the next.
		expect(withoutBreakpoints(last.slice(0, 3))).toEqual(withoutBreakpoints(messagesOf(api.bodies[1])));
	});

	it("sends what the user steered with a tool result as text after the turn's tool results, in the next request", async () => {
		const { session, api } = await start(
			[
				{
					blocks: [
						{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } },
						{ type: "tool_use", id: "tu_2", name: "echo", input: { text: "b" } },
					],
					stopReason: "tool_use",
					usage: { input: 100, output: 10 },
				},
				{ blocks: [{ type: "text", text: "Done." }], usage: { input: 20, output: 2 } },
			],
			async (call) => ({
				ok: true,
				output: `ran ${call.tool}`,
				...(call.callId === "tu_1" ? { steering: "use tabs" } : {}),
			}),
		);
		await collect(session.send("go"));
		const last = messagesOf(api.bodies[1]);
		expect(withoutBreakpoints(last[2]?.content)).toEqual([
			{ type: "tool_result", tool_use_id: "tu_1", content: "ran echo" },
			{ type: "tool_result", tool_use_id: "tu_2", content: "ran echo" },
			{ type: "text", text: "use tabs" },
		]);
	});

	it.each([
		["no content", []],
		["only an empty text block", [{ type: "text" as const, text: "" }]],
	])("keeps an empty assistant reply (%s) out of the history so the next request stays valid", async (_, blocks) => {
		const { session, api } = await start([{ blocks }, { blocks: [{ type: "text", text: "Here." }] }]);
		const first = await collect(session.send("Hi"));
		expect(finished(first)).toMatchObject([{ type: "turn_finished", stopReason: "end_turn", requests: 1 }]);
		await collect(session.send("again"));
		expect(withoutBreakpoints(messagesOf(api.bodies[1]))).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Hi" },
					{ type: "text", text: "again" },
				],
			},
		]);
	});

	it("sends a denied tool back as an error result", async () => {
		const { session, api } = await start(
			[
				{ blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "x" } }], stopReason: "tool_use" },
				{ blocks: [{ type: "text", text: "OK, not running it." }] },
			],
			async () => ({ ok: false, output: "The user denied this command." }),
		);
		await collect(session.send("go"));
		expect(withoutBreakpoints(messagesOf(api.bodies[1])[2]?.content)).toEqual([
			{ type: "tool_result", tool_use_id: "tu_1", content: "The user denied this command.", is_error: true },
		]);
	});

	it("stops at the request limit with a turn_limit error", async () => {
		const loop = (id: string): Reply => ({
			blocks: [{ type: "tool_use", id, name: "echo", input: { text: id } }],
			stopReason: "tool_use",
		});
		const { session, api } = await start([loop("a"), loop("b"), loop("c")], undefined, { maxRequestsPerTurn: 2 });
		const events = await collect(session.send("loop"));
		expect(api.bodies).toHaveLength(2);
		expect(events.filter((e) => e.type === "error")).toEqual([
			{ type: "error", code: "turn_limit", message: expect.stringContaining("2"), recoverable: true },
		]);
		expect(finished(events)).toEqual([expect.objectContaining({ stopReason: "turn_limit" })]);
	});

	it("lets the start options cap a turn's requests below the backend's own limit", async () => {
		const loop = (id: string): Reply => ({
			blocks: [{ type: "tool_use", id, name: "echo", input: { text: id } }],
			stopReason: "tool_use",
		});
		const api = fakeApi([loop("a"), loop("b")]);
		const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
		const session = await backend.start({
			cwd: "/work",
			systemPromptAppend: "",
			tools: [echoTool],
			executeTool: async () => ({ ok: true, output: "" }),
			maxRequestsPerTurn: 1,
		});
		const events = await collect(session.send("loop"));
		expect(api.bodies).toHaveLength(1);
		expect(events.filter((e) => e.type === "error")).toEqual([expect.objectContaining({ code: "turn_limit" })]);
	});

	it.each([
		[429, "rate_limit_error", "rate_limited", true],
		[529, "overloaded_error", "overloaded", true],
		[400, "invalid_request_error", "invalid_request", false],
		[401, "authentication_error", "authentication_error", false],
		[500, "api_error", "api_error", true],
	])("turns HTTP %i into a %s event without leaking the key", async (status, errorType, code, recoverable) => {
		const { session } = await start([{ status, errorType, message: `bad key ${API_KEY}` }]);
		const events = await collect(session.send("hi"));
		const errors = events.filter((e) => e.type === "error");
		expect(errors).toEqual([{ type: "error", code, message: expect.any(String), recoverable }]);
		expect(JSON.stringify(events)).not.toContain(API_KEY);
		expect(finished(events)).toEqual([
			{
				type: "turn_finished",
				stopReason: "error",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				costUsd: 0,
				requests: 0,
				context: { tokens: 14, window: 200_000, compactAt: 167_616 },
			},
		]);
	});

	it("maps an overloaded error sent inside the stream", async () => {
		const { session } = await start([{ streamError: "overloaded_error" }]);
		const events = await collect(session.send("hi"));
		expect(events.filter((e) => e.type === "error")).toEqual([
			{ type: "error", code: "overloaded", message: expect.any(String), recoverable: true },
		]);
	});

	it("interrupts a streaming request and sends a valid history on the next turn", async () => {
		const { session, api } = await start([
			{ blocks: [{ type: "text", text: "Partial" }], hang: true },
			{ blocks: [{ type: "text", text: "Fresh." }] },
		]);
		const events: AtelierEventBody[] = [];
		for await (const event of session.send("first")) {
			events.push(event);
			if (event.type === "text_delta") await session.interrupt();
		}
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "interrupted" });
		expect(events.some((e) => e.type === "error")).toBe(false);

		await collect(session.send("second"));
		// The partial answer is dropped and both prompts share one user message.
		expect(withoutBreakpoints(messagesOf(api.bodies[1]))).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		]);
	});

	it("answers tools left unrun by an interrupt so the next turn is valid", async () => {
		let session: BackendSession | undefined;
		const harness = await start(
			[
				{
					blocks: [
						{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } },
						{ type: "tool_use", id: "tu_2", name: "echo", input: { text: "b" } },
					],
					stopReason: "tool_use",
				},
				{ blocks: [{ type: "text", text: "Next." }] },
			],
			async () => {
				await session?.interrupt();
				return { ok: false, output: "Interrupted." };
			},
		);
		session = harness.session;
		const events = await collect(session.send("go"));
		expect(harness.calls).toHaveLength(1);
		expect(finished(events)).toEqual([expect.objectContaining({ stopReason: "interrupted" })]);

		await collect(session.send("again"));
		const messages = messagesOf(harness.api.bodies[1]);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(withoutBreakpoints(messages[2]?.content)).toEqual([
			{ type: "tool_result", tool_use_id: "tu_1", content: "Interrupted.", is_error: true },
			{ type: "tool_result", tool_use_id: "tu_2", content: "Interrupted by the user.", is_error: true },
			{ type: "text", text: "again" },
		]);
	});

	it("refuses to send after close", async () => {
		const { session } = await start([]);
		await session.close();
		await expect(collect(session.send("late"))).rejects.toThrow(/closed/);
	});

	it("compares each request with the previous response for cache diagnostics", async () => {
		const { session, api } = await start([
			{
				id: "msg_a",
				blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
				stopReason: "tool_use",
			},
			{ id: "msg_b", blocks: [{ type: "text", text: "done" }] },
			{ id: "msg_c", blocks: [{ type: "text", text: "again" }] },
		]);
		await collect(session.send("one"));
		await collect(session.send("two"));
		expect(api.bodies.map((body) => body.diagnostics)).toEqual([
			{ previous_message_id: null },
			{ previous_message_id: "msg_a" },
			{ previous_message_id: "msg_b" },
		]);
	});

	it("reports a cache miss with its reason and the tokens it cost", async () => {
		const { session } = await start([
			{
				blocks: [{ type: "text", text: "x" }],
				diagnostics: { cache_miss_reason: { type: "system_changed", cache_missed_input_tokens: 4200 } },
			},
		]);
		const events = await collect(session.send("hi"));
		expect(events.filter((e) => e.type === "cache_miss")).toEqual([
			{ type: "cache_miss", reason: "system_changed", missedTokens: 4200 },
		]);
	});

	it.each([
		["no divergence", null],
		["a pending diagnosis", { cache_miss_reason: null }],
		["a missing previous message", { cache_miss_reason: { type: "previous_message_not_found" } }],
		["an unavailable diagnosis", { cache_miss_reason: { type: "unavailable" } }],
	])("reports no cache miss for %s", async (_name, diagnostics) => {
		const { session } = await start([{ blocks: [{ type: "text", text: "x" }], diagnostics }]);
		const events = await collect(session.send("hi"));
		expect(events.some((e) => e.type === "cache_miss")).toBe(false);
	});

	it("keeps the subagent's conversation out of the parent's context: only its report comes back", async () => {
		const api = fakeApi([
			// parent
			{
				id: "msg_p1",
				blocks: [{ type: "tool_use", id: "tu_task", name: "task", input: { agent: "helper", prompt: "Look it up." } }],
				stopReason: "tool_use",
			},
			// child, first request: thinks aloud and uses a tool
			{
				id: "msg_c1",
				blocks: [
					{ type: "text", text: "CHILD-NOISE while I look." },
					{ type: "tool_use", id: "tu_echo", name: "echo", input: { text: "CHILD-TOOL-INPUT" } },
				],
				stopReason: "tool_use",
			},
			// child, final answer
			{ id: "msg_c2", blocks: [{ type: "text", text: "Final report: src/a.ts:3." }] },
			// parent, after the report
			{ id: "msg_p2", blocks: [{ type: "text", text: "Thanks." }] },
		]);
		const newBackend = () => new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
		const session = await Session.start({
			backend: newBackend(),
			cwd: process.cwd(),
			tools: [echoTool],
			subagents: {
				agents: [
					{
						name: "helper",
						description: "Helps",
						tools: ["echo"],
						prompt: "HELPER PROMPT",
						models: {},
						maxRequests: 5,
					},
				],
				createBackend: newBackend,
			},
		});
		try {
			for await (const _ of session.send("Find it.", "t1")) {
			}
		} finally {
			await session.close();
		}
		expect(api.bodies).toHaveLength(4);
		const child = api.bodies[1] as Record<string, unknown>;
		expect(JSON.stringify(child.system)).toContain("HELPER PROMPT");
		expect(withoutBreakpoints(messagesOf(child))).toEqual([
			{ role: "user", content: [{ type: "text", text: "Look it up." }] },
		]);
		expect((child.tools as { name: string }[]).map((t) => t.name)).toEqual(["echo"]);

		const parentAfter = withoutBreakpoints(messagesOf(api.bodies[3]));
		expect(parentAfter.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(parentAfter[2].content).toEqual([
			{ type: "tool_result", tool_use_id: "tu_task", content: "Final report: src/a.ts:3." },
		]);
		const parentText = JSON.stringify(parentAfter);
		for (const childOnly of ["CHILD-NOISE", "CHILD-TOOL-INPUT", "echo: ", "HELPER PROMPT"])
			expect(parentText).not.toContain(childOnly);
		// The parent keeps comparing its own requests for cache diagnostics, not the child's.
		expect(api.bodies[3]?.diagnostics).toEqual({ previous_message_id: "msg_p1" });
	});

	it("works end to end through Session, which stamps events and reports tools", async () => {
		const api = fakeApi([
			{ blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "hi" } }], stopReason: "tool_use" },
			{ blocks: [{ type: "text", text: "Echoed." }] },
		]);
		const session = await Session.start({
			backend: new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 }),
			cwd: process.cwd(),
			tools: [echoTool],
		});
		try {
			const events = [];
			for await (const event of session.send("say hi", "t1")) events.push(event);
			expect(events.map((e) => [e.seq, e.type])).toEqual([
				[1, "session_started"],
				[2, "tool_call_started"],
				[3, "tool_call_finished"],
				[4, "text_delta"],
				[5, "turn_finished"],
			]);
			expect(events[2]).toMatchObject({ callId: "tu_1", ok: true, summary: "hi" });
			expect(withoutBreakpoints(messagesOf(api.bodies[1])[2]?.content)).toEqual([
				{ type: "tool_result", tool_use_id: "tu_1", content: "echo: hi" },
			]);
		} finally {
			await session.close();
		}
	});
});

const SUMMARY = [
	"## Goal",
	"- refactor",
	"## Constraints & Preferences",
	"## Progress",
	"### Done",
	"### In Progress",
	"### Blocked",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
].join("\n");
const summaryReply = (stopReason = "end_turn"): Reply => ({
	blocks: [{ type: "text", text: SUMMARY }],
	stopReason,
	usage: { input: 100, cacheRead: 2000, output: 300 },
});
const overflow = {
	status: 400,
	errorType: "invalid_request_error",
	message: "prompt is too long: 250000 tokens > 200000 maximum",
};
function compactOf(session: BackendSession, instructions?: string): AsyncIterable<AtelierEventBody> {
	if (!session.compact) throw new Error("This backend session cannot compact.");
	return session.compact(instructions);
}
const textOfBody = (body: Record<string, unknown> | undefined) => JSON.stringify(messagesOf(body));
const ofType = <T extends AtelierEventBody["type"]>(events: AtelierEventBody[], type: T) =>
	events.filter((e): e is Extract<AtelierEventBody, { type: T }> => e.type === type);

describe("AnthropicApiBackend compaction", () => {
	/** A small window so a test history crosses it; `keepRecentTokens: 1` keeps only the last exchange. */
	async function compacting(
		script: Scripted[],
		options: Partial<AnthropicApiBackendOptions> = {},
		summaries?: string[],
	) {
		return start(
			script,
			async () => ({ ok: true, output: "x".repeat(400) }),
			{
				contextWindow: 200_000,
				compactAt: 1000,
				keepRecentTokens: 1,
				...options,
			},
			summaries,
		);
	}

	it("hands the core each summary that replaced the history, and none that was refused", async () => {
		const summaries: string[] = [];
		const { session } = await compacting(
			[
				{
					blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
					stopReason: "tool_use",
					usage: { input: 2000 },
				},
				summaryReply("max_tokens"),
				{ blocks: [{ type: "text", text: "done" }] },
				summaryReply(),
			],
			{},
			summaries,
		);
		await collect(session.send("Refactor"));
		expect(summaries).toEqual([]);
		const events = await collect(compactOf(session));
		expect(ofType(events, "compaction_finished")).toMatchObject([{ ok: true, reason: "manual" }]);
		expect(summaries).toEqual([SUMMARY]);
	});

	it("summarizes the whole conversation for another backend, leaving the history and the core's callback alone", async () => {
		const summaries: string[] = [];
		const { session, api } = await compacting(
			[
				{
					blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
					stopReason: "tool_use",
				},
				{ blocks: [{ type: "text", text: "done" }] },
				summaryReply(),
				{ blocks: [{ type: "text", text: "again" }] },
			],
			{ compactAt: 1_000_000 },
			summaries,
		);
		await collect(session.send("Refactor the parser"));
		const summary = await session.summarize?.();
		expect(summary).toMatchObject({
			usage: { input: 100, output: 300, cacheRead: 2000, cacheWrite: 0 },
			requests: 1,
		});
		expect(summary?.text.startsWith(SUMMARY)).toBe(true);
		expect(summary?.text).toContain("## Files\nRead: (none)\nEdited: (none)");
		// Every message of the history, then the instruction as a user message of its own; no tool use allowed.
		const request = api.bodies[2];
		expect(request?.tool_choice).toEqual({ type: "none" });
		expect(messagesOf(request).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(textOfBody(request)).toContain("Refactor the parser");
		expect(JSON.stringify(messagesOf(request).at(-1))).toContain("Summarize the conversation above");
		expect(summaries).toEqual([]);
		// The history is as it was: the next turn does not carry the instruction.
		await collect(session.send("more"));
		expect(textOfBody(api.bodies[3])).not.toContain("Summarize the conversation above");
		expect(messagesOf(api.bodies[3])).toHaveLength(5);
	});

	it("refuses to summarize when the summary is cut short, or there is no conversation", async () => {
		const empty = await compacting([]);
		await expect(empty.session.summarize?.()).rejects.toThrow("There is no conversation to summarize.");
		const { session } = await compacting([{ blocks: [{ type: "text", text: "done" }] }, summaryReply("max_tokens")]);
		await collect(session.send("hi"));
		await expect(session.summarize?.()).rejects.toThrow(/max_tokens/);
	});

	it("compacts between requests of a turn and goes on with the summary and the verbatim tail", async () => {
		const { session, api } = await compacting([
			{
				blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
				stopReason: "tool_use",
				usage: { input: 2000 },
			},
			summaryReply(),
			{ blocks: [{ type: "text", text: "done" }] },
		]);
		const events = await collect(session.send("Refactor the parser"));
		// The last response measured 2005 tokens; the tool result appended since is estimated on top.
		const [started] = ofType(events, "compaction_started");
		expect(started).toMatchObject({ reason: "threshold" });
		expect(started?.tokens).toBeGreaterThan(2005);
		const [done] = ofType(events, "compaction_finished");
		expect(done).toMatchObject({ ok: true, reason: "threshold", tokensBefore: started?.tokens, kept: 2 });
		expect(done?.usage).toEqual({ input: 100, output: 300, cacheRead: 2000, cacheWrite: 0 });
		expect(done?.tokensAfter).toBeGreaterThan(0);
		// The summary request: the prefix before the cut plus the instruction, with no tool use allowed.
		const summary = api.bodies[1];
		expect(summary?.tool_choice).toEqual({ type: "none" });
		expect(messagesOf(summary)).toHaveLength(1);
		expect(textOfBody(summary)).toContain("Summarize the conversation above");
		// The next request: one summary message, then the assistant's tool call and its result, unchanged.
		const next = messagesOf(api.bodies[2]);
		expect(next.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(next[0])).toContain("compacted into the following summary");
		expect(JSON.stringify(next[0])).toContain("<request>\\nRefactor the parser\\n</request>");
		expect(JSON.stringify(next[1])).toContain("tu_1");
		const [turn] = finished(events);
		expect(finished(events)).toHaveLength(1);
		expect(turn).toMatchObject({ stopReason: "end_turn", requests: 3 });
		expect(turn?.type === "turn_finished" && turn.usage.output).toBe(5 + 300 + 5);
		expect(turn?.type === "turn_finished" && turn.context).toEqual({ tokens: 15, window: 200_000, compactAt: 1000 });
	});

	it("keeps the whole history when the summary is cut short, and does not retry it in the same turn", async () => {
		const { session, api } = await compacting([
			{
				blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
				stopReason: "tool_use",
				usage: { input: 2000 },
			},
			summaryReply("max_tokens"),
			{
				blocks: [{ type: "tool_use", id: "tu_2", name: "echo", input: { text: "b" } }],
				stopReason: "tool_use",
				usage: { input: 3000 },
			},
			{ blocks: [{ type: "text", text: "done" }] },
		]);
		const events = await collect(session.send("Refactor"));
		const [failed] = ofType(events, "compaction_finished");
		expect(failed).toMatchObject({ ok: false, reason: "threshold", kept: 0 });
		expect(failed?.error).toMatch(/max_tokens/);
		expect(ofType(events, "compaction_started")).toHaveLength(1);
		// The next request carries the original prompt, call and result, not a summary.
		expect(JSON.stringify(messagesOf(api.bodies[2])[0])).toContain("Refactor");
		expect(textOfBody(api.bodies[2])).not.toContain("compacted into the following summary");
		expect(messagesOf(api.bodies[2])).toHaveLength(3);
		expect(finished(events)[0]).toMatchObject({ stopReason: "end_turn" });
	});

	it("compacts once on a context overflow and retries the request", async () => {
		const { session, api } = await compacting(
			[
				{ blocks: [{ type: "text", text: "first answer" }] },
				overflow,
				summaryReply(),
				{ blocks: [{ type: "text", text: "second" }] },
			],
			{ compactAt: 1_000_000 },
		);
		await collect(session.send("first"));
		const events = await collect(session.send("second"));
		expect(ofType(events, "compaction_started")).toMatchObject([{ reason: "overflow" }]);
		expect(ofType(events, "compaction_finished")).toMatchObject([{ ok: true, reason: "overflow" }]);
		expect(ofType(events, "error")).toEqual([]);
		expect(finished(events)[0]).toMatchObject({ stopReason: "end_turn" });
		const retried = messagesOf(api.bodies[3]);
		expect(retried.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(retried[2])).toContain("second");
		// The request of this turn stays a message of its own, so it is not repeated in the summary.
		expect(JSON.stringify(retried[0])).not.toContain("<request>");
	});

	it("gives up after one overflow compaction and reports today's error", async () => {
		const { session } = await compacting(
			[{ blocks: [{ type: "text", text: "first answer" }] }, overflow, summaryReply(), overflow],
			{ compactAt: 1_000_000 },
		);
		await collect(session.send("first"));
		const events = await collect(session.send("second"));
		expect(ofType(events, "compaction_started")).toHaveLength(1);
		expect(ofType(events, "error")).toMatchObject([{ code: "invalid_request", recoverable: false }]);
		expect(finished(events)[0]).toMatchObject({ stopReason: "error" });
	});

	it("compacts on request with the user's instructions, as a turn of its own", async () => {
		const { session, api } = await compacting(
			[
				{ blocks: [{ type: "text", text: "first answer" }] },
				{ blocks: [{ type: "text", text: "second answer" }] },
				summaryReply(),
			],
			{ compactAt: 1_000_000 },
		);
		await collect(session.send("first"));
		await collect(session.send("second"));
		const events = await collect(compactOf(session, "Keep the API decisions."));
		expect(events.map((e) => e.type)).toEqual(["compaction_started", "compaction_finished", "turn_finished"]);
		expect(ofType(events, "compaction_finished")[0]).toMatchObject({ ok: true, reason: "manual", kept: 1 });
		expect(finished(events)[0]).toMatchObject({ stopReason: "end_turn", requests: 1 });
		expect(textOfBody(api.bodies[2])).toContain("Keep the API decisions.");
		// Between turns no request is carried into the summary.
		expect(textOfBody(api.bodies[2])).not.toContain("<request>");
	});

	it("asks for the summary with the session's effort", async () => {
		const { session, api } = await start(
			[
				{ blocks: [{ type: "text", text: "first answer" }] },
				{ blocks: [{ type: "text", text: "second answer" }] },
				summaryReply(),
			],
			async () => ({ ok: true, output: "" }),
			{ contextWindow: 200_000, compactAt: 1_000_000, keepRecentTokens: 1 },
			undefined,
			{ thinking: "medium" },
		);
		await collect(session.send("first"));
		await collect(session.send("second"));
		const events = await collect(compactOf(session));
		expect(ofType(events, "compaction_finished")[0]).toMatchObject({ ok: true });
		expect(api.bodies[2]?.output_config).toEqual({ effort: "medium" });
		expect(JSON.stringify(messagesOf(api.bodies[2]))).not.toContain("effort");
	});

	it("asks for the summary with the thinking turned off when the session turned it off", async () => {
		const { session, api } = await start(
			[
				{ blocks: [{ type: "text", text: "first answer" }] },
				{ blocks: [{ type: "text", text: "second answer" }] },
				summaryReply(),
			],
			async () => ({ ok: true, output: "" }),
			{ contextWindow: 200_000, compactAt: 1_000_000, keepRecentTokens: 1 },
			undefined,
			{ thinking: "off" },
		);
		await collect(session.send("first"));
		await collect(session.send("second"));
		const events = await collect(compactOf(session));
		expect(ofType(events, "compaction_finished")[0]).toMatchObject({ ok: true });
		expect(api.bodies[2]?.thinking).toEqual({ type: "between_tools" });
		expect(api.bodies[2]).not.toHaveProperty("output_config");
	});

	it("says there is nothing to compact in a short history, and keeps it", async () => {
		const { session } = await compacting([{ blocks: [{ type: "text", text: "hi" }] }], { keepRecentTokens: 20_000 });
		await collect(session.send("hello"));
		const events = await collect(compactOf(session));
		expect(ofType(events, "compaction_finished")[0]).toMatchObject({ ok: false, reason: "manual", kept: 0 });
		expect(ofType(events, "compaction_finished")[0]?.error).toMatch(/not enough history/);
		expect(finished(events)[0]).toMatchObject({ stopReason: "error" });
	});

	it("gives the core's state once, inside the summary message", async () => {
		const api = fakeApi([
			{ blocks: [{ type: "text", text: "first answer" }] },
			{ blocks: [{ type: "text", text: "second answer" }] },
			summaryReply(),
			{ blocks: [{ type: "text", text: "third answer" }] },
		]);
		const backend = new AnthropicApiBackend({
			apiKey: API_KEY,
			fetch: api.fetch,
			maxRetries: 0,
			contextWindow: 200_000,
			compactAt: 1_000_000,
			keepRecentTokens: 1,
		});
		const state = "<state>\nphase: checking\n</state>";
		const session = await backend.start({
			cwd: "/work",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
			compactionState: () => state,
		});
		await collect(session.send("first"));
		await collect(session.send("second"));
		await collect(compactOf(session));
		await collect(session.send("third"));
		const messages = messagesOf(api.bodies[3]);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(messages[0]).split(JSON.stringify(state).slice(1, -1))).toHaveLength(2);
		expect(JSON.stringify(messages[2])).not.toContain("<state>");
	});

	it("starts without waiting for the window, and waits for it only before the first request", async () => {
		let answer: () => void = () => {};
		const modelsAnswer = new Promise<void>((resolve) => {
			answer = resolve;
		});
		const api = fakeApi([{ blocks: [{ type: "text", text: "hi" }] }], { modelWindow: 500_000, modelsAnswer });
		const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
		const started = await Promise.race([
			backend.start({
				cwd: "/work",
				systemPromptAppend: "",
				tools: [],
				executeTool: async () => ({ ok: true, output: "" }),
			}),
			new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 200)),
		]);
		expect(started).not.toBe("waited");
		if (started === "waited") return;
		const turn = collect(started.send("hi"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The lookup is under way and the first request waits for it.
		expect(api.lookups).toHaveLength(1);
		expect(api.bodies).toEqual([]);
		answer();
		const events = await turn;
		expect(finished(events)[0]).toMatchObject({ context: { window: 500_000, compactAt: 200_000 } });
	});

	it("ends the turn at once when interrupted while it waits for the window, and stays usable", async () => {
		let answer: () => void = () => {};
		const modelsAnswer = new Promise<void>((resolve) => {
			answer = resolve;
		});
		const api = fakeApi([{ blocks: [{ type: "text", text: "after" }] }], { modelWindow: 500_000, modelsAnswer });
		const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
		const session = await backend.start({
			cwd: "/work",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		const turn = collect(session.send("first"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await session.interrupt();
		const ended = await Promise.race([
			turn,
			new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 200)),
		]);
		expect(ended).not.toBe("stuck");
		if (ended === "stuck") return;
		expect(finished(ended)).toMatchObject([{ stopReason: "interrupted" }]);
		expect(api.bodies).toEqual([]);
		answer();
		const next = await collect(session.send("second"));
		expect(finished(next)).toMatchObject([{ stopReason: "end_turn", context: { window: 500_000 } }]);
		// The interrupted prompt stays in the history, joined with the next one so roles keep alternating.
		expect(messagesOf(api.bodies[0]).map((m) => m.role)).toEqual(["user"]);
		expect(JSON.stringify(messagesOf(api.bodies[0]))).toContain("first");
	});

	it("ends a /compact at once when interrupted while it waits for the window", async () => {
		const modelsAnswer = new Promise<void>(() => {});
		const api = fakeApi([], { modelWindow: 500_000, modelsAnswer });
		const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
		const session = await backend.start({
			cwd: "/work",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		const turn = collect(compactOf(session));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await session.interrupt();
		const ended = await Promise.race([
			turn,
			new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 200)),
		]);
		expect(ended).not.toBe("stuck");
		if (ended === "stuck") return;
		expect(ended.map((e) => e.type)).toEqual(["turn_finished"]);
		expect(finished(ended)).toMatchObject([{ stopReason: "interrupted" }]);
	});

	it("takes the window from the models API, and falls back when it does not answer", async () => {
		for (const [modelWindow, window, compactAt] of [
			[500_000, 500_000, 200_000],
			[undefined, 200_000, 200_000 - 16_000 - 16_384],
		] as const) {
			const api = fakeApi(
				[{ blocks: [{ type: "text", text: "hi" }] }],
				modelWindow === undefined ? {} : { modelWindow },
			);
			const backend = new AnthropicApiBackend({ apiKey: API_KEY, fetch: api.fetch, maxRetries: 0 });
			const session = await backend.start({
				cwd: "/work",
				systemPromptAppend: "",
				tools: [],
				executeTool: async () => ({ ok: true, output: "" }),
			});
			const events = await collect(session.send("hi"));
			expect(api.lookups).toEqual(["https://api.anthropic.com/v1/models/claude-sonnet-5-5"]);
			expect(finished(events)[0]).toMatchObject({ context: { window, compactAt } });
		}
	});
});

describe("AnthropicApiBackend subagent compaction", () => {
	const done: AtelierEventBody = {
		type: "turn_finished",
		stopReason: "end_turn",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
	const worker = { name: "worker", description: "w", tools: ["echo"], prompt: "p", models: {}, maxRequests: 10 };

	/** A parent that delegates once to a worker whose anthropic-api backend plays `script`; the parent has memory. */
	async function delegate(script: Scripted[], options: Partial<AnthropicApiBackendOptions> = {}) {
		const api = fakeApi(script);
		const parent = new FakeBackend([
			[{ toolCall: { tool: "task", input: { agent: "worker", prompt: "Refactor" }, callId: "c1" } }, { event: done }],
		]);
		const memory = new FakeMemory("proj");
		const session = await Session.start({
			backend: parent,
			cwd: process.cwd(),
			tools: [echoTool],
			memory,
			subagents: {
				agents: [worker],
				createBackend: () =>
					new AnthropicApiBackend({
						apiKey: API_KEY,
						fetch: api.fetch,
						maxRetries: 0,
						contextWindow: 200_000,
						keepRecentTokens: 1,
						...options,
					}),
			},
		});
		const events: AtelierEvent[] = [];
		for await (const event of session.send("go")) events.push(event);
		await session.close();
		const child = events.filter((e) => e.parentCallId === "c1");
		return { events, child, result: parent.toolResults[0], memory };
	}
	const toolUse: Reply = {
		blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
		stopReason: "tool_use",
		usage: { input: 2000 },
	};
	const report: Reply = { blocks: [{ type: "text", text: "the report" }] };
	const types = (events: AtelierEvent[]) =>
		events.filter((e) => e.type.startsWith("compaction")).map((e) => [e.type, e.parentCallId, e.agent]);

	it("compacts a child past the threshold, under the task call, and the child finishes its task", async () => {
		const { child, result, memory } = await delegate([toolUse, summaryReply(), report], { compactAt: 1000 });
		expect(types(child)).toEqual([
			["compaction_started", "c1", "worker"],
			["compaction_finished", "c1", "worker"],
		]);
		expect(child.find((e) => e.type === "compaction_finished")).toMatchObject({ ok: true, reason: "threshold" });
		expect(result).toMatchObject({ ok: true, output: "the report" });
		// Subagents have no memory: the child's summary is not saved.
		expect(memory.saved).toEqual([]);
	});

	it("compacts a child once on an overflow and retries, and the child finishes its task", async () => {
		const { child, result, memory } = await delegate([toolUse, overflow, summaryReply(), report], {
			compactAt: 1_000_000,
		});
		expect(types(child)).toEqual([
			["compaction_started", "c1", "worker"],
			["compaction_finished", "c1", "worker"],
		]);
		expect(child.find((e) => e.type === "compaction_finished")).toMatchObject({ ok: true, reason: "overflow" });
		expect(child.filter((e) => e.type === "error")).toEqual([]);
		expect(result).toMatchObject({ ok: true, output: "the report" });
		expect(memory.saved).toEqual([]);
	});

	it("fails the task with the overflow and the compaction's cause when the child's compaction fails", async () => {
		const { child, result } = await delegate([toolUse, overflow, summaryReply("max_tokens")], {
			compactAt: 1_000_000,
		});
		expect(child.find((e) => e.type === "compaction_finished")).toMatchObject({ ok: false, reason: "overflow" });
		expect(result?.ok).toBe(false);
		expect(result?.output).toMatch(/^The worker subagent failed \(error\): invalid_request: .*prompt is too long/);
		expect(result?.output).toMatch(/its compaction failed: .*max_tokens/);
	});
});

describe("AnthropicApiBackend compaction entry", () => {
	const toolUse: Scripted = {
		blocks: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }],
		stopReason: "tool_use",
		usage: { input: 2000 },
	};
	const done: Scripted = { blocks: [{ type: "text", text: "done" }] };
	/** A turn that crosses the threshold once: the requests are main, summary, main. */
	async function compactingWith(startOptions: Partial<BackendStartOptions>, change?: SessionChange) {
		const { session, api } = await start(
			[toolUse, summaryReply(), done],
			async () => ({ ok: true, output: "x".repeat(400) }),
			{ contextWindow: 200_000, compactAt: 1000, keepRecentTokens: 1 },
			undefined,
			startOptions,
		);
		if (change) await session.configure?.(change);
		const events = await collect(session.send("Refactor the parser"));
		return { api, events };
	}

	it("asks for the summary with the compaction model and level, and for everything else with the session's", async () => {
		const { api } = await compactingWith({
			thinking: "high",
			compaction: { model: "claude-opus-5-5", thinking: "medium" },
		});
		expect(api.bodies.map((body) => [body.model, body.output_config])).toEqual([
			["claude-sonnet-5-5", { effort: "high" }],
			["claude-opus-5-5", { effort: "medium" }],
			["claude-sonnet-5-5", { effort: "high" }],
		]);
	});

	it("keeps the session's level for the summary when the entry sets only the model", async () => {
		const { api } = await compactingWith({ thinking: "high", compaction: { model: "claude-opus-5-5" } });
		expect(api.bodies[1]).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" } });
	});

	it("sends the summary request as before when there is no compaction entry", async () => {
		const { api } = await compactingWith({ thinking: "high" });
		expect(api.bodies.map((body) => [body.model, body.output_config])).toEqual(
			Array(3).fill(["claude-sonnet-5-5", { effort: "high" }]),
		);
	});

	it("asks for the summary with the entry a configure brings, then without it when configure clears it", async () => {
		const set = await compactingWith(
			{ thinking: "high" },
			{ compaction: { model: "claude-opus-5-5", thinking: "medium" } },
		);
		expect(set.api.bodies.map((body) => [body.model, body.output_config])).toEqual([
			["claude-sonnet-5-5", { effort: "high" }],
			["claude-opus-5-5", { effort: "medium" }],
			["claude-sonnet-5-5", { effort: "high" }],
		]);
		const cleared = await compactingWith(
			{ thinking: "high", compaction: { model: "claude-opus-5-5" } },
			{ compaction: null },
		);
		expect(cleared.api.bodies.map((body) => body.model)).toEqual(Array(3).fill("claude-sonnet-5-5"));
	});

	it("changes the compaction entry and the model in one configure", async () => {
		const { api } = await compactingWith(
			{ thinking: "high", compaction: { model: "claude-opus-5-5" } },
			{ model: "claude-haiku-5-5", compaction: { thinking: "low" } },
		);
		expect(api.bodies.map((body) => body.model)).toEqual(Array(3).fill("claude-haiku-5-5"));
		expect(api.bodies[1]?.output_config).toEqual({ effort: "low" });
	});

	it("prices the summary at the compaction model and the turn as the sum of both", async () => {
		const { events } = await compactingWith({ compaction: { model: "claude-opus-5-5" } });
		const [compacted] = ofType(events, "compaction_finished");
		const summaryCost = costOfRequest("claude-opus-5-5", { input: 100, output: 300, cacheRead: 2000, cacheWrite: 0 });
		expect(compacted?.costUsd).toBeCloseTo(summaryCost as number, 10);
		const [turn] = finished(events);
		const mainCost =
			(costOfRequest("claude-sonnet-5-5", { input: 2000, output: 1, cacheRead: 0, cacheWrite: 0 }) as number) +
			(costOfRequest("claude-sonnet-5-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }) as number);
		expect(turn).toMatchObject({ requests: 3 });
		expect((turn as { costUsd: number }).costUsd).toBeGreaterThan(summaryCost as number);
		expect((turn as { costUsd: number }).costUsd).toBeLessThan((summaryCost as number) + mainCost * 1.5);
	});
});

describe("AnthropicApiBackend saved sessions", () => {
	const history = [
		{ role: "user", content: [{ type: "text", text: "earlier question" }] },
		{ role: "assistant", content: [{ type: "text", text: "earlier answer" }], effort: "high" },
	] as never;

	it("answers no state before the first message, then its whole history", async () => {
		const { session } = await start([{ blocks: [{ type: "text", text: "Hello" }] }]);
		expect(session.resumeState?.()).toBeUndefined();
		await collect(session.send("Hi"));
		const state = session.resumeState?.();
		expect(state).toMatchObject({ messages: [{ role: "user" }, { role: "assistant" }] });
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
	});

	it("sends the saved history before the new prompt and keeps the effort an answer was asked with", async () => {
		const { session, api } = await start([{ blocks: [{ type: "text", text: "Again" }] }], undefined, {}, undefined, {
			resume: { messages: history },
		});
		await collect(session.send("next"));
		expect(withoutBreakpoints(messagesOf(api.bodies[0]))).toEqual([
			{ role: "user", content: [{ type: "text", text: "earlier question" }] },
			{ role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
			{ role: "user", content: [{ type: "text", text: "next" }] },
		]);
		const state = session.resumeState?.() as { messages: unknown[] };
		expect(state.messages).toHaveLength(4);
		expect(state.messages[1]).toMatchObject({ effort: "high" });
	});

	it("does not change the saved state it was given when it goes on", async () => {
		const given = JSON.parse(JSON.stringify(history));
		const { session } = await start([{ blocks: [{ type: "text", text: "Again" }] }], undefined, {}, undefined, {
			resume: { messages: given },
		});
		await collect(session.send("next"));
		expect(given).toEqual(JSON.parse(JSON.stringify(history)));
	});

	it("refuses a state that is not an anthropic-api history", async () => {
		await expect(start([], undefined, {}, undefined, { resume: { sessionId: "cc" } })).rejects.toThrow(
			"not an anthropic-api history",
		);
		await expect(
			start([], undefined, {}, undefined, { resume: { messages: [{ role: "system", content: "x" }] } }),
		).rejects.toThrow("not a user or assistant message");
	});
});
