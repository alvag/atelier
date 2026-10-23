import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEventBody, FakeBackend, FakeMemory, type FakeStep, Session } from "../src/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const call = (tool: string, input: Record<string, unknown>, callId: string): FakeStep => ({
	toolCall: { tool, input: input as never, callId },
});
const START = {
	action: "start",
	name: "slug",
	title: "Slug",
	header: "",
	specs: ["S"],
	tasks: [
		{ title: "Write the parser", specs: ["S1"], route: "inline" },
		{ title: "Wire it", specs: ["S1"], route: "inline" },
	],
};

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-compaction-state-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

async function drain(events: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of events);
}

describe("the core's state after a compaction", () => {
	it("is absent without ODD and without memory", async () => {
		const backend = new FakeBackend([]);
		const session = await Session.start({ backend, cwd, tools: [] });
		expect(backend.startOptions?.compactionState?.()).toBeUndefined();
		await session.close();
	});

	it("gives the active feature, its current task, the phase and the memory of the first turn", async () => {
		const memory = new FakeMemory("proj");
		await memory.save({ title: "Earlier decision", type: "decision", content: "x" });
		const backend = new FakeBackend([
			[
				call("feature", START, "1"),
				call("feature", { action: "update_task", id: "T1", status: "in_progress" }, "2"),
				call("phase", { phase: "implementing" }, "3"),
				{ event: finished },
			],
		]);
		const session = await Session.start({ backend, cwd, tools: [], memory, odd: true });
		const state = backend.startOptions?.compactionState;
		expect(state?.()).toBe("<state>\nmemory:\n- [decision] Earlier decision\n</state>");
		await drain(session.send("start the parser"));
		expect(state?.()).toBe(
			[
				"<state>",
				'feature: odd/tasks/slug.md, task T1 "Write the parser" (in_progress)',
				"phase: implementing",
				"memory:",
				"- [decision] Earlier decision",
				"</state>",
			].join("\n"),
		);
		await session.close();
	});

	it("names the next pending task when none is in progress, with the inferred phase", async () => {
		const backend = new FakeBackend([[call("feature", START, "1"), { event: finished }]]);
		const session = await Session.start({ backend, cwd, tools: [], odd: true });
		await drain(session.send("go"));
		expect(backend.startOptions?.compactionState?.()).toBe(
			'<state>\nfeature: odd/tasks/slug.md, task T1 "Write the parser" (pending)\nphase: planning\n</state>',
		);
		await session.close();
	});
});
