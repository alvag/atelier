import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AtelierEvent,
	FakeBackend,
	type FakeStep,
	type SavedEntry,
	Session,
	SessionStore,
	type ShellResult,
} from "@atelier/core";
import { afterEach, describe, expect, it } from "vitest";
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
const response: SavedEntry = { type: "response", turnId: "t" };
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

describe("saved review responses", () => {
	it("gives each response of the turn its last text, apart from the others", () => {
		const restored = restore(
			prompt,
			text("I will look."),
			tool,
			text("Done."),
			response,
			text("Fixing."),
			tool,
			text("Fixed."),
		);
		expect(restored).toBe("resumed session saved: 1 turn\n> work\nDone.\n\nFixed.\n");
	});

	it("stops joining across a shell result where a review response starts", () => {
		expect(restore(prompt, text("Done."), shell, response, text("Declaring."))).toContain(
			"> work\nDone.\n\nDeclaring.\n",
		);
		expect(restore(prompt, text("Done."), response, shell, text("Declaring."))).toContain(
			"> work\nDone.\n\nDeclaring.\n",
		);
	});

	it("joins the segments of a review response around a shell result", () => {
		expect(restore(prompt, text("Done."), response, text("Fixed "), shell, text("it."))).toContain(
			"> work\nDone.\n\nFixed it.\n",
		);
	});

	it("adds nothing for a review response without text", () => {
		expect(restore(prompt, text("Done."), response, tool)).toBe("resumed session saved: 1 turn\n> work\nDone.\n");
	});

	it("adds no paragraph for a response whose visible text is empty, wherever it is", () => {
		const blank = text(" \n\t\n");
		const expected = "resumed session saved: 1 turn\n> work\nDone.\n\nFixed.\n";
		expect(restore(prompt, text("Done."), response, blank, response, text("Fixed."))).toBe(expected);
		expect(restore(prompt, blank, response, text("Done."), response, text("Fixed."))).toBe(expected);
		expect(restore(prompt, text("Done."), response, text("Fixed."), response, blank)).toBe(expected);
	});

	it("keeps reading a session saved without the marks as before", () => {
		expect(restore(prompt, text("Done."), shell, text("Declaring."))).toContain("> work\nDone.Declaring.\n");
	});
});

describe("a resumed turn whose review asked for the risk declaration", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});
	const scratch = async (name: string) => {
		const dir = await mkdtemp(join(tmpdir(), `atelier-transcript-${name}-`));
		dirs.push(dir);
		return dir;
	};
	const finished: FakeStep = {
		event: {
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		},
	};
	const say = (value: string): FakeStep => ({ event: { type: "text_delta", text: value } });
	const declareNone: FakeStep = {
		toolCall: { tool: "risk", input: { none: true, reason: "a test" }, callId: "c-risk" },
	};
	const until = async (condition: () => boolean) => {
		for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(condition()).toBe(true);
	};

	/** Runs one turn that changes a file without declaring its risk, then answers the declaration request. */
	async function resumed(declaration: FakeStep[], shellDuring: boolean) {
		const cwd = await scratch("repo");
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
		git("init", "-q");
		await writeFile(join(cwd, "a.ts"), "base\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		const store = new SessionStore(await scratch("home"));
		const record = store.create(cwd);
		const events: AtelierEvent[] = [];
		const answered = () => events.some((event) => event.type === "text_delta" && event.text === "Done.");
		let session: Session | undefined;
		// The user's command ends while the review asks for the declaration, after the answer reached the client.
		const shell: FakeStep = {
			run: async () => {
				await until(answered);
				await session?.recordShellResult(result);
			},
		};
		const backend = new FakeBackend(
			[
				[{ run: () => writeFile(join(cwd, "a.ts"), "base\nmore\n") }, say("Done."), finished],
				[...(shellDuring ? [shell] : []), ...declaration, finished],
			],
			"claude-code",
		);
		session = await Session.start({
			backend,
			cwd,
			tools: [],
			record,
			review: { createBackend: () => new FakeBackend([]) },
		});
		for await (const event of session.send("edit")) events.push(event);
		await session.close();
		await record.release();
		const loaded = await store.load(cwd, record.id);
		const restored = savedTranscript("saved", undefined, loaded.entries);
		const texts = loaded.entries.flatMap((entry) => (entry.type === "text" ? [entry.text] : []));
		// The mark is only for the saved session: no client hears of it.
		expect(events.map((event) => event.type as string)).not.toContain("response_started");
		return { entries: loaded.entries, texts, restored };
	}

	it.each([false, true])(
		"shows the answer and the declaration's text apart, the declaration calling the risk tool (shell=%s)",
		async (shellDuring) => {
			const { entries, texts, restored } = await resumed([say("Declaring."), declareNone], shellDuring);
			expect(texts).toEqual(["Done.", "Declaring."]);
			const kinds = entries.map((entry) => entry.type);
			expect(kinds.indexOf("response")).toBeGreaterThan(kinds.indexOf("text"));
			expect(restored).toBe(
				`resumed session saved: 1 turn\n> edit\nDone.\n\nDeclaring.\n${shellDuring ? "! printf hi\nhi\nexit 0\n" : ""}`,
			);
		},
	);

	it("shows a declaration answered with text alone apart from the answer", async () => {
		const { texts, restored } = await resumed([say("Nothing to declare.")], false);
		expect(texts).toEqual(["Done.", "Nothing to declare."]);
		expect(restored).toBe("resumed session saved: 1 turn\n> edit\nDone.\n\nNothing to declare.\n");
	});

	it("adds no paragraph for a declaration whose text is empty", async () => {
		const { restored } = await resumed([say("")], false);
		expect(restored).toBe("resumed session saved: 1 turn\n> edit\nDone.\n");
	});
});
