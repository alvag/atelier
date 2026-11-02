import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { describe, expect, it, vi } from "vitest";
import { ChildProgramStatus, type ChildRecord, REFRESH_MS } from "../src/tui/program-status-children.ts";

let seq = 0;
const ev = (body: AtelierEventBody, tag: { parentCallId?: string; agent?: string } = {}) =>
	({ ...body, ...tag, seq: ++seq, turnId: "t" }) as AtelierEvent;
const taskCall = (callId: string, input: Record<string, unknown>) =>
	ev({ type: "tool_call_started", callId, tool: "task", input } as AtelierEventBody);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const turn = (stopReason: string, tag?: { parentCallId?: string; agent?: string }) =>
	ev({ type: "turn_finished", stopReason, usage }, tag);
const taskFinished = (callId: string, ok: boolean) =>
	ev({ type: "tool_call_finished", callId, ok, summary: "", truncated: false });
const note = (parentCallId: string, agent: string) =>
	ev({ type: "tool_call_started", callId: `c-${seq}`, tool: "read", input: {} }, { parentCallId, agent });

function setup() {
	const records: ChildRecord[] = [];
	const status = new ChildProgramStatus((record) => records.push(record));
	const feed = (...events: AtelierEvent[]) => {
		for (const event of events) status.handle(event);
	};
	const states = () => records.map((record) => record.state);
	return { records, status, feed, states };
}

describe("ChildProgramStatus", () => {
	it("keeps a task working through its internal turn_finished and closes on the outer call", () => {
		const { feed, states } = setup();
		feed(taskCall("p1", { agent: "worker", prompt: "x" }), note("p1", "worker"));
		feed(turn("end_turn", { parentCallId: "p1", agent: "worker" }));
		expect(states()).toEqual(["working"]);
		feed(taskFinished("p1", true));
		expect(states()).toEqual(["working", "done"]);
	});

	it("starts nothing for a call that failed validation or runs in the background", () => {
		const { records, feed } = setup();
		feed(taskCall("p1", { agent: "nope", prompt: "x" }), taskFinished("p1", false));
		feed(taskCall("p2", { agent: "worker", prompt: "x", background: true, label: "bg" }), note("p2", "worker"));
		feed(taskFinished("p2", true));
		expect(records).toEqual([]);
	});

	it("tracks review roles with the same parent apart and closes them by their own turn", () => {
		const { records, feed } = setup();
		const a = { parentCallId: "r1", agent: "review:security#1" };
		const b = { parentCallId: "r1", agent: "review:security#2" };
		const c = { parentCallId: "r1", agent: "review:refuter" };
		feed(note("r1", a.agent), note("r1", b.agent), note("r1", c.agent));
		const ids = records.map((record) => record.id);
		expect(new Set(ids).size).toBe(3);
		expect(records.every((record) => record.id.startsWith("review"))).toBe(true);
		feed(turn("end_turn", a), turn("max_tokens", b));
		expect(records.slice(3).map((r) => [r.id, r.state])).toEqual([
			[ids[0], "done"],
			[ids[1], "error"],
		]);
		feed(ev({ type: "review_finished", reviewId: "r1", verdict: "pass", findings: [] } as unknown as AtelierEventBody));
		expect(records.at(-1)).toMatchObject({ id: ids[2], state: "done" });
	});

	it("gives a rerun of the same role a new generation and closes a verifier at verification_finished", () => {
		const { records, feed } = setup();
		const v = { parentCallId: "v1", agent: "verify:verifier" };
		feed(note("v1", v.agent), turn("end_turn", v));
		feed(ev({ type: "session_started" } as unknown as AtelierEventBody, v));
		expect(records.map((r) => r.state)).toEqual(["working", "done", "working"]);
		expect(records[2]?.id).not.toBe(records[0]?.id);
		feed(ev({ type: "verification_finished", verifyId: "v1" } as unknown as AtelierEventBody));
		expect(records.at(-1)).toMatchObject({ id: records[2]?.id, state: "done" });
	});

	it("blocks on a permission and a question, and one answer does not resume the other", () => {
		const { records, status, feed } = setup();
		const tag = { parentCallId: "p1", agent: "worker" };
		feed(taskCall("p1", { agent: "worker", prompt: "x" }), note("p1", "worker"));
		feed(ev({ type: "approval_requested", callId: "k1", command: "ls" }, tag));
		feed(ev({ type: "user_question_requested", callId: "k2", questions: [] }, tag));
		expect(records.slice(1).map((r) => [r.state, r.kind])).toEqual([
			["blocked", "permission"],
			["blocked", "question"],
		]);
		feed(
			ev({ type: "user_question_resolved", callId: "k2", result: { status: "cancelled" } } as AtelierEventBody, tag),
		);
		expect(records.at(-1)).toMatchObject({ state: "blocked", kind: "permission" });
		status.answered("k1");
		expect(records.at(-1)).toMatchObject({ state: "working" });
		const count = records.length;
		status.answered("k1");
		status.answered("unknown");
		expect(records).toHaveLength(count);
		feed(taskFinished("p1", true));
		status.answered("k1");
		expect(records.at(-1)).toMatchObject({ state: "done" });
		expect(records).toHaveLength(count + 1);
	});

	it("closes what remains when the root turn is interrupted or fails", () => {
		const { feed, states } = setup();
		feed(taskCall("p1", { agent: "worker", prompt: "x" }), note("p1", "worker"), turn("interrupted"));
		feed(taskCall("p2", { agent: "worker", prompt: "x" }), note("p2", "worker"));
		feed(ev({ type: "error", code: "x", message: "y", recoverable: false }));
		expect(states()).toEqual(["working", "clear", "working", "error"]);
	});

	it("bounds a multibyte label in UTF-8 bytes and strips controls", () => {
		const { records, feed } = setup();
		feed(taskCall("p1", { agent: "worker", prompt: `‮${"漢".repeat(200)}\u0007` }), note("p1", "worker"));
		const title = records[0]?.title as string;
		expect(Buffer.byteLength(title)).toBeLessThanOrEqual(192);
		expect(title).toMatch(/^漢+…$/);
	});

	it("generates nested ids from a tagged task call and clears children before parents", () => {
		const { records, status, feed } = setup();
		feed(taskCall("p1", { agent: "worker", prompt: "outer" }), note("p1", "worker"));
		feed(
			ev(
				{ type: "tool_call_started", callId: "n1", tool: "task", input: { agent: "explorer", prompt: "inner" } },
				{ parentCallId: "p1", agent: "worker" },
			),
		);
		feed(note("n1", "explorer"));
		const [outer, inner] = records;
		expect(inner?.id).toMatch(new RegExp(`^${outer?.id}/task[0-9a-z]+$`));
		expect(inner?.id.split("/").length).toBeLessThanOrEqual(8);
		expect(inner?.id.length).toBeLessThanOrEqual(128);
		const before = records.length;
		status.stop();
		expect(records.slice(before).map((r) => [r.id, r.state])).toEqual([
			[inner?.id, "clear"],
			[outer?.id, "clear"],
		]);
		status.stop();
		expect(records).toHaveLength(before + 2);
	});

	it("keeps a restarted role of the same key live through the sweep of its old generation", () => {
		vi.useFakeTimers();
		try {
			const { records, feed } = setup();
			const tag = { parentCallId: "r1", agent: "review:refuter" };
			feed(note(tag.parentCallId, tag.agent), turn("end_turn", tag));
			feed(
				ev({ type: "session_started" } as unknown as AtelierEventBody, tag),
				ev({ type: "session_started" } as unknown as AtelierEventBody),
			);
			const before = records.length;
			vi.advanceTimersByTime(REFRESH_MS);
			expect(records.slice(before)).toMatchObject([{ state: "working" }]);
			feed(turn("end_turn", tag));
			expect(records.at(-1)?.state).toBe("done");
		} finally {
			vi.useRealTimers();
		}
	});

	it("forgets the title of a task call that never delivered its result at the root turn end", () => {
		const { records, feed } = setup();
		feed(taskCall("p1", { agent: "worker", prompt: "stale" }), turn("end_turn"));
		feed(note("p1", "worker"));
		expect(records.at(-1)?.title).toBe("worker");
	});

	it("caps nested ids at eight segments and 128 characters", () => {
		const { records, feed } = setup();
		feed(taskCall("c0", { agent: "a", prompt: "x" }), note("c0", "a"));
		for (let level = 1; level <= 9; level++) {
			const tag = { parentCallId: `c${level - 1}`, agent: "a" };
			feed(
				ev({ type: "tool_call_started", callId: `c${level}`, tool: "task", input: { agent: "a", prompt: "x" } }, tag),
			);
			feed(note(`c${level}`, "a"));
		}
		const ids = records.map((record) => record.id);
		expect(ids.length).toBeGreaterThanOrEqual(9);
		for (const id of ids) {
			expect(id.split("/").length).toBeLessThanOrEqual(8);
			expect(id.length).toBeLessThanOrEqual(128);
			for (const part of id.split("/")) expect(part.length).toBeLessThanOrEqual(32);
		}
	});

	it("reset forgets records without telling anything", () => {
		const { records, status, feed } = setup();
		feed(taskCall("p1", { agent: "worker", prompt: "x" }), note("p1", "worker"));
		status.reset();
		status.stop();
		expect(records).toHaveLength(1);
	});
});
