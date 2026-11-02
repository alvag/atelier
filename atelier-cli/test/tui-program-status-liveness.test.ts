import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildProgramStatus, type ChildRecord } from "../src/tui/program-status-children.ts";

const ev = (body: AtelierEventBody, tag: { parentCallId?: string; agent?: string } = {}) =>
	({ ...body, ...tag, seq: 1, turnId: "t" }) as AtelierEvent;

describe("ChildProgramStatus liveness", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("repeats a blocked child on one unref'd heartbeat until it is answered, then stops quietly", () => {
		const records: ChildRecord[] = [];
		const status = new ChildProgramStatus((record) => records.push(record));
		const tag = { parentCallId: "p1", agent: "worker" };
		status.handle(
			ev({ type: "tool_call_started", callId: "p1", tool: "task", input: { agent: "worker", prompt: "x" } }),
		);
		status.handle(ev({ type: "tool_call_started", callId: "r1", tool: "read", input: {} }, tag));
		status.handle(ev({ type: "approval_requested", callId: "k1", command: "ls" }, tag));
		expect(records.map((r) => r.state)).toEqual(["working", "blocked"]);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(5 * 60_000);
		expect(records).toHaveLength(3);
		expect(records[2]).toEqual(records[1]);
		status.answered("k1");
		expect(records.at(-1)?.state).toBe("working");
		status.stop();
		expect(records.at(-1)?.state).toBe("clear");
		expect(vi.getTimerCount()).toBe(0);
		const count = records.length;
		vi.advanceTimersByTime(30 * 60_000);
		expect(records).toHaveLength(count);
	});
});
