import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BackendSession, ToolCall, ToolCallResult } from "../src/backend.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "../src/backends/anthropic-api/backend.ts";
import type { AtelierEventBody } from "../src/events.ts";
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
function fakeApi(script: Scripted[]) {
	const bodies: Record<string, unknown>[] = [];
	const headers: Headers[] = [];
	const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
	return { fetch: fetch as typeof globalThis.fetch, bodies, headers };
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
			},
		]);
		const body = api.bodies[0];
		expect(body?.model).toBe("claude-sonnet-5-5");
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
