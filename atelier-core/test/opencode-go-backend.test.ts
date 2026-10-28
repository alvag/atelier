import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendSession } from "../src/backend.ts";
import { createBackend } from "../src/backend-factory.ts";
import { OPENCODE_GO_BASE_URL, OPENCODE_GO_MODELS } from "../src/backends/opencode-go/models.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { BACKEND_MODELS } from "../src/options.ts";
import { costOfRequest } from "../src/pricing.ts";
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

async function start(options: { model?: string; thinking?: "high" } = {}): Promise<BackendSession> {
	const backend = await createBackend("opencode-go", {
		resolveOpenCodeGoKey: async () => KEY,
		opencodeGo: { baseUrl: provider.url, maxRetries: 0 },
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

	it("sends a level only to the models that take one", async () => {
		provider.answer(messagesReply("a"), messagesReply("b"));
		const minimax = await collect((await start({ thinking: "high" })).send("hi"));
		expect(minimax[0]).toMatchObject({ type: "session_started", effort: "unsupported" });
		await collect((await start({ model: "claude-haiku-5-5", thinking: "high" })).send("hi"));
		expect(provider.received[0]?.body).not.toHaveProperty("output_config");
		expect(provider.received[1]?.body.output_config).toEqual({ effort: "high" });
	});
});

describe("the OpenCode Go models", () => {
	it("offers the table's models, minimax-m3 first, each with a price", () => {
		expect(BACKEND_MODELS["opencode-go"]).toEqual(Object.keys(OPENCODE_GO_MODELS));
		expect(BACKEND_MODELS["opencode-go"][0]).toBe("minimax-m3");
		for (const model of BACKEND_MODELS["opencode-go"])
			expect(costOfRequest(model, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeGreaterThan(0);
	});

	it("prices qwen3.7-plus by its tier", () => {
		const big = { input: 200_000, output: 0, cacheRead: 100_000, cacheWrite: 0 };
		expect(costOfRequest("qwen3.7-plus", big)).toBeCloseTo((200_000 * 1.2 + 100_000 * 0.12) / 1e6, 12);
	});
});
