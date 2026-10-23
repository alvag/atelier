import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
	type AtelierEventBody,
	FakeBackend,
	FakeMemory,
	type FakeStep,
	MemoryUnavailableError,
	MissingApiKeyError,
} from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const started: AtelierEventBody = { type: "session_started", backend: "fake", model: "m", authSource: "subscription" };

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-cli-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function harness(
	turns: FakeStep[][],
	options: {
		isTTY?: boolean;
		input?: string[];
		/** Typed one at a time, each once its yes/no question is on screen. */
		answers?: string[];
		keepStdinOpen?: boolean;
		env?: Record<string, string>;
		home?: string;
		/** A terminal the CLI can put in raw mode, as when stdin and stdout are both terminals. */
		raw?: boolean;
	} = {},
) {
	const backend = new FakeBackend(turns);
	let interruptHandler: (() => void) | undefined;
	const exits: number[] = [];
	const rawModes: boolean[] = [];
	/** For each forced exit, whether the terminal was back out of raw mode by then. */
	const restoredAtExit: boolean[] = [];
	const stdin = new PassThrough();
	let stdout = "";
	let stderr = "";
	const answers = [...(options.answers ?? [])];
	const io = {
		stdin,
		isTTY: options.isTTY ?? options.raw ?? false,
		...(options.raw
			? {
					setRawMode: (on: boolean) => {
						rawModes.push(on);
					},
				}
			: {}),
		stdout: (s: string) => {
			stdout += s;
			const answer = s.endsWith("[y/N] ") ? answers.shift() : undefined;
			if (answer !== undefined) setImmediate(() => stdin.write(`${answer}\n`));
		},
		stderr: (s: string) => {
			stderr += s;
		},
		cwd,
		...(options.home === undefined ? {} : { home: options.home }),
		color: false,
		env: options.env ?? {},
		onInterrupt: (handler: () => void) => {
			interruptHandler = handler;
			return () => {
				interruptHandler = undefined;
			};
		},
		exit: (code: number) => {
			exits.push(code);
			restoredAtExit.push(rawModes.at(-1) === false);
		},
	};
	for (const line of options.input ?? []) stdin.write(`${line}\n`);
	if (options.input && !options.keepStdinOpen) stdin.end();
	return {
		backend,
		io,
		exits,
		rawModes,
		restoredAtExit,
		out: () => stdout,
		err: () => stderr,
		createBackend: () => backend,
		ctrlC: () => interruptHandler?.(),
		/** The CLI listens for Ctrl+C only once the session started; before that a press goes nowhere. */
		listening: () => interruptHandler !== undefined,
	};
}

describe("run", () => {
	it("gives the model the project instructions and says which files it loaded", async () => {
		await writeFile(join(cwd, "AGENTS.md"), "Prefer tabs.");
		const h = harness([[{ event: started }, { event: finished }]], { home: dirname(cwd) });
		expect(await run(["hi"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.startOptions?.systemPromptAppend).toContain(
			`Project instructions from ${join(cwd, "AGENTS.md")}:\n\nPrefer tabs.`,
		);
		expect(h.out()).toContain(`instructions: ${join(cwd, "AGENTS.md")}\n`);
	});

	it("runs one prompt and exits 0", async () => {
		const h = harness([[{ event: started }, { event: { type: "text_delta", text: "hello" } }, { event: finished }]]);
		const code = await run(["say hi"], h.io, h.createBackend);
		expect(code).toBe(0);
		expect(h.backend.prompts).toEqual(["say hi"]);
		expect(h.out()).toContain("hello\ntokens: input 1 · output 2 · cache read 3 · cache write 4 · cache 38%\n");
		expect(h.backend.startOptions?.cwd).toBe(cwd);
		expect(h.backend.startOptions?.tools.map((t) => t.name)).toEqual([
			"read",
			"edit",
			"bash",
			"grep",
			"task",
			"risk",
			"feature",
			"phase",
		]);
		expect(h.backend.closed).toBe(true);
	});

	it("passes the model and keeps the system prompt byte-stable", async () => {
		const a = harness([[{ event: finished }]]);
		await run(["--model", "sonnet", "x"], a.io, a.createBackend);
		const b = harness([[{ event: finished }]]);
		await run(["y"], b.io, b.createBackend);
		expect(a.backend.startOptions?.model).toBe("sonnet");
		expect(b.backend.startOptions?.model).toBeUndefined();
		expect(a.backend.startOptions?.systemPromptAppend).toBe(b.backend.startOptions?.systemPromptAppend);
		expect(a.backend.startOptions?.systemPromptAppend).not.toBe("");
	});

	it("exits 1 when the turn fails", async () => {
		const h = harness([[{ throw: "network down" }]]);
		expect(await run(["x"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe("error: network down\n");
	});

	it("denies commands without a terminal to ask, and runs them with --yes", async () => {
		await writeFile(join(cwd, "marker"), "");
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "rm marker" } } };

		const denied = harness([[step, { event: finished }]]);
		await run(["x"], denied.io, denied.createBackend);
		expect(denied.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(denied.err()).toContain("needs approval; run with --yes to allow commands");

		const allowed = harness([[step, { event: finished }]]);
		await run(["--yes", "x"], allowed.io, allowed.createBackend);
		expect(allowed.backend.toolResults[0]?.ok).toBe(true);
	});

	it("asks on a terminal and runs the command only when the answer is yes", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };

		const yes = harness([[step, { event: finished }]], { isTTY: true, answers: ["y"] });
		await run(["x"], yes.io, yes.createBackend);
		expect(yes.out()).toContain("Run this command?\n  echo hi\n[y/N] ");
		expect(yes.backend.toolResults[0]?.ok).toBe(true);

		const no = harness([[step, { event: finished }]], { isTTY: true, input: [""] });
		await run(["x"], no.io, no.createBackend);
		expect(no.backend.toolResults[0]?.ok).toBe(false);
	});

	it("ignores lines typed before the question: only an answer typed after it counts", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };
		const h = harness([[step, { event: finished }]], {
			isTTY: true,
			input: ["y"],
			answers: ["n"],
			keepStdinOpen: true,
		});
		await run(["x"], h.io, h.createBackend);
		expect(h.out()).toContain("ignored 1 line typed before this question\nRun this command?\n  echo hi\n[y/N] ");
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
	});

	it("does not let the rest of a pasted prompt answer an approval", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo checked" } } };
		const h = harness([[step, { event: finished }]], {
			isTTY: true,
			input: ["Run pnpm check and fix", " | what Biome reports"],
			answers: ["y"],
			keepStdinOpen: true,
		});
		const pending = run([], h.io, h.createBackend);
		await vi.waitFor(() => expect(h.backend.toolResults).toHaveLength(1), { timeout: 5000 });
		(h.io.stdin as PassThrough).end();
		expect(await pending).toBe(0);
		expect(h.backend.prompts).toEqual(["Run pnpm check and fix"]);
		expect(h.out()).toContain("ignored 1 line typed before this question\n");
		expect(h.backend.toolResults[0]?.ok).toBe(true);
	});

	it("still takes a prompt typed during a turn as the next prompt", async () => {
		const h = harness(
			[
				[{ event: { type: "text_delta", text: "one" } }, { event: finished }],
				[{ event: { type: "text_delta", text: "two" } }, { event: finished }],
			],
			{ isTTY: true, input: ["first", "second"] },
		);
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual(["first", "second"]);
		expect(h.out()).not.toContain("ignored");
	});

	it("shows hidden characters in the command it asks about", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo \u001b[2Khi \u202Ex" } } };
		const h = harness([[step, { event: finished }]], { isTTY: true, input: ["n"] });
		await run(["x"], h.io, h.createBackend);
		expect(h.out()).toContain("Run this command?\n  echo ␛[2Khi ⟨U+202E⟩x\n");
		expect(h.out()).toContain("warning: the command contains invisible or control characters, shown as markers.");
		expect(h.out()).not.toContain("\u001b[2K");
	});

	it("runs an interactive session until end of input", async () => {
		const h = harness(
			[
				[{ event: { type: "text_delta", text: "one" } }, { event: finished }],
				[{ event: { type: "text_delta", text: "two" } }, { event: finished }],
			],
			{ input: ["first", "", "second"] },
		);
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual(["first", "second"]);
		expect(h.out()).toContain("one");
		expect(h.out()).toContain("two");
	});

	it("stops the interactive session on /exit", async () => {
		const h = harness([[{ event: finished }]], { input: ["/exit", "never"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual([]);
	});

	describe("Ctrl+C", () => {
		/** Waits for what the test needs, never a fixed delay: a loaded machine starts the session slower. */
		const until = async (condition: () => boolean) => {
			for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(condition()).toBe(true);
		};

		it("interrupts the turn and exits 130", async () => {
			const h = harness([[{ event: { type: "text_delta", text: "a" } }, { waitForInterrupt: true }]]);
			const pending = run(["x"], h.io, h.createBackend);
			await until(() => h.listening() && h.out().includes("a"));
			h.ctrlC();
			expect(await pending).toBe(130);
			expect(h.backend.interrupts).toBe(1);
			expect(h.backend.closed).toBe(true);
			expect(h.exits).toEqual([]);
		});

		it("answers no to a pending approval and interrupts the turn", async () => {
			const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { waitForInterrupt: true }]], {
				isTTY: true,
				input: [],
				keepStdinOpen: true,
			});
			const pending = run(["x"], h.io, h.createBackend);
			await until(() => h.out().includes("[y/N] "));
			h.ctrlC();
			expect(await pending).toBe(130);
			expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		});

		it("does not lose the next line after an approval is cancelled", async () => {
			const h = harness(
				[
					[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { waitForInterrupt: true }],
					[{ event: { type: "text_delta", text: "second turn" } }, { event: finished }],
				],
				{ isTTY: true, input: [], keepStdinOpen: true },
			);
			const stdin = h.io.stdin as PassThrough;
			const pending = run([], h.io, h.createBackend);
			stdin.write("first\n");
			await until(() => h.out().includes("[y/N] "));
			h.ctrlC();
			await until(() => h.backend.interrupts === 1);
			stdin.write("next prompt\n");
			stdin.end();
			expect(await pending).toBe(0);
			expect(h.backend.prompts).toEqual(["first", "next prompt"]);
			expect(h.out()).toContain("second turn");
		});

		it("closes the session on a second Ctrl+C when the turn does not stop", async () => {
			const h = harness([[{ hang: true }]]);
			const pending = run(["x"], h.io, h.createBackend);
			await until(() => h.listening() && h.backend.prompts.length === 1);
			h.ctrlC();
			await until(() => h.backend.interrupts === 1);
			expect(h.backend.closed).toBe(false);
			h.ctrlC();
			expect(await pending).toBe(130);
			expect(h.backend.closed).toBe(true);
			expect(h.exits).toEqual([]);
		});

		it("keeps the forced exit armed while closing the session hangs", async () => {
			const h = harness([], { input: [], keepStdinOpen: true });
			const stuck = {
				id: "stuck",
				start: async () => ({
					async *send() {},
					interrupt: async () => {},
					close: () => new Promise<void>(() => {}),
				}),
			};
			void run([], { ...h.io, forceExitMs: 20 }, () => stuck);
			await until(h.listening);
			h.ctrlC();
			await until(() => h.exits.length > 0);
			expect(h.exits).toEqual([130]);
		});

		it("leaves an idle interactive session cleanly", async () => {
			const h = harness([], { input: [], keepStdinOpen: true });
			const pending = run([], h.io, h.createBackend);
			await until(h.listening);
			h.ctrlC();
			expect(await pending).toBe(130);
			expect(h.backend.closed).toBe(true);
			expect(h.exits).toEqual([]);
		});
	});

	describe("on a raw terminal", () => {
		const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
		const until = async (condition: () => boolean) => {
			for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(condition()).toBe(true);
		};

		it("turns bracketed paste on and off and sends a multi-line paste as one prompt", async () => {
			const h = harness([[{ event: { type: "text_delta", text: "done" } }, { event: finished }]], {
				raw: true,
				input: [paste("first line\rsecond line")],
			});
			expect(await run([], h.io, h.createBackend)).toBe(0);
			expect(h.backend.prompts).toEqual(["first line\nsecond line"]);
			expect(h.rawModes).toEqual([true, false]);
			expect(h.out()).toContain("\x1b[?2004h> first line\nsecond line\ndone");
			expect(h.out().endsWith("\x1b[?2004l")).toBe(true);
			expect(h.out()).not.toContain("\x1b[200~");
		});

		it("does not let a line typed before the question answer it", async () => {
			const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };
			const h = harness([[step, { event: finished }]], {
				raw: true,
				input: [paste("check\rthis"), "y"],
				answers: ["n"],
				keepStdinOpen: true,
			});
			const pending = run([], h.io, h.createBackend);
			await vi.waitFor(() => expect(h.backend.toolResults).toHaveLength(1), { timeout: 5000 });
			(h.io.stdin as PassThrough).end();
			expect(await pending).toBe(0);
			expect(h.backend.prompts).toEqual(["check\nthis"]);
			expect(h.out()).toContain("ignored 1 line typed before this question\n");
			expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		});

		it("does not let a line typed before the session started answer the question", async () => {
			const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };
			const h = harness([[step, { event: finished }]], { raw: true, answers: ["n\r"], keepStdinOpen: true });
			(h.io.stdin as PassThrough).write("y\r");
			expect(await run(["--no-review", "x"], h.io, h.createBackend)).toBe(0);
			expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		});

		it.each([
			["a paste marker split across the question", "\x1b[20", "0~y\n\x1b[201~\r", false],
			["a pasted yes", "", "\x1b[200~y\n\x1b[201~\r", false],
			["a pasted yes with more text", "", "\x1b[200~y\nnot approval\x1b[201~\r", false],
			["a pasted yes typed over", "", "\x1b[200~y\x1b[201~\r", false],
			["a typed yes", "", "y\r", true],
		])("answers a bash approval from %s", async (_name, before, after, approved) => {
			const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };
			const h = harness([[step, { event: finished }]], { raw: true, answers: [after], keepStdinOpen: true });
			(h.io.stdin as PassThrough).write(before);
			expect(await run(["--no-review", "x"], h.io, h.createBackend)).toBe(0);
			expect(h.backend.toolResults[0]?.ok).toBe(approved);
			if (!approved) {
				expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
				if (before === "") expect(h.out()).toContain("pasted text does not answer this question\n");
			}
		});

		it("does not take a pasted yes as consent to review", async () => {
			await repoWithChange("src/auth.ts");
			const h = harness([[{ event: { type: "text_delta", text: "done" } }, { event: finished }]], {
				raw: true,
				answers: ["\x1b[200~y\n\x1b[201~\r"],
			});
			expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
			expect(h.backend.prompts).toEqual(["change it"]);
			expect(h.out()).toContain("pasted text does not answer this question\n");
			expect(h.out()).toContain("review declined");
		});

		it("takes Ctrl+C as a key and leaves the terminal as it was", async () => {
			const h = harness([], { raw: true, input: [], keepStdinOpen: true });
			const pending = run([], h.io, h.createBackend);
			await until(() => h.out().includes("> "));
			(h.io.stdin as PassThrough).write("\x03");
			expect(await pending).toBe(130);
			expect(h.rawModes).toEqual([true, false]);
			expect(h.out().endsWith("\x1b[?2004l")).toBe(true);
		});

		it("restores the terminal before a forced exit", async () => {
			const h = harness([], { raw: true, input: [], keepStdinOpen: true });
			const stuck = {
				id: "stuck",
				start: async () => ({
					async *send() {},
					interrupt: async () => {},
					close: () => new Promise<void>(() => {}),
				}),
			};
			void run([], { ...h.io, forceExitMs: 20 }, () => stuck);
			await until(() => h.out().includes("> "));
			(h.io.stdin as PassThrough).write("\x03");
			await until(() => h.exits.length > 0);
			expect(h.exits).toEqual([130]);
			expect(h.restoredAtExit).toEqual([true]);
			expect(h.out()).toContain("\x1b[?2004l");
		});
	});

	it("builds the backend named by --backend, claude-code by default", async () => {
		const names: string[] = [];
		for (const argv of [["--backend", "anthropic-api", "x"], ["y"]]) {
			const h = harness([[{ event: finished }]]);
			await run(argv, h.io, (name) => {
				names.push(name);
				return h.backend;
			});
		}
		expect(names).toEqual(["anthropic-api", "claude-code"]);
	});

	it("lets the agent delegate to subagents on the same backend, shown indented", async () => {
		const parent = harness([
			[
				{ toolCall: { tool: "task", input: { agent: "explorer", prompt: "Find it." }, callId: "c1" } },
				{ event: finished },
			],
		]);
		const child = new FakeBackend([[{ event: { type: "text_delta", text: "It is in a.ts." } }, { event: finished }]]);
		const names: string[] = [];
		const code = await run(["--backend", "anthropic-api", "x"], parent.io, (name) => {
			names.push(name);
			return names.length === 1 ? parent.backend : child;
		});
		expect(code).toBe(0);
		expect(names).toEqual(["anthropic-api", "anthropic-api"]);
		expect(child.prompts).toEqual(["Find it."]);
		expect(child.startOptions?.tools.map((t) => t.name)).toEqual(["read", "grep"]);
		expect(parent.out()).toContain("  │ It is in a.ts.\n");
		expect(parent.backend.toolResults[0]).toEqual({ ok: true, output: "It is in a.ts." });
	});

	it("connects memory for the working directory and offers it to the agent", async () => {
		const h = harness([[{ event: finished }]]);
		const folders: string[] = [];
		const memory = new FakeMemory("proj");
		await run(["x"], h.io, h.createBackend, async (folder) => {
			folders.push(folder);
			return memory;
		});
		expect(folders).toEqual([cwd]);
		expect(h.backend.startOptions?.tools.map((t) => t.name)).toContain("memory");
		expect(h.out()).toContain("memory: proj\n");
		expect(memory.closed).toBe(true);
	});

	it("runs without memory when it cannot connect, and says why", async () => {
		const h = harness([[{ event: finished }]]);
		const code = await run(["x"], h.io, h.createBackend, async () => {
			throw new MemoryUnavailableError("Engram is not installed (no engram command).");
		});
		expect(code).toBe(0);
		expect(h.backend.startOptions?.tools.map((t) => t.name)).not.toContain("memory");
		expect(h.err()).toContain("no memory: Engram is not installed (no engram command).");
	});

	it("exits 1 with the instructions when the backend has no API key", async () => {
		const h = harness([]);
		const code = await run(["--backend", "anthropic-api", "x"], h.io, async () => {
			throw new MissingApiKeyError(
				"No Anthropic API key in the Keychain. Store it with: security add-generic-password",
			);
		});
		expect(code).toBe(1);
		expect(h.err()).toBe("error: No Anthropic API key in the Keychain. Store it with: security add-generic-password\n");
		expect(h.out()).toBe("");
	});

	it("prints help and the version", async () => {
		const help = harness([]);
		expect(await run(["--help"], help.io, help.createBackend)).toBe(0);
		expect(help.out()).toContain("Usage: atelier [options] [prompt]");
		expect(help.out()).toContain("--backend <name>");
		expect(help.out()).toContain("ATELIER_MEMORY=off");
		expect(help.backend.startOptions).toBeUndefined();

		const version = harness([]);
		expect(await run(["--version"], version.io, version.createBackend)).toBe(0);
		expect(version.out()).toBe("atelier 0.0.0\n");
	});

	it("exits 2 on usage errors and a missing working directory", async () => {
		const bad = harness([]);
		expect(await run(["--nope"], bad.io, bad.createBackend)).toBe(2);
		expect(bad.err()).toMatch(/^error: Unknown option '--nope'/);

		const missing = harness([]);
		expect(await run(["--cwd", join(cwd, "nope"), "x"], missing.io, missing.createBackend)).toBe(2);
		expect(missing.err()).toContain("Working directory does not exist");
		expect(missing.backend.startOptions).toBeUndefined();
	});
});

/** A git repo in `cwd` with one commit and an uncommitted change at `path`. */
async function repoWithChange(path: string) {
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(cwd, "base.txt"), "base\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	await mkdir(dirname(join(cwd, path)), { recursive: true });
	await writeFile(join(cwd, path), "export const x = 1;\n");
}

describe("run: review", () => {
	const mainTurn: FakeStep[] = [{ event: { type: "text_delta", text: "done" } }, { event: finished }];
	const noFindings: FakeStep[] = [{ event: { type: "text_delta", text: '{"findings": []}' } }, { event: finished }];
	const lenses = (n: number) => Array.from({ length: n }, () => noFindings);
	const reviewLines = (out: string) => out.split("\n").filter((line) => line.includes("review"));

	it("asks on a terminal, shows level, reasons and lenses, and reviews when the answer is yes", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, answers: ["y"] });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.out()).toContain(
			"Review this change?\n  risk: high\n  reasons: path: src/auth.ts (auth)\n  lenses: risk, resilience, readability, reliability\n[y/N] ",
		);
		expect(h.backend.prompts).toHaveLength(5);
		expect(h.out()).toMatch(/✓ review approved · receipt \.git\/atelier\/reviews\/[0-9a-f]+\.json\n/);
	});

	it("ignores a yes typed before the review question", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: ["y"], answers: [""], keepStdinOpen: true });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.out()).toContain("ignored 1 line typed before this question\nReview this change?");
		expect(h.backend.prompts).toHaveLength(1);
		expect(reviewLines(h.out())).toContain("◇ review declined");
	});

	it("prints the risk line before the question", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: ["n"] });
		await run(["change it"], h.io, h.createBackend);
		expect(h.out().indexOf("◇ review high · 4 lenses")).toBeGreaterThan(-1);
		expect(h.out().indexOf("◇ review high · 4 lenses")).toBeLessThan(h.out().indexOf("Review this change?"));
	});

	it("does not review when the answer is no, and says declined", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: [""] });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(1);
		expect(reviewLines(h.out())).toContain("◇ review declined");
	});

	it("declines without a terminal and says how to review", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)]);
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(1);
		expect(h.err()).toContain("review skipped: there is no terminal to ask; use /review in an interactive session");
		expect(h.out()).toContain("◇ review declined");
	});

	it("does not take --yes as consent to review", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)]);
		await run(["--yes", "change it"], h.io, h.createBackend);
		expect(h.backend.prompts).toHaveLength(1);
		expect(h.out()).toContain("◇ review declined");
	});

	it("answers no to the question on Ctrl+C", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: [], keepStdinOpen: true });
		const pending = run(["change it"], h.io, h.createBackend);
		// Waits for the question itself: a fixed delay raced the turn under load.
		await vi.waitFor(() => expect(h.out()).toContain("Review this change?"), { timeout: 5000 });
		h.ctrlC();
		expect(await pending).toBe(130);
		expect(h.backend.prompts).toHaveLength(1);
	});

	it.each([
		["--no-review", ["--no-review", "x"], {}],
		["ATELIER_REVIEW=off", ["x"], { ATELIER_REVIEW: "off" }],
	])("does not review with %s", async (_name, argv, env) => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: ["y"], env });
		expect(await run(argv, h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(1);
		expect(h.backend.startOptions?.tools.map((t) => t.name)).not.toContain("risk");
		expect(h.out()).not.toContain("review");
		// The only mention: why there is no review, once.
		expect(h.err()).toBe("no review: Review is off (--no-review or ATELIER_REVIEW=off).\n");
	});

	it("gives the main agent the risk tool by default and says why there is no review outside git", async () => {
		const h = harness([mainTurn]);
		await run(["x"], h.io, h.createBackend);
		expect(h.backend.startOptions?.tools.map((t) => t.name)).toContain("risk");
		expect(h.err()).toMatch(/^no review: /);
	});

	it("runs /review in the interactive loop for any risk, and renders it like a turn", async () => {
		await repoWithChange("notes.ts");
		const h = harness([noFindings], { input: ["/review"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(1);
		expect(h.out()).toContain("◇ review medium · 1 lens");
		expect(h.out()).toContain("◇ review: lens reliability");
		expect(h.out()).toMatch(/✓ review approved · receipt \.git\/atelier\/reviews\//);
		expect(h.out()).toContain("tokens: ");
	});

	it("says so when /review finds nothing to review", async () => {
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
		git("init", "-q");
		await writeFile(join(cwd, "a.txt"), "a\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		const h = harness([], { input: ["/review"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.err()).toContain("There are no changes to review.");
	});

	it("answers /review with an error, not a prompt, when the review is off", async () => {
		const h = harness([mainTurn], { input: ["/review"], env: { ATELIER_REVIEW: "off" } });
		await run([], h.io, h.createBackend);
		expect(h.err()).toContain("Review is off");
		expect(h.backend.prompts).toEqual([]);
	});

	it("runs /compact in the interactive loop as its own turn, not as a prompt", async () => {
		const h = harness([], { input: ["/compact keep the API decisions", "/compact"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual([]);
		expect(h.err().match(/This backend cannot compact its context\./g)).toHaveLength(2);
	});
});
