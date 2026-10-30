import { describe, expect, it } from "vitest";
import { measuredTools, tallyParentCalls } from "../scripts/delegation-calls.ts";
import type { AtelierEvent } from "../src/index.ts";
import { defineTool } from "../src/tools/types.ts";

let seq = 0;
const at = (body: object) => ({ seq: seq++, turnId: "t1", ...body }) as AtelierEvent;
const started = (callId: string, tool: string, parentCallId?: string) =>
	at({ type: "tool_call_started", callId, tool, input: {}, ...(parentCallId ? { parentCallId } : {}) });
const finished = (callId: string, ok = true, parentCallId?: string) =>
	at({
		type: "tool_call_finished",
		callId,
		ok,
		summary: "",
		truncated: false,
		...(parentCallId ? { parentCallId } : {}),
	});
/** A parent call that ran and finished. */
const call = (callId: string, tool: string, ok = true) => [started(callId, tool), finished(callId, ok)];

describe("the parent's calls in a measured turn", () => {
	it("counts reads before and after the first task, and the first tool", () => {
		const events = [
			...call("a", "grep"),
			...call("b", "read"),
			started("c", "task"),
			...call("x", "read").map((event) => ({ ...event, parentCallId: "c" }) as AtelierEvent),
			finished("c"),
			...call("d", "read"),
			...call("e", "bash"),
		];
		const tally = tallyParentCalls(events, new Map());
		expect(tally.firstTool).toBe("grep");
		expect(tally.tools).toEqual({ grep: 1, read: 2, task: 1, bash: 1 });
		expect(tally.readsBeforeTask).toBe(2);
		expect(tally.readsAfterTask).toBe(1);
	});

	it("has no first tool and no reads after a task when the parent called none", () => {
		const tally = tallyParentCalls([], new Map());
		expect(tally.firstTool).toBeUndefined();
		expect(tally.readsBeforeTask).toBe(0);
		expect(tally.readsAfterTask).toBe(0);
		expect(tally.noticeDue).toBe(false);
	});

	it("sums the characters of the reads that succeeded before any task, and counts no subagent's", () => {
		const events = [
			...call("a", "read"),
			...call("b", "grep", false),
			started("x", "read", "c"),
			finished("x", true, "c"),
			...call("d", "task"),
			...call("e", "read"),
		];
		const chars = new Map([
			["a", 1000],
			["b", 500],
			["x", 9000],
			["e", 7000],
		]);
		expect(tallyParentCalls(events, chars).readCharsBeforeTask).toBe(1000);
	});

	it("says the notice is due once five reads that succeeded pass 40,000 characters", () => {
		const five = ["a", "b", "c", "d", "e"].flatMap((id) => call(id, id === "a" ? "grep" : "read"));
		const chars = (each: number) => new Map(["a", "b", "c", "d", "e"].map((id) => [id, each]));
		expect(tallyParentCalls(five, chars(8000)).noticeDue).toBe(true);
		expect(tallyParentCalls(five, chars(7999)).noticeDue).toBe(false);
		expect(tallyParentCalls(five.slice(2), chars(20_000)).noticeDue).toBe(false);
		expect(tallyParentCalls([...five.slice(0, 8), ...call("f", "read", false)], chars(20_000)).noticeDue).toBe(false);
	});

	it("never has the notice due after a task, an edit or a write in the turn", () => {
		const reads = (ids: string[]) => ids.flatMap((id) => call(id, "read"));
		const chars = new Map(["a", "b", "c", "d", "e", "f"].map((id) => [id, 10_000]));
		for (const tool of ["task", "edit", "write"])
			expect(tallyParentCalls([...call("z", tool), ...reads(["a", "b", "c", "d", "e"])], chars).noticeDue).toBe(false);
		expect(tallyParentCalls([...reads(["a", "b", "c", "d", "e"]), ...call("z", "edit")], chars).noticeDue).toBe(true);
	});
});

describe("tools measured for a delegation run", () => {
	it("records how many characters each call's output gave the model, by call id", async () => {
		const tool = defineTool({
			name: "read",
			description: "Reads",
			inputShape: {},
			execute: async () => ({ ok: true, output: "twelve chars", summary: "s", truncated: false }),
		});
		const chars = new Map<string, number>();
		const [measured] = measuredTools([tool], chars);
		const outcome = await measured?.execute({}, { cwd: "/", callId: "c1" });
		expect(outcome?.output).toBe("twelve chars");
		expect(measured?.name).toBe("read");
		expect(chars.get("c1")).toBe(12);
	});
});
