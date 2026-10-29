import { afterEach, describe, expect, it } from "vitest";
import { createBackend } from "../src/backend-factory.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";
import { FakeProvider, sse } from "./support/fake-provider.ts";

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const started = (model: string): FakeStep => ({
	event: { type: "session_started", backend: "fake", model, authSource: "none", effort: "high" },
});

/** A Messages API stream with one text block, as OpenCode Go answers. */
function messagesReply(text: string): { sse: string } {
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
						usage: {
							input_tokens: 1000,
							output_tokens: 1,
							cache_read_input_tokens: 0,
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
					usage: { output_tokens: 20 },
				},
				{ type: "message_stop" },
			],
			{ named: true },
		),
	};
}

async function collect(events: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

async function start(turns: FakeStep[][], options: Partial<SessionOptions> = {}) {
	const backend = new FakeBackend(turns);
	const session = await Session.start({ backend, cwd: "/work", tools: [], ...options });
	return { backend, session };
}

const configured = (events: AtelierEvent[]) => events.filter((event) => event.type === "session_configured");

describe("Session.configure", () => {
	it("hands a change between turns to the backend before the next prompt and answers the configuration", async () => {
		const { backend, session } = await start([[{ event: finished }], [{ event: finished }]], { model: "opus" });
		await collect(session.send("one"));
		const result = await session.configure({ model: "sonnet", thinking: "high" });
		expect(result).toEqual({
			backend: "fake",
			model: "sonnet",
			thinking: "high",
			permissionMode: "normal",
			pending: false,
		});
		expect(backend.configured).toEqual([{ model: "sonnet", thinking: "high" }]);
		await collect(session.send("two"));
		expect(backend.calls).toEqual(["send", "configure", "send"]);
	});

	it("says the configuration in the first event of the next turn, once", async () => {
		const { session } = await start([[{ event: finished }], [{ event: finished }], [{ event: finished }]]);
		await collect(session.send("one"));
		await session.configure({ thinking: "max" });
		const second = await collect(session.send("two"));
		expect(second[0]).toMatchObject({
			type: "session_configured",
			backend: "fake",
			thinking: "max",
			permissionMode: "normal",
		});
		expect(second[0]).not.toHaveProperty("model");
		expect(configured(await collect(session.send("three")))).toEqual([]);
	});

	it("says nothing when the session never changed", async () => {
		const { session } = await start([[{ event: finished }]], { model: "opus", thinking: "low" });
		expect(configured(await collect(session.send("one")))).toEqual([]);
	});

	it("says the permission mode change in the next turn", async () => {
		const { session } = await start([[{ event: finished }]], { model: "opus" });
		session.setPermissionMode("yolo");
		const events = await collect(session.send("one"));
		expect(configured(events)).toMatchObject([{ model: "opus", permissionMode: "yolo" }]);
		expect(configured(events)).toHaveLength(1);
	});

	it("keeps the model while only the level changes, and the other way round", async () => {
		const { backend, session } = await start([[{ event: finished }]], { model: "opus" });
		await session.configure({ thinking: "low" });
		expect(await session.configure({ model: "haiku" })).toMatchObject({ model: "haiku", thinking: "low" });
		expect(backend.configured).toEqual([{ thinking: "low" }, { model: "haiku" }]);
	});

	it("holds a change asked during a turn and applies it when the turn ends, never before", async () => {
		const { backend, session } = await start([[{ waitForInterrupt: true }], [{ event: finished }]], { model: "opus" });
		const running = collect(session.send("one"));
		for (let i = 0; i < 200 && !session.busy; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		const result = await session.configure({ model: "sonnet" });
		expect(result).toMatchObject({ model: "sonnet", pending: true });
		expect(backend.configured).toEqual([]);
		await session.interrupt();
		const events = await running;
		expect(backend.configured).toEqual([{ model: "sonnet" }]);
		// The event is in the turn that applied it, before its closing event.
		expect(events.map((event) => event.type).slice(-2)).toEqual(["session_configured", "turn_finished"]);
		expect(configured(events)).toMatchObject([{ model: "sonnet" }]);
		expect(configured(await collect(session.send("two")))).toEqual([]);
		expect(backend.calls).toEqual(["send", "configure", "send"]);
	});

	it("merges changes held during one turn", async () => {
		const { backend, session } = await start([[{ waitForInterrupt: true }]], { model: "opus" });
		const running = collect(session.send("one"));
		for (let i = 0; i < 200 && !session.busy; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		await session.configure({ model: "sonnet" });
		await session.configure({ thinking: "high" });
		await session.configure({ model: "haiku" });
		await session.interrupt();
		await running;
		expect(backend.configured).toEqual([{ model: "haiku", thinking: "high" }]);
	});

	it("refuses a change when the backend cannot take it, and changes nothing", async () => {
		const backend = new FakeBackend([[{ event: finished }]]);
		backend.configurable = false;
		const session = await Session.start({ backend, cwd: "/work", tools: [], model: "opus" });
		await expect(session.configure({ model: "sonnet" })).rejects.toMatchObject({
			code: "configure_unsupported",
			message: "The fake backend cannot change the model or the effort of an open session.",
		});
		const events = await collect(session.send("one"));
		expect(configured(events)).toEqual([]);
		expect(backend.configured).toEqual([]);
	});

	it("reports a backend that fails to apply the change, and keeps the old configuration", async () => {
		const backend = new FakeBackend([[{ event: finished }]]);
		const failing: FakeBackend = Object.assign(backend, {
			async start(options: Parameters<FakeBackend["start"]>[0]) {
				const inner = await FakeBackend.prototype.start.call(backend, options);
				return {
					...inner,
					async configure() {
						throw new Error("no such model");
					},
				};
			},
		});
		const session = await Session.start({ backend: failing, cwd: "/work", tools: [], model: "opus" });
		await expect(session.configure({ model: "nope" })).rejects.toMatchObject({
			code: "configure_failed",
			message: "no such model",
		});
		expect(configured(await collect(session.send("one")))).toEqual([]);
	});

	it("names the new model in the next turn's phases", async () => {
		const { session } = await start([[started("opus"), { event: finished }], [{ event: finished }]], {
			model: "opus",
		});
		await collect(session.send("one"));
		await session.configure({ model: "claude-sonnet-5-5" });
		const events = await collect(session.send("two"));
		const done = events.find((event) => event.type === "turn_finished");
		expect(done).toMatchObject({
			phases: { main: { agents: [{ role: "orchestrator", model: "claude-sonnet-5-5" }] } },
		});
	});

	describe("on claude-code", () => {
		afterEach(() => useModelData(new ModelData()));

		it("reports the level of the model an alias stands for, as the backend sends it", async () => {
			useModelData(
				new ModelData(
					{ "claude-code": [{ id: "claude-fable-5-1", aliases: ["fable"] }] },
					{ "claude-code": ["claude-fable-5-1"] },
					["claude-code"],
				),
			);
			const backend = new FakeBackend(
				[
					[
						{
							event: { type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "none" },
						},
						{ event: finished },
					],
					[{ event: finished }],
				],
				"claude-code",
			);
			const session = await Session.start({ backend, cwd: "/work", tools: [], model: "claude-opus-5-5" });
			await collect(session.send("one"));
			await session.configure({ model: "fable", thinking: "xhigh" });
			const events = await collect(session.send("two"));
			expect(configured(events)).toMatchObject([{ model: "fable", thinking: "xhigh" }]);
			expect(events.find((event) => event.type === "turn_finished")).toMatchObject({
				phases: { main: { agents: [{ role: "orchestrator", model: "fable", effort: "xhigh" }] } },
			});
		});
	});

	describe("on opencode-go, when the thinking budget does not fit the output budget", () => {
		it("labels the turn parts with the effort the backend reports, not the level asked", async () => {
			const provider = await FakeProvider.start();
			try {
				provider.answer(messagesReply("a"), messagesReply("b"));
				const backend = await createBackend("opencode-go", {
					resolveOpenCodeGoKey: async () => `oc-${"test"}-key`,
					opencodeGo: { baseUrl: provider.url, maxRetries: 0, maxTokens: 1000 },
				});
				const session = await Session.start({
					backend,
					cwd: "/work",
					tools: [],
					model: "minimax-m3",
					thinking: "high",
				});
				const one = await collect(session.send("one"));
				const announced = one.find((event) => event.type === "session_started");
				// Half of 1000 tokens cannot hold even the smallest budget, so the level is not sent at all.
				expect(announced).toMatchObject({ effort: "high not sent" });
				await session.configure({ thinking: "high" });
				const two = await collect(session.send("two"));
				const done = two.find((event) => event.type === "turn_finished");
				expect(done).toMatchObject({
					phases: { main: { agents: [{ role: "orchestrator", model: "minimax-m3", effort: "high not sent" }] } },
				});
				// The same label `session_started` said, not one computed apart from the backend.
				expect(done?.phases?.main?.agents?.[0]?.effort).toBe(announced?.effort);
			} finally {
				await provider.close();
			}
		});
	});
});
