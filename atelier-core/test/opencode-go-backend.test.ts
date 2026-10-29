import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendSession } from "../src/backend.ts";
import { createBackend } from "../src/backend-factory.ts";
import { OPENCODE_GO_BASE_URL, OPENCODE_GO_MODELS } from "../src/backends/opencode-go/models.ts";
import { SUMMARY_HEADINGS } from "../src/compaction/compactor.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { BACKEND_MODELS } from "../src/options.ts";
import { costOfRequest, thinkingToSend } from "../src/pricing.ts";
import type { ThinkingLevel } from "../src/thinking.ts";
import { VERSION } from "../src/version.ts";
import { FakeProvider, sse } from "./support/fake-provider.ts";

const KEY = `oc-${"test"}-key`;

let provider: FakeProvider;

beforeEach(async () => {
	provider = await FakeProvider.start();
});

afterEach(async () => {
	await provider.close();
});

/** A Messages API stream with one text block. */
function messagesReply(text: string, usage = { input: 1000, output: 20, cacheRead: 4000 }): { sse: string } {
	return {
		sse: sse(
			[
				{
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "x",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: usage.input,
							output_tokens: 1,
							cache_read_input_tokens: usage.cacheRead,
							cache_creation_input_tokens: 0,
						},
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: usage.output },
				},
				{ type: "message_stop" },
			],
			{ named: true },
		),
	};
}

/** A Messages API stream whose answer thinks twice: one block with a signature, one without. */
function thinkingReply(): { sse: string } {
	return {
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
						usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } },
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
				{ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Unsigned." } },
				{ type: "content_block_stop", index: 1 },
				{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Hello" } },
				{ type: "content_block_stop", index: 2 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 20 },
				},
				{ type: "message_stop" },
			],
			{ named: true },
		),
	};
}

async function start(
	options: { model?: string; thinking?: ThinkingLevel; maxTokens?: number } = {},
): Promise<BackendSession> {
	const backend = await createBackend("opencode-go", {
		resolveOpenCodeGoKey: async () => KEY,
		opencodeGo: {
			baseUrl: provider.url,
			maxRetries: 0,
			...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
		},
	});
	expect(backend.id).toBe("opencode-go");
	return backend.start({
		cwd: "/tmp",
		systemPromptAppend: "",
		tools: [],
		executeTool: async () => ({ ok: true, output: "" }),
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.thinking === undefined ? {} : { thinking: options.thinking }),
	});
}

async function collect(events: AsyncIterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const all: AtelierEventBody[] = [];
	for await (const event of events) all.push(event);
	return all;
}

describe("opencode-go on the Messages API", () => {
	it("runs minimax-m3 by default at OpenCode's Messages endpoint, with the key, its session and Atelier's agent", async () => {
		expect(OPENCODE_GO_BASE_URL).toBe("https://opencode.ai/inference/go");
		provider.answer(messagesReply("Hello"), messagesReply("Again"));
		const session = await start();
		const first = await collect(session.send("hi"));
		await collect(session.send("more"));

		expect(first[0]).toMatchObject({ type: "session_started", backend: "opencode-go", model: "minimax-m3" });
		expect(first).toContainEqual({ type: "text_delta", text: "Hello" });
		const finished = first.at(-1);
		expect(finished).toMatchObject({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1000, output: 20, cacheRead: 4000, cacheWrite: 0 },
			context: { window: 1_000_000 },
		});
		expect((finished as { costUsd?: number }).costUsd).toBeCloseTo((1000 * 0.3 + 20 * 1.2 + 4000 * 0.06) / 1e6, 12);

		const [one, two] = provider.received;
		expect(one?.path).toBe("/v1/messages");
		expect(one?.headers["x-api-key"]).toBe(KEY);
		expect(one?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(one?.headers["user-agent"]).toBe(`atelier/${VERSION}`);
		const conversation = one?.headers["x-opencode-session"];
		expect(conversation).toMatch(/^[0-9a-f-]{36}$/);
		expect(two?.headers["x-opencode-session"]).toBe(conversation);
		expect(one?.body.model).toBe("minimax-m3");
		// Anthropic's own fields stay out; the cache breakpoints stay in.
		expect(one?.body).not.toHaveProperty("diagnostics");
		expect(JSON.stringify(one?.body.system)).toContain("cache_control");
		// Only the models API was never asked: the window comes from the table.
		expect(provider.received.map(({ path }) => path)).toEqual(["/v1/messages", "/v1/messages"]);
	});

	it("gives each session its own conversation id", async () => {
		provider.answer(messagesReply("a"), messagesReply("b"));
		await collect((await start()).send("hi"));
		await collect((await start()).send("hi"));
		const [one, two] = provider.received;
		expect(one?.headers["x-opencode-session"]).not.toBe(two?.headers["x-opencode-session"]);
	});

	it("sends a level to minimax-m3 as enabled thinking with a budget, clipped to half of max_tokens", async () => {
		provider.answer(messagesReply("a"), messagesReply("b"), messagesReply("c"));
		const session = await start({ thinking: "high" });
		const events = await collect(session.send("hi"));
		expect(events[0]).toMatchObject({ type: "session_started", model: "minimax-m3", effort: "high" });
		expect(provider.received[0]?.body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
		expect(provider.received[0]?.body).not.toHaveProperty("output_config");
		await session.configure?.({ thinking: "low" });
		await collect(session.send("more"));
		expect(provider.received[1]?.body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
		await collect((await start({ thinking: "high", maxTokens: 3000 })).send("hi"));
		expect(provider.received[2]?.body.thinking).toEqual({ type: "enabled", budget_tokens: 1500 });
	});

	it("sends nothing for off on minimax-m3, which does not think without the field", async () => {
		provider.answer(messagesReply("a"));
		const off = await collect((await start({ thinking: "off" })).send("hi"));
		expect(off[0]).toMatchObject({ type: "session_started", model: "minimax-m3", effort: "off" });
		expect(provider.received[0]?.body).not.toHaveProperty("thinking");
		expect(provider.received[0]?.body).not.toHaveProperty("output_config");
	});

	it("reports auto for a model that reasons on its own, whatever was asked", async () => {
		provider.answer(messagesReply("a"), messagesReply("b"));
		const qwen = await collect((await start({ model: "qwen3.8-max", thinking: "high" })).send("hi"));
		expect(qwen[0]).toMatchObject({ type: "session_started", model: "qwen3.8-max", effort: "auto" });
		expect(provider.received[0]?.body).not.toHaveProperty("thinking");
		expect(provider.received[0]?.body).not.toHaveProperty("output_config");
		const off = await collect((await start({ model: "qwen3.8-flash", thinking: "off" })).send("hi"));
		expect(off[0]).toMatchObject({ type: "session_started", model: "qwen3.8-flash", effort: "auto" });
		expect(provider.received[1]?.body).not.toHaveProperty("thinking");
	});

	it("keeps the thinking blocks minimax-m3 returned in the history, and drops the unsigned ones", async () => {
		provider.answer(thinkingReply(), messagesReply("b"));
		const session = await start({ thinking: "high" });
		const events = await collect(session.send("hi"));
		expect(events).toContainEqual({ type: "thinking_delta", text: "Plan." });
		await collect(session.send("more"));
		const history = provider.received[1]?.body.messages as {
			role: string;
			content: { type: string; signature?: string }[];
		}[];
		const assistant = history.find((message) => message.role === "assistant");
		expect(assistant?.content.map(({ type, signature }) => [type, signature])).toEqual([
			["thinking", "sig"],
			["text", undefined],
		]);
	});

	it("asks the handoff summary with the same thinking budget", async () => {
		provider.answer(messagesReply("a"), messagesReply(SUMMARY_HEADINGS.join("\n")));
		const session = await start({ thinking: "high" });
		await collect(session.send("hi"));
		const summary = await session.summarize?.();
		expect(summary?.usage).toMatchObject({ input: 1000 });
		expect(provider.received[1]?.body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
		expect(provider.received[1]?.body.tool_choice).toEqual({ type: "none" });
	});

	it("sends a level only to the models that take one", async () => {
		provider.answer(messagesReply("a"), messagesReply("b"));
		await collect((await start({ thinking: "high" })).send("hi"));
		expect(provider.received[0]?.body).not.toHaveProperty("output_config");
		await collect((await start({ model: "claude-haiku-5-5", thinking: "high" })).send("hi"));
		expect(provider.received[1]?.body.output_config).toEqual({ effort: "high" });
	});
});

describe("the OpenCode Go models", () => {
	it("offers the table's models, minimax-m3 first, each with a price but where it depends on the hour", () => {
		expect(BACKEND_MODELS["opencode-go"]).toEqual(Object.keys(OPENCODE_GO_MODELS));
		expect(BACKEND_MODELS["opencode-go"][0]).toBe("minimax-m3");
		expect(BACKEND_MODELS["opencode-go"]).toEqual(
			expect.arrayContaining(["glm-5.3", "kimi-k3", "deepseek-v4-pro", "hy3"]),
		);
		const one = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
		const unpriced = BACKEND_MODELS["opencode-go"].filter((model) => costOfRequest(model, one) === undefined);
		expect(unpriced).toEqual(["deepseek-v4.1-flash", "deepseek-v4-pro"]);
		expect(costOfRequest("beam-free", one)).toBe(0);
		expect(costOfRequest("kimi-k3", { ...one, input: 1e6, output: 0 })).toBeCloseTo(3, 12);
	});

	it("sends the levels of Chat Completions models as reasoning_effort, and off where the model has a value for it", () => {
		expect(thinkingToSend("glm-5.3", "high", "opencode-go")).toEqual({ report: "high", effort: "high" });
		expect(thinkingToSend("glm-5.3", "medium", "opencode-go")).toEqual({ report: "medium not sent" });
		expect(thinkingToSend("hy3", "off", "opencode-go")).toEqual({ report: "off", thinking: "disabled" });
		expect(thinkingToSend("glm-5.3", "off", "opencode-go")).toEqual({ report: "off not sent" });
	});

	it("sends minimax-m3's levels as thinking budgets, and reports auto for the models that reason on their own", () => {
		expect(thinkingToSend("minimax-m3", "high", "opencode-go")).toEqual({ report: "high", budget: 16384 });
		expect(thinkingToSend("minimax-m3", "minimal", "opencode-go")).toEqual({ report: "low", budget: 2048 });
		expect(thinkingToSend("minimax-m3", "xhigh", "opencode-go")).toEqual({ report: "xhigh", budget: 16384 });
		expect(thinkingToSend("minimax-m3", "off", "opencode-go")).toEqual({ report: "off" });
		expect(thinkingToSend("qwen3.8-max", "high", "opencode-go")).toEqual({ report: "auto" });
		expect(thinkingToSend("qwen3.7-plus", "off", "opencode-go")).toEqual({ report: "auto" });
		expect(thinkingToSend("kimi-k2.7-code", "high", "opencode-go")).toEqual({ report: "auto" });
		expect(thinkingToSend("mimo-v2.6-flash", "off", "opencode-go")).toEqual({ report: "auto" });
		expect(thinkingToSend("longcat-2.0", "medium", "opencode-go")).toEqual({ report: "auto" });
	});

	it("prices qwen3.7-plus by its tier", () => {
		const big = { input: 200_000, output: 0, cacheRead: 100_000, cacheWrite: 0 };
		expect(costOfRequest("qwen3.7-plus", big)).toBeCloseTo((200_000 * 1.2 + 100_000 * 0.12) / 1e6, 12);
	});
});
