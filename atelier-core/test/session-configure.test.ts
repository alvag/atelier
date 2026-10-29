import { afterEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const started = (model: string): FakeStep => ({
	event: { type: "session_started", backend: "fake", model, authSource: "none", effort: "high" },
});

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
});
