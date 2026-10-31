import type { SavedEntry, ShellResult } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { savedTranscript } from "../src/transcript.ts";

const prompt: SavedEntry = { type: "prompt", turnId: "t", text: "work" };
const text = (value: string): SavedEntry => ({ type: "text", turnId: "t", text: value });
const result: ShellResult = {
	executionId: "s1",
	command: "printf hi",
	output: "hi",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	excludeFromContext: false,
};
const shell: SavedEntry = { type: "shell_result", result };
const tool: SavedEntry = {
	type: "event",
	event: { type: "tool_call_started", turnId: "t", seq: 1, callId: "c1", tool: "bash", input: {} },
};
const restore = (...entries: SavedEntry[]) => savedTranscript("saved", undefined, entries);

describe("saved answer segments", () => {
	it("joins incremental segments of an answer separated by a shell result", () => {
		expect(restore(prompt, text("Visible before shell."), shell, text(" Visible after shell."))).toContain(
			"Visible before shell. Visible after shell.\n",
		);
	});

	it("treats repeated prefixes as new text, not cumulative snapshots", () => {
		expect(restore(prompt, text("ha"), shell, text("ha!"))).toContain("haha!\n");
	});

	it("joins continuations across multiple shell results", () => {
		const second: SavedEntry = { type: "shell_result", result: { ...result, executionId: "s2" } };
		expect(restore(prompt, text("A"), shell, text("B"), second, text("C"))).toContain("ABC\n");
	});

	it("keeps the final-answer reading of legacy version-1 turns without shell results", () => {
		expect(restore(prompt, text("I will inspect it."), tool, text("Done."))).toBe(
			"resumed session saved: 1 turn\n> work\nDone.\n",
		);
		expect(restore(prompt, text("Done."))).toBe("resumed session saved: 1 turn\n> work\nDone.\n");
	});

	it("does not join a new response after a tool call to the preceding response", () => {
		const restored = restore(prompt, text("I will inspect it."), shell, tool, text("Done."));
		expect(restored).toContain("Done.\n");
		expect(restored).not.toContain("I will inspect it.");
	});

	it("does not revive a preamble when a shell result precedes the next response", () => {
		const restored = restore(prompt, text("I will inspect it."), tool, shell, text("Done."));
		expect(restored).toContain("Done.\n");
		expect(restored).not.toContain("I will inspect it.");
	});

	it.each([false, true])("keeps a response across a background notice (afterShell=%s)", (afterShell) => {
		const notice: SavedEntry = {
			type: "event",
			event: { type: "jobs_status", turnId: "t", seq: 2, running: 0, waiting: 1 },
		};
		const boundary = afterShell ? [shell, notice] : [notice, shell];
		expect(restore(prompt, text("Before. "), ...boundary, text("After."))).toContain("Before. After.\n");
	});

	it("keeps prompts and worker text out of the joined answer", () => {
		const worker: SavedEntry = { type: "text", turnId: "t", agent: "worker", text: "private worker text" };
		const workerTool: SavedEntry = {
			type: "event",
			event: {
				type: "tool_call_started",
				turnId: "t",
				seq: 3,
				tool: "read",
				input: {},
				callId: "worker-call",
				agent: "worker",
				parentCallId: "parent",
			},
		};
		const next: SavedEntry = { type: "prompt", turnId: "next", text: "next question" };
		const nextAnswer: SavedEntry = { type: "text", turnId: "next", text: "Next answer." };
		const restored = restore(prompt, text("Before. "), shell, workerTool, worker, text("After."), next, nextAnswer);
		expect(restored).toContain("Before. After.\n");
		expect(restored).toContain("> next question\nNext answer.\n");
		expect(restored).not.toContain("private worker text");
	});
});
