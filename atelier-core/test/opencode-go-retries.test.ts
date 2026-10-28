import { describe, expect, it } from "vitest";
import type { BackendSession } from "../src/backend.ts";
import { AnthropicApiBackend } from "../src/backends/anthropic-api/backend.ts";
import { createOpenCodeGoBackend } from "../src/backends/opencode-go/backend.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { sse } from "./support/fake-provider.ts";

// No server: each test answers through an injected fetch, so nothing listens on a port.
const KEY = `oc-${"test"}-key`;
const BASE = "https://provider.invalid/go";

type Fetch = typeof globalThis.fetch;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const usageLimit = () =>
	json(
		429,
		{ type: "error", error: { type: "rate_limit_error", message: "Monthly usage limit reached" } },
		{
			"retry-after-ms": "1",
		},
	);

const chatReply = () =>
	new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }], { done: true }), {
		headers: { "content-type": "text/event-stream" },
	});

const messagesReply = () =>
	new Response(
		sse(
			[
				{
					type: "message_start",
					message: {
						id: "msg",
						type: "message",
						role: "assistant",
						model: "m",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 0 },
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
		{ headers: { "content-type": "text/event-stream" } },
	);

/** A stream whose connection fails: before its first byte, or after one chunk of an answer. */
function cutStream(afterFirstChunk: boolean): Response {
	let sent = false;
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (afterFirstChunk && !sent) {
					sent = true;
					controller.enqueue(new TextEncoder().encode(sse([{ choices: [{ delta: { content: "par" } }] }])));
					return;
				}
				controller.error(new TypeError("connection reset"));
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

/** A fetch that answers in turn and counts the requests. */
function scripted(...answers: (() => Response)[]): { fetch: Fetch; count: () => number } {
	let count = 0;
	return {
		fetch: (async () => {
			const answer = answers[Math.min(count, answers.length - 1)];
			count++;
			return (answer as () => Response)();
		}) as Fetch,
		count: () => count,
	};
}

async function start(fetch: Fetch, model: string, ran: unknown[] = []): Promise<BackendSession> {
	return createOpenCodeGoBackend({ apiKey: KEY, fetch, model, baseUrl: BASE }).start({
		cwd: "/tmp",
		systemPromptAppend: "",
		tools: [],
		executeTool: async (call) => {
			ran.push(call);
			return { ok: true, output: "" };
		},
	});
}

async function collect(events: AsyncIterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const all: AtelierEventBody[] = [];
	for await (const event of events) all.push(event);
	return all;
}

const errorOf = (events: AtelierEventBody[]) => events.find((event) => event.type === "error");

describe("a spent OpenCode Go plan", () => {
	it("is asked once on the Messages API models, whether it says 429 with the limit or 402", async () => {
		for (const answer of [
			usageLimit,
			() => json(402, { error: { type: "billing_error", message: "Insufficient balance" } }),
		]) {
			const provider = scripted(answer);
			const events = await collect((await start(provider.fetch, "minimax-m3")).send("hi"));
			expect(errorOf(events)).toMatchObject({ code: "quota_exceeded", recoverable: false });
			expect(provider.count()).toBe(1);
		}
	});

	it("is asked once on the Chat Completions models", async () => {
		const provider = scripted(usageLimit);
		const events = await collect((await start(provider.fetch, "glm-5.3")).send("hi"));
		expect(errorOf(events)).toMatchObject({ code: "quota_exceeded", recoverable: false });
		expect(provider.count()).toBe(1);
	});

	it("leaves a plain rate limit retried on the Messages API models", async () => {
		const provider = scripted(
			() => json(429, { error: { message: "Too many requests" } }, { "retry-after-ms": "1" }),
			messagesReply,
		);
		const events = await collect((await start(provider.fetch, "minimax-m3")).send("hi"));
		expect(events).toContainEqual({ type: "text_delta", text: "ok" });
		expect(provider.count()).toBe(2);
	});

	it("does not change anthropic-api, whose SDK still retries a 429 whatever it says", async () => {
		const provider = scripted(usageLimit, messagesReply);
		const backend = new AnthropicApiBackend({
			apiKey: KEY,
			fetch: provider.fetch,
			maxRetries: 1,
			contextWindow: 200_000,
		});
		const session = await backend.start({
			cwd: "/tmp",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		const events = await collect(session.send("hi"));
		expect(events).toContainEqual({ type: "text_delta", text: "ok" });
		expect(provider.count()).toBe(2);
	});
});

describe("a Chat Completions connection lost", () => {
	it("before the body's first byte is tried again, up to twice", async () => {
		const provider = scripted(
			() => cutStream(false),
			() => cutStream(false),
			chatReply,
		);
		const events = await collect((await start(provider.fetch, "glm-5.3")).send("hi"));
		expect(events).toContainEqual({ type: "text_delta", text: "ok" });
		expect(provider.count()).toBe(3);
	});

	it("before the first byte three times fails the turn after the two retries", async () => {
		const provider = scripted(() => cutStream(false));
		const events = await collect((await start(provider.fetch, "glm-5.3")).send("hi"));
		expect(errorOf(events)).toMatchObject({ code: "api_error", recoverable: true });
		expect(provider.count()).toBe(3);
	});

	it("after the first byte is never tried again, and leaves nothing of the cut answer behind", async () => {
		const provider = scripted(() => cutStream(true), chatReply);
		const ran: unknown[] = [];
		const session = await start(provider.fetch, "glm-5.3", ran);
		const events = await collect(session.send("hi"));
		expect(events).toContainEqual({ type: "text_delta", text: "par" });
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
		expect(provider.count()).toBe(1);
		expect(ran).toEqual([]);
		expect(JSON.stringify(session.resumeState?.())).not.toContain("par");
	});

	it("before the answer's headers is tried again exactly twice", async () => {
		let count = 0;
		const offline = (async () => {
			count++;
			if (count < 3) throw new TypeError("offline");
			return chatReply();
		}) as Fetch;
		const events = await collect((await start(offline, "glm-5.3")).send("hi"));
		expect(count).toBe(3);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	});
});
