import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildProgramStatus, type ChildRecord } from "../src/tui/program-status-children.ts";

let seq = 0;
const ev = (body: AtelierEventBody) => ({ ...body, seq: ++seq, turnId: "t" }) as AtelierEvent;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const started = (taskId: string, label = "build it", agent = "worker") =>
	ev({ type: "task_started", taskId, agent, label, outputPath: "/tmp/o", running: 1 });
const finished = (taskId: string, status: "finished" | "failed" | "stopped") =>
	ev({
		type: "task_finished",
		taskId,
		agent: "worker",
		label: "x",
		status,
		durationMs: 1,
		outputPath: "/tmp/o",
		notified: true,
		running: 0,
		waiting: 0,
	});
const rootDone = () => ev({ type: "turn_finished", stopReason: "end_turn", usage });
const rootStart = () =>
	ev({ type: "session_started", backend: "b", model: "m", authSource: "api_key" } as AtelierEventBody);
const FIVE_MIN = 5 * 60_000;

function setup() {
	const records: ChildRecord[] = [];
	const status = new ChildProgramStatus((record) => records.push(record));
	const feed = (...events: AtelierEvent[]) => {
		for (const event of events) status.handle(event);
	};
	return { records, status, feed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ChildProgramStatus background tasks", () => {
	it("tells a background task with a generated id and a bounded label", () => {
		const { records, feed } = setup();
		feed(started("secret-task-id", `${"é".repeat(200)}\nsecond`));
		expect(records).toHaveLength(1);
		const [record] = records;
		expect(record?.state).toBe("working");
		expect(record?.id).toMatch(/^[a-z0-9]+$/);
		expect(record?.id).not.toContain("secret");
		expect(Buffer.byteLength(record?.title ?? "")).toBeLessThanOrEqual(192);
		expect(record?.title).not.toContain("second");
	});

	it("maps finished to done, failed to error and stopped to clear", () => {
		const { records, feed } = setup();
		feed(started("a"), started("b"), started("c"));
		feed(finished("a", "finished"), finished("b", "failed"), finished("c", "stopped"));
		const ends = records.slice(3);
		expect(ends.map((r) => r.state)).toEqual(["done", "error", "clear"]);
		expect(ends.map((r) => r.id)).toEqual(records.slice(0, 3).map((r) => r.id));
		expect(ends[2]).toEqual({ state: "clear", id: records[2]?.id });
	});

	it("does not duplicate a task call started in the background", () => {
		const { records, feed } = setup();
		feed(
			ev({
				type: "tool_call_started",
				callId: "p1",
				tool: "task",
				input: { agent: "w", prompt: "x", background: true },
			}),
		);
		feed(started("t1"));
		feed(ev({ type: "tool_call_finished", callId: "p1", ok: true, summary: "", truncated: false }));
		expect(records.map((r) => r.state)).toEqual(["working"]);
	});

	it("keeps a background task through the root turn ending and refreshes it every five minutes", () => {
		const { records, feed } = setup();
		feed(started("a"), rootDone());
		expect(records).toHaveLength(1);
		vi.advanceTimersByTime(FIVE_MIN - 1);
		expect(records).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(records).toHaveLength(2);
		expect(records[1]).toEqual(records[0]);
		vi.advanceTimersByTime(FIVE_MIN * 3);
		expect(records).toHaveLength(5);
	});

	it("keeps a background task through a root error", () => {
		const { records, feed } = setup();
		feed(started("a"), ev({ type: "error", message: "boom" } as AtelierEventBody));
		expect(records.map((r) => r.state)).toEqual(["working"]);
	});

	it("stops the heartbeat when the last task finishes", () => {
		const { records, feed } = setup();
		feed(started("a"), finished("a", "finished"));
		vi.advanceTimersByTime(FIVE_MIN * 3);
		expect(records.map((r) => r.state)).toEqual(["working", "done"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses one timer for several tasks and refreshes each", () => {
		const { records, feed } = setup();
		feed(started("a"), started("b"));
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(FIVE_MIN);
		expect(records).toHaveLength(4);
	});

	it("tells nothing after stop or reset, and a late task_finished does not resurrect", () => {
		const { records, status, feed } = setup();
		feed(started("a"));
		status.stop();
		expect(records.map((r) => r.state)).toEqual(["working", "clear"]);
		vi.advanceTimersByTime(FIVE_MIN * 2);
		feed(finished("a", "finished"));
		expect(records).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
		feed(started("b"));
		status.reset();
		vi.advanceTimersByTime(FIVE_MIN * 2);
		expect(records).toHaveLength(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears told done records at the next root start but keeps running ones", () => {
		const { records, feed } = setup();
		feed(started("a"), started("b"), finished("a", "finished"));
		feed(rootStart());
		expect(records.slice(3)).toEqual([{ state: "clear", id: records[0]?.id }]);
		vi.advanceTimersByTime(FIVE_MIN);
		expect(records.at(-1)).toEqual(records[1]);
	});

	it("keeps at most 256 known records over many sequential tasks", () => {
		const { records, feed } = setup();
		for (let i = 0; i < 600; i++) feed(started(`t${i}`), finished(`t${i}`, "finished"));
		const live = new Set<string>();
		for (const r of records) {
			if (r.state === "clear") live.delete(r.id);
			else live.add(r.id);
			expect(live.size).toBeLessThanOrEqual(256);
		}
		expect(live.size).toBe(256);
	});

	it("refuses to track more than 256 running tasks instead of telling an untracked state", () => {
		const { records, feed } = setup();
		for (let i = 0; i < 260; i++) feed(started(`t${i}`));
		expect(records).toHaveLength(256);
		feed(finished("t259", "finished"));
		expect(records).toHaveLength(256);
	});
});
