import { describe, expect, it } from "vitest";
import {
	backgroundTaskCost,
	measuredTools,
	notingResponses,
	tallyBackground,
	tallyParentCalls,
} from "../scripts/delegation-calls.ts";
import type { ModelTransport } from "../src/backends/anthropic-api/transport.ts";
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
});

describe("the parent's background work in a measured session", () => {
	const task = (callId: string, prompt: string, background?: boolean) =>
		at({ type: "tool_call_started", callId, tool: "task", input: { agent: "worker", prompt, background } });
	const bash = (callId: string, command: string) =>
		at({ type: "tool_call_started", callId, tool: "bash", input: { command } });

	it("counts launches, the responses that made them, polls, applies and the checks after the last apply", () => {
		const events = [
			task("a", "add the option", true),
			task("b", "add the validation", true),
			at({ type: "tool_call_started", callId: "c", tool: "job_list", input: {} }),
			bash("d", "sleep 30"),
			bash("e", "node_modules/.bin/vitest run"),
			bash("f", "git -C /repo apply /tmp/task-1.patch"),
			bash("g", "git apply --check /tmp/task-2.patch"),
			bash("h", "git apply /tmp/task-2.patch"),
			bash("i", "node_modules/.bin/tsc -p . && node_modules/.bin/vitest run"),
			task("j", "add the option", true),
			task("k", "find where"),
			at({ type: "tool_call_started", callId: "x", tool: "job_list", input: {}, parentCallId: "a" }),
		];
		const requests = new Map([
			["a", 1],
			["b", 1],
			["j", 4],
		]);
		expect(tallyBackground(events, requests)).toEqual({
			backgroundLaunches: 3,
			foregroundTasks: 1,
			launchResponses: 2,
			relaunches: 1,
			polls: 2,
			applies: 2,
			checkRuns: 2,
			checksAfterLastApply: 1,
		});
	});

	it("counts the commands that run vitest, git apply or sleep, not those that only name them", () => {
		const tally = tallyBackground(
			[
				bash("a", "cat vitest.config.ts"),
				bash("b", "echo vitest; grep -n sleep src/a.ts"),
				bash("c", "git apply --check a.patch && git apply a.patch"),
				bash("d", "git log --grep apply"),
				bash("e", "cd /repo && CI=1 npx vitest run test/a.test.ts"),
				bash("f", "git -c core.x=y -C '/my repo' apply b.patch; sleep 5"),
			],
			new Map(),
		);
		expect(tally).toMatchObject({ applies: 2, checkRuns: 1, checksAfterLastApply: 0, polls: 1 });
	});

	it("counts nothing quoted or in a heredoc's body, and what runs after the heredoc", () => {
		const tally = tallyBackground(
			[
				bash("a", "echo 'example; sleep 30'"),
				bash("b", 'echo "run it: && node_modules/.bin/vitest run" | tee note.txt'),
				bash(
					"c",
					"cat <<'EOF' > run.sh\nnode_modules/.bin/vitest run\nsleep 3\ngit apply a.patch\nEOF\nnode_modules/.bin/vitest run",
				),
				bash("d", "cat <<-END > x\n\tsleep 1\n\tEND\nsleep 2"),
			],
			new Map(),
		);
		expect(tally).toMatchObject({ applies: 0, checkRuns: 1, checksAfterLastApply: 1, polls: 1 });
	});

	it("reads a here-string as no heredoc, and a quoted heredoc delimiter with spaces as one", () => {
		const tally = tallyBackground(
			[
				bash("a", 'cat <<< "hello"\nnode_modules/.bin/vitest run'),
				bash("b", "cat <<'END MARK' > x\nsleep 3\nnode_modules/.bin/vitest run\nEND MARK\nsleep 1"),
				bash("c", 'cat <<"A B"\nsleep 3\nA B\ngit apply a.patch'),
			],
			new Map(),
		);
		expect(tally).toMatchObject({ checkRuns: 1, polls: 1, applies: 1, checksAfterLastApply: 0 });
	});

	it("counts no launch response for a launch whose request is unknown, and nothing in an idle session", () => {
		expect(tallyBackground([task("a", "p", true)], new Map()).launchResponses).toBe(0);
		expect(tallyBackground([], new Map())).toEqual({
			backgroundLaunches: 0,
			foregroundTasks: 0,
			launchResponses: 0,
			relaunches: 0,
			polls: 0,
			applies: 0,
			checkRuns: 0,
			checksAfterLastApply: 0,
		});
	});
});

describe("the cost of the background tasks of a measured session", () => {
	const ended = (taskId: string, status: string, costUsd?: number) =>
		at({ type: "task_finished", taskId, status, ...(costUsd === undefined ? {} : { costUsd }) });

	it("sums what each background task cost when it ended", () => {
		expect(backgroundTaskCost([ended("task-1", "finished", 4), ended("task-2", "failed", 0.5)])).toBe(4.5);
		expect(backgroundTaskCost([])).toBe(0);
	});

	it("is unknown when one that ended did not say its cost, so the budget stops the measure", () => {
		expect(backgroundTaskCost([ended("task-1", "finished", 4), ended("task-2", "finished")])).toBeUndefined();
		expect(backgroundTaskCost([ended("task-1", "stopped")])).toBeUndefined();
	});
});

describe("a transport that notes which response made each tool call", () => {
	it("numbers the responses and notes each tool_use block's id under its response", async () => {
		const replies = [["a", "b"], [], ["c"]];
		const transport = {
			async *request() {
				yield { type: "text_delta" as const, text: "x" };
				return {
					content: (replies.shift() ?? []).map((id) => ({ type: "tool_use", id, name: "bash", input: {} })),
				};
			},
		} as unknown as ModelTransport;
		const requests = new Map<string, number>();
		const noted = notingResponses(transport, requests);
		const deltas: unknown[] = [];
		for (let i = 0; i < 3; i++) {
			const stream = noted.request({} as never);
			for (let next = await stream.next(); !next.done; next = await stream.next()) deltas.push(next.value);
		}
		expect(deltas).toHaveLength(3);
		expect([...requests]).toEqual([
			["a", 1],
			["b", 1],
			["c", 3],
		]);
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
