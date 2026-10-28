import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type AtelierEventBody,
	type BackendName,
	coreTools,
	createBashTool,
	defineTool,
	FakeBackend,
	FakeMemory,
	type FakeStep,
	McpManager,
	type McpServerConfig,
	MemoryUnavailableError,
	MissingApiKeyError,
	Sandbox,
	type SandboxManagerLike,
	SessionStore,
	type ToolDefinition,
	VERSION,
} from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeOpenAiAuth, fakeCodexAccess, fakeRefresh } from "../../atelier-core/test/support/fake-openai-auth.ts";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";
import { run } from "../src/run.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const started: AtelierEventBody = { type: "session_started", backend: "fake", model: "m", authSource: "subscription" };

let cwd: string;
/** The user's home, for the CLI that is given none: the default mode is read from it. */
let fallbackHome: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-cli-"));
	fallbackHome = await mkdtemp(join(tmpdir(), "atelier-cli-home-"));
	vi.stubEnv("HOME", fallbackHome);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(cwd, { recursive: true, force: true });
	await rm(fallbackHome, { recursive: true, force: true });
});

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** The core's tools with a `bash` whose sandbox is there and wraps nothing, so the output does not depend on the platform. */
const tools = (() => {
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	const bash = createBashTool({ sandbox: new Sandbox({ platform: "darwin", manager }) });
	return coreTools.map((tool) => (tool.name === "bash" ? bash : tool));
})();

/** The core's tools with a `bash` that has no sandbox: in normal mode every command asks. */
const unsandboxedTools = (() => {
	// Without a sandbox there is no profile for covered commands either: questions offer only y and N.
	const bash = createBashTool({ sandbox: new Sandbox({ platform: "linux", outside: () => false }) });
	return coreTools.map((tool) => (tool.name === "bash" ? bash : tool));
})();

/** The core's tools with a `bash` whose sandbox failed to start: every command asks, in yolo too. */
const failedSandboxTools = (() => {
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {
			throw new Error("proxy could not start");
		},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	const bash = createBashTool({ sandbox: new Sandbox({ platform: "darwin", manager, outside: () => false }) });
	return coreTools.map((tool) => (tool.name === "bash" ? bash : tool));
})();

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
		/** The user id the process runs as; unknown when absent. */
		uid?: number;
		/** false: `bash` has no sandbox, so every command asks; "failed": its sandbox failed to start. */
		sandbox?: boolean | "failed";
		/** The name the backend answers to; a saved session needs a real one. */
		backendId?: string;
		/** Tools the session gets besides the usual ones. */
		extraTools?: ToolDefinition[];
	} = {},
) {
	const backend = new FakeBackend(turns, options.backendId);
	let interruptHandler: (() => void) | undefined;
	let terminateHandler: ((signal: number) => void) | undefined;
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
			const answer = /\[y\/N(\/[sa])*\] $/.test(s) ? answers.shift() : undefined;
			if (answer !== undefined) setImmediate(() => stdin.write(`${answer}\n`));
		},
		stderr: (s: string) => {
			stderr += s;
		},
		cwd,
		// No test runs the real Claude Code or asks the real Keychain: a missing binary and an empty Keychain.
		claudeCode: join(cwd, "no-claude-in-tests"),
		runSecurity: async () => ({ code: 44, stdout: "", stderr: "" }),
		tools: [
			...(options.sandbox === false ? unsandboxedTools : options.sandbox === "failed" ? failedSandboxTools : tools),
			...(options.extraTools ?? []),
		],
		...(options.uid === undefined ? {} : { uid: options.uid }),
		...(options.home === undefined ? {} : { home: options.home }),
		color: false,
		env: options.env ?? {},
		onTerminate: (handler: (signal: number) => void) => {
			terminateHandler = handler;
			return () => {
				terminateHandler = undefined;
			};
		},
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
		terminate: (signal: number) => terminateHandler?.(signal),
		/** The CLI listens for Ctrl+C only once the session started; before that a press goes nowhere. */
		listening: () => interruptHandler !== undefined,
	};
}

describe("run", () => {
	it("gives the model the project instructions and says which files it loaded", async () => {
		await writeFile(join(cwd, "AGENTS.md"), "Prefer tabs.");
		const h = harness([[{ event: started }, { event: finished }]], { home: dirname(cwd) });
		expect(await run(["--no-session", "hi"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.startOptions?.systemPromptAppend).toContain(
			`Project instructions from ${join(cwd, "AGENTS.md")}:\n\nPrefer tabs.`,
		);
		expect(h.out()).toContain(`instructions: ${join(cwd, "AGENTS.md")}\n`);
	});

	it("lists the skills in the system prompt and says which it loaded", async () => {
		await mkdir(join(cwd, ".agents", "skills", "notes"), { recursive: true });
		await writeFile(
			join(cwd, ".agents", "skills", "notes", "SKILL.md"),
			"---\nname: notes\ndescription: Take notes.\n---\n",
		);
		const h = harness([[{ event: started }, { event: finished }]], { home: dirname(cwd) });
		expect(await run(["--no-session", "hi"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.startOptions?.systemPromptAppend).toContain("<name>notes</name>");
		expect(h.out()).toContain("skills: notes\n");
	});

	it("still runs a multi-word prompt", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		expect(await run(["fix", "the", "bug"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual(["fix the bug"]);
	});

	it("still runs a quoted prompt that starts with update", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		expect(await run(["update the readme"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual(["update the readme"]);
	});

	it("still runs a quoted prompt that starts with desktop", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		expect(await run(["desktop app is slow"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual(["desktop app is slow"]);
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
			"write",
			"bash",
			"grep",
			"web_fetch",
			"web_search",
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

	it("runs a sandboxed command without asking, with or without a terminal", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };
		for (const isTTY of [false, true]) {
			const h = harness([[step, { event: finished }]], { isTTY, input: [] });
			expect(await run(["x"], h.io, h.createBackend)).toBe(0);
			expect(h.backend.toolResults[0]?.ok).toBe(true);
			expect(h.out()).not.toContain("[y/N]");
			expect(h.err()).not.toContain("approval");
		}
	});

	it("asks on a terminal and runs the command only when the answer is yes", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };

		const yes = harness([[step, { event: finished }]], { isTTY: true, answers: ["y"], sandbox: false });
		await run(["x"], yes.io, yes.createBackend);
		expect(yes.out()).toContain("Run this command?\n  echo hi\n[y/N] ");
		expect(yes.backend.toolResults[0]?.ok).toBe(true);

		const no = harness([[step, { event: finished }]], { isTTY: true, input: [""], sandbox: false });
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
			sandbox: false,
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
			sandbox: false,
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
		const h = harness([[step, { event: finished }]], { isTTY: true, input: ["n"], sandbox: false });
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
				sandbox: false,
			});
			const pending = run(["x"], h.io, h.createBackend);
			await until(() => h.out().includes("[y/N"));
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
				{ isTTY: true, input: [], keepStdinOpen: true, sandbox: false },
			);
			const stdin = h.io.stdin as PassThrough;
			const pending = run([], h.io, h.createBackend);
			stdin.write("first\n");
			await until(() => h.out().includes("[y/N"));
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
			expect(h.out()).toContain("\x1b[?2004h> first line\nsecond line\nbash: sandboxed (macOS seatbelt)\ndone");
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
				sandbox: false,
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
			const h = harness([[step, { event: finished }]], {
				raw: true,
				answers: ["n\r"],
				keepStdinOpen: true,
				sandbox: false,
			});
			(h.io.stdin as PassThrough).write("y\r");
			expect(await run(["--no-review", "x"], h.io, h.createBackend)).toBe(0);
			expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		});

		it.each([
			["a paste marker split across the question", "\x1b[20", "0~y\n\x1b[201~\r", false],
			["a pasted yes", "", "\x1b[200~y\n\x1b[201~\r", false],
			["a pasted yes with more text", "", "\x1b[200~y\nnot approval\x1b[201~\r", false],
			["a pasted yes typed over", "", "\x1b[200~y\x1b[201~\r", false],
			["a split paste marker erased with Ctrl+U", "\x1b[20", "0~\x15y\n\x1b[201~\r", false],
			["a split paste marker erased with Backspace", "\x1b[200", "~\x7fy\n\x1b[201~\r", false],
			["a paste erased with Ctrl+U before a typed yes", "", "\x1b[200~text\x1b[201~\x15y\r", false],
			["a typed yes", "", "y\r", true],
		])("answers a bash approval from %s", async (_name, before, after, approved) => {
			const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };
			const h = harness([[step, { event: finished }]], {
				raw: true,
				answers: [after],
				keepStdinOpen: true,
				sandbox: false,
			});
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
			const declared: FakeStep = {
				toolCall: { tool: "risk", input: { none: true, reason: "test" }, callId: "c-risk" },
			};
			const h = harness([[declared, { event: { type: "text_delta", text: "done" } }, { event: finished }]], {
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

		it.each([
			["Ctrl+C", (h: ReturnType<typeof harness>) => (h.io.stdin as PassThrough).write("\x03"), 130],
			["SIGTERM", (h: ReturnType<typeof harness>) => h.terminate(15), 143],
		])("leaves the terminal as it was on %s while the session is starting", async (_name, send, code) => {
			const h = harness([], { raw: true, input: [], keepStdinOpen: true });
			const starting = { id: "starting", start: () => new Promise<never>(() => {}) };
			void run([], h.io, () => starting);
			await until(() => h.out().includes("\x1b[?2004h"));
			send(h);
			await until(() => h.exits.length > 0);
			expect(h.exits).toEqual([code]);
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
		expect(child.startOptions?.tools.map((t) => t.name)).toEqual(["read", "grep", "web_fetch", "web_search"]);
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
		expect(help.out()).toContain("atelier update [vX.Y.Z | --main]");
		expect(help.out()).toContain("atelier desktop");
		expect(help.out()).toContain("ATELIER_MEMORY=off");
		expect(help.backend.startOptions).toBeUndefined();

		const version = harness([]);
		expect(await run(["--version"], version.io, version.createBackend)).toBe(0);
		expect(version.out()).toBe(`atelier ${VERSION}\n`);
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
	const CONSENT_QUESTION =
		"Review this high-risk change? y: review this change · N: skip this time · a: review all this session\n";
	const declared: FakeStep = { toolCall: { tool: "risk", input: { none: true, reason: "test" }, callId: "c-risk" } };
	const mainTurn: FakeStep[] = [declared, { event: { type: "text_delta", text: "done" } }, { event: finished }];
	const noFindings: FakeStep[] = [{ event: { type: "text_delta", text: '{"findings": []}' } }, { event: finished }];
	const lenses = (n: number) => Array.from({ length: n }, () => noFindings);
	const reviewLines = (out: string) => out.split("\n").filter((line) => line.includes("review"));

	it("asks on a terminal with the question and its answers only, and reviews when the answer is yes", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, answers: ["y"] });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.out()).toContain(`${CONSENT_QUESTION}[y/N/a] `);
		expect(h.out()).not.toContain("  reasons: ");
		expect(h.backend.prompts).toHaveLength(5);
		expect(h.out()).toMatch(/✓ review approved · receipt \.git\/atelier\/reviews\/[0-9a-f]+-[A-Za-z0-9_.-]+\.json\n/);
	});

	it("runs only the lenses the agent chose", async () => {
		await repoWithChange("src/auth.ts");
		const input = { none: true, reason: "test", lenses: ["readability"], lensesReason: "renames the output" };
		const chose: FakeStep = { toolCall: { tool: "risk", input, callId: "c-risk" } };
		const turn: FakeStep[] = [chose, { event: { type: "text_delta", text: "done" } }, { event: finished }];
		const h = harness([turn, ...lenses(2)], { isTTY: true, answers: ["y"] });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(3);
		expect(h.out()).toContain("✓ review approved");
	});

	// The core's tests show that the session's later high-risk changes are then reviewed without asking.
	it("reviews when the answer is a", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, answers: ["a"] });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(5);
		expect(h.out()).toContain("✓ review approved");
	});

	it("ignores a yes typed before the review question", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: ["y"], answers: [""], keepStdinOpen: true });
		expect(await run(["change it"], h.io, h.createBackend)).toBe(0);
		expect(h.out()).toContain("ignored 1 line typed before this question\nReview this high-risk change?");
		expect(h.backend.prompts).toHaveLength(1);
		expect(reviewLines(h.out())).toContain("◇ review declined");
	});

	it("prints the risk line before the question", async () => {
		await repoWithChange("src/auth.ts");
		const h = harness([mainTurn, ...lenses(4)], { isTTY: true, input: ["n"] });
		await run(["change it"], h.io, h.createBackend);
		expect(h.out().indexOf("◇ review high · 4 lenses")).toBeGreaterThan(-1);
		expect(h.out().indexOf("◇ review high · 4 lenses")).toBeLessThan(h.out().indexOf("Review this high-risk change?"));
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
		await vi.waitFor(() => expect(h.out()).toContain("Review this high-risk change?"), { timeout: 5000 });
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

	it("runs /review <ref> against that ref and names the commit on the risk line", async () => {
		await repoWithChange("notes.ts");
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
		await writeFile(join(cwd, "second.ts"), "export const y = 2;\n");
		git("add", "second.ts");
		git("commit", "-qm", "second");
		const h = harness([noFindings], { input: ["/review HEAD~1"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(1);
		expect(h.backend.prompts[0]).toContain("second.ts");
		expect(h.out()).toContain(`since ${git("rev-parse", "HEAD~1").trim().slice(0, 7)}`);
	});

	it("refuses /review with an unknown ref without starting a review", async () => {
		await repoWithChange("notes.ts");
		const h = harness([noFindings], { input: ["/review nope"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.err()).toContain('Unknown git ref "nope": there is nothing to review against.');
		expect(h.backend.prompts).toEqual([]);
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

	it("runs /undo-correction as a turn of its own, and says when there is no correction to undo", async () => {
		await repoWithChange("notes.ts");
		const h = harness([], { input: ["/undo-correction"] });
		expect(await run([], h.io, h.createBackend)).toBe(0);
		expect(h.err()).toContain("No escalated review of this repository left a correction to undo.");
		expect(h.backend.prompts).toEqual([]);
		expect(h.out()).toContain("tokens: ");
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

describe("M9 baseline non-TTY output", () => {
	it.each([false, true])("preserves 5ac658d output with --no-review (interactive=%s)", async (interactive) => {
		const done: FakeStep = {
			event: {
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			},
		};
		const reply = (value: string): FakeStep[] => [{ event: { type: "text_delta", text: value } }, done];
		const h = harness(
			interactive ? [reply("first answer"), reply("second answer")] : [reply("hello")],
			interactive ? { input: ["first", "", "second"] } : {},
		);
		const code = await run(interactive ? ["--no-review"] : ["--no-review", "say hi"], h.io, h.createBackend);
		const tokens = "tokens: input 1 · output 1 · cache read 0 · cache write 0 · cache 0%\n";
		// Since M10 the first turn also says whether bash is sandboxed, once.
		const sandbox = "bash: sandboxed (macOS seatbelt)\n";
		expect({ code, stdout: h.out(), stderr: h.err() }).toEqual({
			code: 0,
			stdout: interactive ? `${sandbox}first answer\n${tokens}second answer\n${tokens}` : `${sandbox}hello\n${tokens}`,
			stderr: "no review: Review is off (--no-review or ATELIER_REVIEW=off).\n",
		});
	});
});

describe("bash outside the sandbox", () => {
	const SANDBOX_OFF = "sandbox turned off for this session";
	const bash = (input: Record<string, string | boolean>): FakeStep => ({ toolCall: { tool: "bash", input } });
	const EFFECT = "every command asks for approval in normal mode, and goes to the classifier in auto mode";

	it("asks every command with --no-sandbox, even with --yes, and warns once per turn", async () => {
		const turn = [bash({ command: "echo one" }), bash({ command: "echo two" }), { event: finished }];
		const h = harness([turn], { isTTY: true, answers: ["y", "n"] });
		await run(["--no-sandbox", "--yes", "x"], h.io, h.createBackend);
		expect(h.out().match(/Run this command\?/g)).toHaveLength(2);
		expect(h.backend.toolResults.map((result) => result.ok)).toEqual([true, false]);
		// The first turn says it once, in the status line; the warning that follows would repeat it.
		const status = `bash: not sandboxed (${SANDBOX_OFF}): ${EFFECT}\n`;
		expect(h.err()).toContain(status);
		expect(h.err().match(/not sandboxed|without a sandbox/g)).toHaveLength(1);
	});

	it("reads ATELIER_SANDBOX=off like --no-sandbox", async () => {
		const h = harness([[bash({ command: "echo one" }), { event: finished }]], {
			isTTY: true,
			answers: ["y"],
			env: { ATELIER_SANDBOX: "off" },
		});
		await run(["--yes", "x"], h.io, h.createBackend);
		expect(h.out()).toContain('Run this command?\n  echo one\n  s: Allow "echo one" in this session\n[y/N/s] ');
		expect(h.err()).toContain(`bash: not sandboxed (${SANDBOX_OFF})`);
	});

	it("denies a command that must be asked when there is no terminal, --yes or not, and says why", async () => {
		await writeFile(join(cwd, "marker"), "");
		const h = harness([[bash({ command: "rm marker" }), { event: finished }]]);
		await run(["--no-sandbox", "--yes", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(h.err()).toContain(
			"bash command needs approval and there is no terminal to ask; the sandbox is off or unavailable (--mode yolo allows it): rm marker\n",
		);
		expect(await readFile(join(cwd, "marker"), "utf8")).toBe("");
	});

	it("denies a command in yolo when the sandbox failed to start and there is no terminal, and says why", async () => {
		await writeFile(join(cwd, "marker"), "");
		const h = harness([[bash({ command: "rm marker" }), { event: finished }]], { sandbox: "failed" });
		await run(["--mode", "yolo", "--no-review", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(h.err()).toContain(
			"bash command needs approval and there is no terminal to ask; the sandbox failed to start: rm marker\n",
		);
		expect(await readFile(join(cwd, "marker"), "utf8")).toBe("");
	});

	it("does not offer yolo for a request to leave a sandbox that failed to start, without a terminal", async () => {
		const h = harness(
			[[bash({ command: "printf x", unsandboxed: true, reason: "needs the network" }), { event: finished }]],
			{ sandbox: "failed" },
		);
		await run(["--mode", "yolo", "--no-review", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(h.err()).toContain(
			"bash command asks to run outside the sandbox and needs your approval, but there is no terminal to ask: printf x\n  reason: needs the network\n",
		);
		expect(h.err()).not.toContain("--mode yolo allows it");
	});

	it("warns again in the next turns, which the status line did not cover", async () => {
		const turn = [bash({ command: "echo one" }), { event: finished }];
		const h = harness([turn, turn], { input: ["first", "second"] });
		await run(["--no-sandbox", "--no-review"], h.io, h.createBackend);
		const effect = EFFECT;
		expect(h.err().match(new RegExp(`^bash: not sandboxed \\(${SANDBOX_OFF}\\): ${effect}$`, "gm"))).toHaveLength(1);
		expect(
			h.err().match(new RegExp(`^warning: bash runs without a sandbox \\(${SANDBOX_OFF}\\): ${effect}$`, "gm")),
		).toHaveLength(1);
	});

	const leave = { command: "echo outside", unsandboxed: true, reason: "pnpm install needs the network" };

	it("asks to leave the sandbox with the reason, even with --yes, and runs it on yes", async () => {
		const h = harness([[bash(leave), { event: finished }]], { isTTY: true, answers: ["y"] });
		await run(["--yes", "x"], h.io, h.createBackend);
		expect(h.out()).toContain(
			'Run this command OUTSIDE the sandbox?\n  echo outside\n  reason: pnpm install needs the network\n  s: Allow "echo outside" in this session\n[y/N/s] ',
		);
		expect(h.backend.toolResults[0]?.ok).toBe(true);
		expect(h.backend.toolResults[0]?.output).toContain("outside");
	});

	it("does not leave the sandbox on no", async () => {
		const h = harness([[bash(leave), { event: finished }]], { isTTY: true, answers: ["n"] });
		await run(["--yes", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
	});

	it.each([
		["normal", ["--mode", "normal"]],
		["auto", ["--mode", "auto"]],
		["yolo", ["--mode", "yolo"]],
	])("asks about a recursive removal inside the sandbox in %s, naming the guard rule", async (_mode, flags) => {
		await mkdir(join(cwd, "build"));
		const h = harness([[bash({ command: "rm -r build" }), { event: finished }]], { isTTY: true, answers: ["y"] });
		await run([...flags, "x"], h.io, h.createBackend);
		expect(h.out()).toContain("Run this command? (guard: recursive removal)\n  rm -r build\n[y/N] ");
		expect(h.backend.toolResults[0]?.ok).toBe(true);
		expect(await exists(join(cwd, "build"))).toBe(false);
	});

	it("leaves the directory alone when a guard question is answered no", async () => {
		await mkdir(join(cwd, "build"));
		const h = harness([[bash({ command: "rm -r build" }), { event: finished }]], { isTTY: true, answers: ["n"] });
		await run(["--mode", "yolo", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(await exists(join(cwd, "build"))).toBe(true);
	});

	it("names the rule and the reason when a guard question also leaves the sandbox", async () => {
		const publish = { command: "npm publish --dry-run", unsandboxed: true, reason: "needs the registry" };
		const h = harness([[bash(publish), { event: finished }]], { isTTY: true, answers: ["n"] });
		await run(["x"], h.io, h.createBackend);
		expect(h.out()).toContain(
			"Run this command OUTSIDE the sandbox? (guard: npm publish)\n  npm publish --dry-run\n  reason: needs the registry\n[y/N] ",
		);
	});

	it("refuses a guard question without a terminal, in every mode, and says which rule asks", async () => {
		for (const flags of [[], ["--mode", "auto"], ["--mode", "yolo"]]) {
			await mkdir(join(cwd, "build"), { recursive: true });
			const h = harness([[bash({ command: "rm -r build" }), { event: finished }]]);
			await run([...flags, "x"], h.io, h.createBackend);
			expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
			expect(h.err()).toContain(
				"bash command matches a guard rule (recursive removal) and needs your approval, but there is no terminal to ask: rm -r build\n",
			);
			expect(await exists(join(cwd, "build"))).toBe(true);
		}
	});

	it("does not ask about a plain push in yolo, and has no one to ask about it in normal", async () => {
		const push = { command: "git push -u origin feat" };
		const yolo = harness([[bash(push), { event: finished }]], { isTTY: true, input: [] });
		await run(["--mode", "yolo", "x"], yolo.io, yolo.createBackend);
		expect(yolo.out()).not.toContain("[y/N]");
		expect(yolo.err()).not.toContain("guard rule");

		const normal = harness([[bash(push), { event: finished }]], { isTTY: true, answers: ["n"] });
		await run(["x"], normal.io, normal.createBackend);
		expect(normal.out()).toContain("Run this command? (guard: git push)\n  git push -u origin feat\n[y/N] ");
	});

	it("refuses to leave the sandbox without a terminal, even with --yes", async () => {
		await writeFile(join(cwd, "marker"), "");
		const h = harness([[bash({ command: "rm marker", unsandboxed: true, reason: "cleanup" }), { event: finished }]]);
		await run(["--yes", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(h.err()).toContain(
			"bash command asks to run outside the sandbox and needs your approval, but there is no terminal to ask (--mode yolo allows it): rm marker\n  reason: cleanup\n",
		);
		expect(await readFile(join(cwd, "marker"), "utf8")).toBe("");
	});

	it("shows control characters of the reason instead of running them", async () => {
		const h = harness([[bash({ ...leave, reason: "install\x1b[2Jnow" }), { event: finished }]], {
			isTTY: true,
			answers: ["n"],
		});
		await run(["x"], h.io, h.createBackend);
		expect(h.out()).not.toContain("\x1b[2J");
	});

	describe("an edit outside the working directory", () => {
		let elsewhere: string;
		beforeEach(async () => {
			elsewhere = await realpath(await mkdtemp(join(tmpdir(), "atelier-cli-elsewhere-")));
			await writeFile(join(elsewhere, "note.txt"), "old\n");
		});
		afterEach(async () => {
			await rm(elsewhere, { recursive: true, force: true });
		});
		const edit = (path: string): FakeStep => ({
			toolCall: { tool: "edit", input: { path, edits: [{ oldText: "old", newText: "new" }] } },
		});

		it("asks with the absolute path, even with --yes, and edits on yes", async () => {
			const h = harness([[edit(join(elsewhere, "note.txt")), { event: finished }]], { isTTY: true, answers: ["y"] });
			await run(["--yes", "x"], h.io, h.createBackend);
			expect(h.out()).toContain(
				`Edit a file outside the working directory?\n  ${join(elsewhere, "note.txt")}\n  s: Allow edits in ${elsewhere} in this session\n[y/N/s] `,
			);
			expect(h.out()).not.toContain("Run this command");
			expect(h.backend.toolResults[0]?.ok).toBe(true);
			expect(await readFile(join(elsewhere, "note.txt"), "utf8")).toBe("new\n");
		});

		it("leaves the file alone and shows the denial on no", async () => {
			const h = harness([[edit(join(elsewhere, "note.txt")), { event: finished }]], { isTTY: true, answers: ["n"] });
			await run(["x"], h.io, h.createBackend);
			expect(h.backend.toolResults[0]).toEqual({
				ok: false,
				output: `Not edited: ${join(elsewhere, "note.txt")} is outside the working directory and the user did not approve editing it.`,
			});
			expect(h.out()).toContain("▸ edit Not edited: ");
			expect(await readFile(join(elsewhere, "note.txt"), "utf8")).toBe("old\n");
		});

		it("says there is no terminal to ask, even with --yes, and leaves the file alone", async () => {
			const h = harness([[edit(join(elsewhere, "note.txt")), { event: finished }]]);
			await run(["--yes", "x"], h.io, h.createBackend);
			expect(h.err()).toContain(
				`edit asks to change a file outside the working directory and needs your approval, but there is no terminal to ask (--mode yolo allows it): ${join(elsewhere, "note.txt")}\n`,
			);
			expect(await readFile(join(elsewhere, "note.txt"), "utf8")).toBe("old\n");
		});

		it("edits inside the working directory without asking", async () => {
			await writeFile(join(cwd, "in.txt"), "old\n");
			const h = harness([[edit("in.txt"), { event: finished }]], { isTTY: true });
			await run(["x"], h.io, h.createBackend);
			expect(h.out()).not.toContain("[y/N]");
			expect(await readFile(join(cwd, "in.txt"), "utf8")).toBe("new\n");
		});
	});

	describe("an MCP call the classifier left to the user", () => {
		// What mcp_call's gate gives the session in auto when the classifier does not decide.
		const mcpCall = defineTool({
			name: "mcp_call",
			description: "call",
			inputShape: {},
			gate: async () => ({ approval: { command: 'docs › search {"q":"x"}', tool: "mcp_call" } }),
			execute: async () => ({ ok: true, output: "found", summary: "docs › search", truncated: false }),
		});
		const step: FakeStep = { toolCall: { tool: "mcp_call", input: {} } };

		it("asks to call the MCP tool, with its server, tool and arguments", async () => {
			const h = harness([[step, { event: finished }]], { isTTY: true, answers: ["y"], extraTools: [mcpCall] });
			await run(["x"], h.io, h.createBackend);
			expect(h.out()).toContain('Call this MCP tool?\n  docs › search {"q":"x"}\n[y/N] ');
			expect(h.out()).not.toContain("Run this command");
			expect(h.backend.toolResults[0]).toEqual({ ok: true, output: "found" });
		});

		it("says why it is refused without a terminal", async () => {
			const h = harness([[step, { event: finished }]], { extraTools: [mcpCall] });
			await run(["x"], h.io, h.createBackend);
			expect(h.err()).toContain(
				'MCP call needs your approval because the permission classifier did not decide, but there is no terminal to ask: docs › search {"q":"x"}\n',
			);
			expect(h.backend.toolResults[0]?.ok).toBe(false);
		});
	});

	describe("a write outside the working directory", () => {
		let elsewhere: string;
		beforeEach(async () => {
			elsewhere = await realpath(await mkdtemp(join(tmpdir(), "atelier-cli-elsewhere-")));
		});
		afterEach(async () => {
			await rm(elsewhere, { recursive: true, force: true });
		});
		const write = (path: string): FakeStep => ({ toolCall: { tool: "write", input: { path, content: "made\n" } } });

		it("asks with the absolute path, even with --yes, and writes on yes", async () => {
			const target = join(elsewhere, "deep", "made.txt");
			const h = harness([[write(target), { event: finished }]], { isTTY: true, answers: ["y"] });
			await run(["--yes", "x"], h.io, h.createBackend);
			expect(h.out()).toContain(
				`Write a file outside the working directory?\n  ${target}\n  s: Allow edits in ${join(elsewhere, "deep")} in this session\n[y/N/s] `,
			);
			expect(h.out()).not.toContain("Run this command");
			expect(h.out()).toContain(`▸ write ${target} (5 bytes) ✓\n`);
			expect(await readFile(target, "utf8")).toBe("made\n");
		});

		it("leaves the disk alone and shows the denial on no", async () => {
			const target = join(elsewhere, "made.txt");
			const h = harness([[write(target), { event: finished }]], { isTTY: true, answers: ["n"] });
			await run(["x"], h.io, h.createBackend);
			expect(h.backend.toolResults[0]).toEqual({
				ok: false,
				output: `Not written: ${target} is outside the working directory and the user did not approve writing it.`,
			});
			expect(h.out()).toContain("▸ write Not written: ");
			await expect(readFile(target, "utf8")).rejects.toThrow();
		});

		it("says there is no terminal to ask, even with --yes, and writes nothing", async () => {
			const target = join(elsewhere, "made.txt");
			const h = harness([[write(target), { event: finished }]]);
			await run(["--yes", "x"], h.io, h.createBackend);
			expect(h.err()).toContain(
				`write asks to create or replace a file outside the working directory and needs your approval, but there is no terminal to ask (--mode yolo allows it): ${target}\n`,
			);
			await expect(readFile(target, "utf8")).rejects.toThrow();
		});

		it("writes inside the working directory without asking", async () => {
			const h = harness([[write("in.txt"), { event: finished }]], { isTTY: true });
			await run(["x"], h.io, h.createBackend);
			expect(h.out()).not.toContain("[y/N]");
			expect(await readFile(join(cwd, "in.txt"), "utf8")).toBe("made\n");
		});
	});

	it("refuses a destructive command without asking, with --yes", async () => {
		const h = harness([[bash({ command: "sudo -n true" }), { event: finished }]], { isTTY: true });
		await run(["--yes", "x"], h.io, h.createBackend);
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "Refused: sudo — sudo -n true" });
		expect(h.out()).not.toContain("Run this command");
		expect(h.out()).toContain("▸ bash Refused: sudo — sudo -n true ✗\n");
	});
});

describe("sandbox configuration", () => {
	const reply: FakeStep[] = [{ event: started }, { event: { type: "text_delta", text: "hello" } }, { event: finished }];
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "atelier-cli-home-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});
	const configure = async (dir: string, config: string) => {
		await mkdir(join(dir, ".atelier"), { recursive: true });
		await writeFile(join(dir, ".atelier", "sandbox.json"), config);
	};

	it("stops before anything runs, with the file and the problem, when the project file is invalid", async () => {
		await configure(cwd, '{ "allowWrite": ["~/.ssh"] }');
		const h = harness([reply], { home });
		expect(await run(["say hi"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe(
			`error: Invalid sandbox configuration ${join(cwd, ".atelier", "sandbox.json")}: allowWrite entry "~/.ssh" is refused: it would make ${join(await realpath(home), ".ssh")} writable, and that path stays protected\n`,
		);
		expect(h.out()).toBe("");
		expect(h.backend.prompts).toEqual([]);
	});

	it("stops, naming the user file, when that one has an unknown key", async () => {
		await configure(home, '{ "allowRead": [] }');
		const h = harness([reply], { home });
		expect(await run(["say hi"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe(
			`error: Invalid sandbox configuration ${join(home, ".atelier", "sandbox.json")}: unknown key "allowRead" (the keys are "allowWrite" and "denyRead")\n`,
		);
		expect(h.backend.prompts).toEqual([]);
	});

	it("starts with valid files", async () => {
		await configure(home, '{ "allowWrite": ["~/work"] }');
		await configure(cwd, '{ "denyRead": ["private"] }');
		const h = harness([reply], { home });
		expect(await run(["say hi"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toEqual(["say hi"]);
	});

	it("does not read the files with --no-sandbox, where they would not apply", async () => {
		await configure(cwd, "{ nope");
		const h = harness([reply], { home });
		expect(await run(["--no-sandbox", "say hi"], h.io, h.createBackend)).toBe(0);
		expect(h.err()).not.toContain("Invalid sandbox configuration");
	});

	it("still prints help and version with an invalid file", async () => {
		await configure(cwd, "{ nope");
		const h = harness([], { home });
		expect(await run(["--version"], h.io, h.createBackend)).toBe(0);
		expect(h.err()).toBe("");
	});
});

describe("running as root", () => {
	const reply: FakeStep[] = [{ event: started }, { event: { type: "text_delta", text: "hello" } }, { event: finished }];
	const CONSENT = { ATELIER_ALLOW_ROOT: "I accept the risk" };

	it("refuses to start without the exact consent, before anything runs", async () => {
		const h = harness([reply], { uid: 0 });
		expect(await run(["say hi"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe(
			'error: Atelier will not run as root (uid 0): a mistaken command could damage the whole system. To run as root anyway, set ATELIER_ALLOW_ROOT="I accept the risk" (exactly that text).\n',
		);
		expect(h.out()).toBe("");
		expect(h.backend.prompts).toEqual([]);
	});

	it.each(["yes", "1", "i accept the risk", "I accept the risk "])(
		"does not take ATELIER_ALLOW_ROOT=%j as consent",
		async (given) => {
			const h = harness([reply], { uid: 0, env: { ATELIER_ALLOW_ROOT: given } });
			expect(await run(["say hi"], h.io, h.createBackend)).toBe(1);
			expect(h.err()).toContain(`ATELIER_ALLOW_ROOT is set to ${JSON.stringify(given)}, which is not that exact text.`);
			expect(h.backend.prompts).toEqual([]);
		},
	);

	it("starts with the exact consent and repeats the warning on every start", async () => {
		const warning =
			"warning: running as root (uid 0) because ATELIER_ALLOW_ROOT is set: every command has full control of this system.\n";
		for (let start = 0; start < 2; start++) {
			const h = harness([reply], { uid: 0, env: CONSENT });
			expect(await run(["say hi"], h.io, h.createBackend)).toBe(0);
			expect(h.err()).toContain(warning);
			expect(h.err().match(/running as root/g)).toHaveLength(1);
			expect(h.backend.prompts).toEqual(["say hi"]);
		}
	});

	it("says nothing to a normal user, with or without the variable", async () => {
		const h = harness([reply], { uid: 501, env: CONSENT });
		expect(await run(["say hi"], h.io, h.createBackend)).toBe(0);
		expect(h.err()).not.toContain("root");
	});

	it("still prints help and version as root", async () => {
		const h = harness([], { uid: 0 });
		expect(await run(["--version"], h.io, h.createBackend)).toBe(0);
		expect(h.out()).toMatch(/^atelier \d/);
		expect(h.err()).toBe("");
	});
});

describe("agent profiles", () => {
	const profiles = (body: object) =>
		JSON.stringify({ kind: "atelier.agent_model_profiles", version: 1, active: "p", profiles: { p: body } });
	/** A home with `~/.atelier/profiles.json` holding the profile `p`, active. */
	async function homeWith(body: object): Promise<string> {
		const home = await mkdtemp(join(tmpdir(), "atelier-cli-home-"));
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "profiles.json"), profiles(body));
		return home;
	}
	/** Runs one turn; `names` are the backends the CLI asked for, in order. */
	async function start(argv: string[], body: object | undefined) {
		const home = body === undefined ? await mkdtemp(join(tmpdir(), "atelier-cli-home-")) : await homeWith(body);
		try {
			const h = harness([[{ event: finished }]], { home });
			const names: (string | undefined)[] = [];
			const code = await run(argv, h.io, (name) => {
				names.push(name);
				return h.backend;
			});
			return { h, names, code, home };
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	it("starts the main agent as always when there are no profile files", async () => {
		const { h, names, code } = await start(["x"], undefined);
		expect(code).toBe(0);
		expect(names).toEqual(["claude-code"]);
		expect(h.backend.startOptions?.model).toBeUndefined();
		expect(h.backend.startOptions).not.toHaveProperty("thinking");
		expect(h.err()).not.toContain("profile");
	});

	it("names the orchestrator and backend when its API key is missing", async () => {
		const home = await homeWith({ orchestrator: { model: "anthropic-api/claude-sonnet-5-5" } });
		try {
			const h = harness([], { home });
			const names: string[] = [];
			const code = await run(["x"], h.io, (name) => {
				names.push(name);
				throw new MissingApiKeyError("No test key.");
			});
			expect(code).toBe(1);
			expect(names).toEqual(["anthropic-api"]);
			expect(h.err()).toBe("error: orchestrator: anthropic-api has no API key (No test key.)\n");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("keeps the plain error when no profile names the backend", async () => {
		const h = harness([]);
		const code = await run(["x"], h.io, () => {
			throw new MissingApiKeyError("No test key.");
		});
		expect(code).toBe(1);
		expect(h.err()).toBe("error: No test key.\n");
	});

	it("gives the main agent the orchestrator's backend, model and thinking level", async () => {
		const { h, names } = await start(["x"], {
			orchestrator: { model: "anthropic-api/claude-opus-5-5", thinking: "high" },
		});
		expect(names).toEqual(["anthropic-api"]);
		expect(h.backend.startOptions).toMatchObject({ model: "claude-opus-5-5", thinking: "high" });
	});

	it("lets --backend and --model win over the orchestrator's", async () => {
		const { h, names } = await start(["--backend", "claude-code", "--model", "sonnet", "x"], {
			orchestrator: { model: "anthropic-api/claude-opus-5-5", thinking: "high" },
		});
		expect(names).toEqual(["claude-code"]);
		expect(h.backend.startOptions).toMatchObject({ model: "sonnet", thinking: "high" });
	});

	it("starts the backend a prefixed --model names, over the orchestrator's", async () => {
		const { h, names } = await start(["--model", "openai-codex/gpt-6-luna", "x"], {
			orchestrator: { model: "anthropic-api/claude-opus-5-5" },
		});
		expect(names).toEqual(["openai-codex"]);
		expect(h.backend.startOptions).toMatchObject({ model: "gpt-6-luna" });
	});

	it("takes --profile over the active one, with --model still replacing the orchestrator's model", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-cli-home-"));
		try {
			await mkdir(join(home, ".atelier"));
			const q = { orchestrator: { model: "anthropic-api/claude-opus-5-5", thinking: "low" } };
			await writeFile(
				join(home, ".atelier", "profiles.json"),
				JSON.stringify({ kind: "atelier.agent_model_profiles", version: 1, active: "p", profiles: { p: {}, q } }),
			);
			const onApi = { type: "session_started", backend: "anthropic-api", model: "sonnet", authSource: "api_key" };
			const h = harness([[{ event: onApi as AtelierEventBody }, { event: finished }]], { home });
			const names: string[] = [];
			const code = await run(["--profile", "q", "--model", "sonnet", "x"], h.io, (name) => {
				names.push(name);
				return h.backend;
			});
			expect(code).toBe(0);
			expect(names).toEqual(["anthropic-api"]);
			expect(h.backend.startOptions).toMatchObject({ model: "sonnet", thinking: "low" });
			expect(h.out()).toContain("profile q (explicit)\n");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("refuses --profile when there is no home to read profiles from", async () => {
		const h = harness([[{ event: finished }]]);
		const code = await run(["--profile", "q", "x"], h.io, () => h.backend);
		expect(code).toBe(1);
		expect(h.err()).toBe("error: --profile needs a home directory to read ~/.atelier/profiles.json from.\n");
	});

	it("prints what the profile files dropped as warnings and still runs", async () => {
		const { h, code } = await start(["x"], { verifer: { model: "x" } });
		expect(code).toBe(0);
		expect(h.err()).toMatch(
			/^error: \S+\/\.atelier\/profiles\.json: profile "p": unknown role "verifer", did you mean "verifier"\?, dropped\n/,
		);
	});
});

describe("permission modes", () => {
	const bash = (command: string): FakeStep => ({ toolCall: { tool: "bash", input: { command } } });
	const modeFile = (home: string) => join(home, ".atelier", ["permission", "mode.json"].join("-"));
	const writeModeFile = async (home: string, text: string) => {
		await mkdir(join(home, ".atelier"), { recursive: true });
		await writeFile(modeFile(home), text);
	};
	const turn = [{ event: started }, bash("echo hi"), { event: finished }];
	const denied = { ok: false, output: "The user denied this command." };
	const withHome = async (body: (home: string) => Promise<void>) => {
		const home = await mkdtemp(join(tmpdir(), "atelier-cli-home-"));
		try {
			await body(home);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	};

	it("runs an unsandboxed command without asking with --mode yolo, and the header says so", async () => {
		const h = harness([turn], { sandbox: false });
		expect(await run(["--mode", "yolo", "--no-review", "x"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.toolResults[0]?.ok).toBe(true);
		expect(h.out()).toContain("atelier · fake · m · subscription · mode yolo\n");
		expect(h.err()).not.toContain("needs approval");
	});

	it("keeps the header of the normal mode as it was", async () => {
		const h = harness([turn], { sandbox: false });
		await run(["--no-review", "x"], h.io, h.createBackend);
		expect(h.out()).toMatch(/^atelier · fake · m · subscription\n/);
		expect(h.out()).not.toContain("mode");
		expect(h.backend.toolResults[0]).toEqual(denied);
	});

	it("rejects an unknown --mode as a usage error", async () => {
		const h = harness([]);
		expect(await run(["--mode", "bogus", "x"], h.io, h.createBackend)).toBe(2);
		expect(h.err()).toBe("error: --mode must be normal, auto or yolo.\nRun atelier --help for usage.\n");
		expect(h.out()).toBe("");
	});

	it("uses the default mode saved in the home when --mode is absent", () =>
		withHome(async (home) => {
			await writeModeFile(home, '{ "kind": "atelier.permission_mode", "version": 1, "default": "yolo" }');
			const h = harness([turn], { sandbox: false, home });
			await run(["--no-review", "x"], h.io, h.createBackend);
			expect(h.backend.toolResults[0]?.ok).toBe(true);
			expect(h.out()).toContain("· mode yolo\n");
		}));

	it("reads the default from the user's home when the CLI has none", async () => {
		await writeModeFile(fallbackHome, '{ "kind": "atelier.permission_mode", "version": 1, "default": "auto" }');
		const h = harness([turn]);
		await run(["--no-review", "x"], h.io, h.createBackend);
		expect(h.out()).toContain("· mode auto\n");
	});

	it("warns about an invalid default file once and runs in normal", () =>
		withHome(async (home) => {
			await writeModeFile(home, "not json");
			const h = harness([turn], { sandbox: false, home });
			expect(await run(["--no-review", "x"], h.io, h.createBackend)).toBe(0);
			expect(h.err().match(/mode\.json: not valid JSON; using normal\n/g)).toHaveLength(1);
			expect(h.err()).toContain("error: ");
			expect(h.out()).not.toContain("mode");
			expect(h.backend.toolResults[0]).toEqual(denied);
		}));

	it("takes --yes as --mode normal and warns once", async () => {
		const warning =
			"warning: --yes is deprecated: normal, the default mode, already runs sandboxed commands without asking; use --mode\n";
		const h = harness([turn], { sandbox: false });
		await run(["--yes", "--no-review", "x"], h.io, h.createBackend);
		expect(h.err().split(warning)).toHaveLength(2);
		expect(h.out()).not.toContain("mode");
		expect(h.backend.toolResults[0]).toEqual(denied);
	});

	it("lets --mode win over --yes, and still warns", async () => {
		const h = harness([turn], { sandbox: false });
		await run(["--yes", "--mode", "yolo", "--no-review", "x"], h.io, h.createBackend);
		expect(h.err()).toContain("warning: --yes is deprecated");
		expect(h.backend.toolResults[0]?.ok).toBe(true);
	});

	it("ignores the default file with --yes, which is --mode normal", async () => {
		await writeModeFile(fallbackHome, '{ "kind": "atelier.permission_mode", "version": 1, "default": "yolo" }');
		const h = harness([turn]);
		await run(["--yes", "--no-review", "x"], h.io, h.createBackend);
		expect(h.out()).not.toContain("mode");
	});

	describe("MCP servers", () => {
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../atelier-core/test/fixtures/mcp/server.ts");
		// Started, as openMcp gives it.
		const manager = (servers: McpServerConfig[], problems: { name?: string; message: string }[] = []) => {
			const created = new McpManager({
				file: "/h/.atelier/mcp.json",
				servers,
				problems,
				secrets: ["lit-secret-token"],
			});
			created.start();
			return created;
		};
		const stdio = (name: string, env: Record<string, string> = {}): McpServerConfig => ({
			name,
			transport: "stdio",
			enabled: true,
			timeoutMs: 10_000,
			command: process.execPath,
			args: [fixture],
			env,
			cwd,
		});

		it("atelier mcp list connects every server, prints its state and tools, and exits 0 when all are up", async () => {
			const h = harness([]);
			const code = await run(["mcp", "list"], h.io, h.createBackend, undefined, () =>
				manager([stdio("fixture"), { ...stdio("off"), enabled: false }]),
			);
			expect(code).toBe(0);
			expect(h.out()).toBe(
				["fixture (stdio): connected, 5 tools", "  echo, big, fail, image, slow", "off (stdio): disabled", ""].join(
					"\n",
				),
			);
			expect(h.backend.prompts).toEqual([]);
		});

		it("atelier mcp list exits 1 with the errors and stderr of failed servers, invalid entries and file problems, secrets hidden", async () => {
			const h = harness([]);
			const code = await run(["mcp", "list"], h.io, h.createBackend, undefined, () =>
				manager(
					[stdio("broken", { MCP_EXIT: "3", MCP_STDERR: "bad token lit-secret-token" })],
					[{ name: "bad", message: '"timeout" must be a positive number of seconds' }, { message: "the file is odd" }],
				),
			);
			expect(code).toBe(1);
			expect(h.out()).toContain("broken (stdio): failed: ");
			expect(h.out()).toContain("  stderr:\n    bad token ***\n");
			expect(h.out()).toContain('bad: invalid: "timeout" must be a positive number of seconds\n');
			expect(h.out()).toContain("problem: the file is odd\n");
			expect(h.out()).not.toContain("lit-secret-token");
		});

		it("atelier mcp list says where to configure servers when there are none", async () => {
			const h = harness([]);
			expect(await run(["mcp", "list"], h.io, h.createBackend, undefined, () => manager([]))).toBe(0);
			expect(h.out()).toBe("No MCP servers: configure them in /h/.atelier/mcp.json.\n");
		});

		it("atelier mcp needs list, or login or logout with a server", async () => {
			for (const argv of [["mcp"], ["mcp", "login"], ["mcp", "logout", "a", "b"], ["mcp", "list", "x"]]) {
				const h = harness([]);
				expect(await run(argv, h.io, h.createBackend)).toBe(2);
				expect(h.err()).toContain("Usage: atelier mcp list | atelier mcp login <server> | atelier mcp logout <server>");
			}
		});

		it("atelier mcp login and logout say why they cannot sign a server in", async () => {
			for (const action of ["login", "logout"]) {
				const h = harness([]);
				const code = await run(["mcp", action, "nope"], h.io, h.createBackend, undefined, () => manager([]));
				expect(code).toBe(1);
				expect(h.err()).toBe('error: No MCP server named "nope"\n');
			}
			const h = harness([]);
			expect(
				await run(["mcp", "login", "fixture"], h.io, h.createBackend, undefined, () => manager([stdio("fixture")])),
			).toBe(1);
			expect(h.err()).toContain("only HTTP servers without an Authorization header do");
		});

		it("says why /mcp login cannot sign a server in, without a turn", async () => {
			const h = harness([], { input: ["/mcp login nope", "/mcp logout nope", "/mcp nope"] });
			await run([], h.io, h.createBackend, undefined, () => manager([]));
			expect(h.err()).toContain('error: No MCP server named "nope"\n');
			expect(h.err()).toContain("usage: /mcp | /mcp login <server> | /mcp logout <server>\n");
			expect(h.backend.prompts).toEqual([]);
		});

		it("shows the session's servers with /mcp, without a turn", async () => {
			const h = harness([], { input: ["/mcp"] });
			await run([], h.io, h.createBackend, undefined, () => manager([{ ...stdio("off"), enabled: false }]));
			expect(h.out()).toContain("off (stdio): disabled\n");
			expect(h.backend.prompts).toEqual([]);
		});

		it("says there are no servers with /mcp in a session without them", async () => {
			const h = harness([], { input: ["/mcp"] });
			await run([], h.io, h.createBackend);
			expect(h.out()).toContain("No MCP servers in this session.\n");
		});
	});

	it("says the mode with /mode", async () => {
		const h = harness([], { input: ["/mode"] });
		await run(["--mode", "auto"], h.io, h.createBackend);
		expect(h.out()).toContain("mode: auto\n");
		expect(h.backend.prompts).toEqual([]);
	});

	it("changes the mode of the session with /mode <mode>", async () => {
		const command = [bash("echo hi"), { event: finished }];
		const h = harness([command, command], {
			input: ["first", "/mode yolo", "second", "/mode"],
			sandbox: false,
		});
		await run(["--no-review"], h.io, h.createBackend);
		expect(h.out()).toContain("mode: yolo (this session)\n");
		expect(h.out().endsWith("mode: yolo\n")).toBe(true);
		expect(h.backend.toolResults.map((result) => result.ok)).toEqual([false, true]);
		expect(h.backend.prompts).toHaveLength(2);
	});

	it("saves the default with /mode default <mode> and leaves the session as it is", () =>
		withHome(async (home) => {
			const h = harness([], { input: ["/mode default auto", "/mode"], home });
			await run([], h.io, h.createBackend);
			expect(h.out()).toContain("default mode: auto (saved in ~/.atelier/permission-mode.json)\n");
			expect(h.out().endsWith("mode: normal\n")).toBe(true);
			expect(JSON.parse(await readFile(modeFile(home), "utf8"))).toEqual({
				kind: "atelier.permission_mode",
				version: 1,
				default: "auto",
			});
			expect(h.backend.prompts).toEqual([]);
		}));

	it.each(["/mode bogus", "/mode default", "/mode default bogus", "/mode yolo extra", "/mode default yolo extra"])(
		"answers %s with the usage and changes nothing",
		async (line) => {
			const h = harness([], { input: [line, "/mode"] });
			await run(["--mode", "auto"], h.io, h.createBackend);
			expect(h.err()).toBe("usage: /mode [normal|auto|yolo] | /mode default <normal|auto|yolo>\n");
			expect(h.out().endsWith("mode: auto\n")).toBe(true);
			expect(h.out().match(/mode: /g)).toHaveLength(1);
			expect(h.backend.prompts).toEqual([]);
			await expect(readFile(modeFile(fallbackHome), "utf8")).rejects.toThrow();
		},
	);
});

describe("--mode auto", () => {
	const leave = { command: "touch marker", unsandboxed: true, reason: "the user asked for a marker" };
	const call: FakeStep = { toolCall: { tool: "bash", input: leave } };
	const reply = (body: object): FakeStep[] => [
		{ event: { type: "text_delta", text: JSON.stringify(body) } },
		{ event: finished },
	];
	const exists = (path: string) =>
		readFile(path).then(
			() => true,
			() => false,
		);

	/** The main agent's backend is the first the CLI asks for; the classifier's is the next. */
	function withClassifier(classifierTurns: FakeStep[][], options: Parameters<typeof harness>[1] = {}) {
		const h = harness([[call, { event: finished }]], { isTTY: true, ...options });
		const classifier = new FakeBackend(classifierTurns);
		const names: string[] = [];
		const createBackend = (name: string) => {
			names.push(name);
			return names.length === 1 ? h.backend : classifier;
		};
		return { h, classifier, names, createBackend };
	}

	it("runs what the classifier allows, with no question, and says so", async () => {
		const { h, classifier, createBackend } = withClassifier([reply({ decision: "allow", reason: "the user asked" })]);
		await run(["--mode", "auto", "--no-review", "make a marker"], h.io, createBackend);
		expect(h.out()).toContain("  auto: allowed — the user asked\n");
		expect(h.out()).not.toContain("[y/N]");
		expect(h.backend.toolResults[0]?.ok).toBe(true);
		expect(await exists(join(cwd, "marker"))).toBe(true);
		expect(classifier.prompts[0]).toContain("make a marker");
		expect(classifier.prompts[0]).toContain("touch marker");
	});

	it("does not run what the classifier denies, and asks nobody", async () => {
		const { h, createBackend } = withClassifier([reply({ decision: "deny", reason: "not in the request" })]);
		await run(["--mode", "auto", "--no-review", "x"], h.io, createBackend);
		expect(h.out()).toContain("  auto: denied — not in the request\n");
		expect(h.out()).not.toContain("[y/N]");
		expect(h.backend.toolResults[0]?.ok).toBe(false);
		expect(h.backend.toolResults[0]?.output).toContain("Denied by the permission classifier (auto mode)");
		expect(await exists(join(cwd, "marker"))).toBe(false);
	});

	it("says it is undecided when the classifier fails, and then asks", async () => {
		const { h, createBackend } = withClassifier([[{ throw: "boom" }]], { answers: ["y"] });
		await run(["--mode", "auto", "--no-review", "x"], h.io, createBackend);
		const out = h.out();
		const line = out.indexOf("  auto: undecided — classifier unavailable: ");
		expect(line).toBeGreaterThanOrEqual(0);
		expect(out.slice(line)).toMatch(/; asking you\n/);
		expect(out.indexOf("Run this command OUTSIDE the sandbox?")).toBeGreaterThan(line);
		expect(h.backend.toolResults[0]?.ok).toBe(true);
	});

	it("creates the classifier's backend as the session's kind", async () => {
		const { h, names, createBackend } = withClassifier([reply({ decision: "allow", reason: "ok" })]);
		await run(["--mode", "auto", "--no-review", "x"], h.io, createBackend);
		expect(names).toEqual(["claude-code", "claude-code"]);
	});

	it("creates the classifier's backend as its profile role says", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-cli-home-"));
		try {
			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "profiles.json"),
				JSON.stringify({
					kind: "atelier.agent_model_profiles",
					version: 1,
					active: "p",
					profiles: { p: { "permission-classifier": { model: "anthropic-api/claude-sonnet-5-5" } } },
				}),
			);
			const { h, names, createBackend } = withClassifier([reply({ decision: "allow", reason: "ok" })], { home });
			await run(["--mode", "auto", "--no-review", "x"], h.io, createBackend);
			expect(names).toEqual(["claude-code", "anthropic-api"]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("saved sessions", () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "atelier-cli-saved-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	const answer = (value: string): FakeStep[] => [
		{ event: started },
		{ event: { type: "text_delta", text: value } },
		{ event: finished },
	];
	const saved = () => new SessionStore(home).list(cwd);
	const savedHarness = (turns: FakeStep[][], options: Parameters<typeof harness>[1] = {}) =>
		harness(turns, { home, backendId: "claude-code", ...options });

	/** Saves a session of one turn and gives its id; `at` is the file's last write, in seconds. */
	async function save(prompt: string, reply: string, at: number, argv: string[] = []): Promise<string> {
		const h = savedHarness([answer(reply)]);
		h.backend.resumeState = { sessionId: `cc-${at}` };
		expect(await run([...argv, prompt], h.io, h.createBackend)).toBe(0);
		const [info] = (await saved()).filter((one) => one.lastPrompt === prompt);
		await utimes(join(new SessionStore(home).folder(cwd), `${info?.id}.jsonl`), at, at);
		return info?.id as string;
	}

	/** Runs the CLI and gives back what it did; the backend it asked for is the harness's. */
	async function resumeWith(argv: string[], turns: FakeStep[][] = [answer("next answer")], input?: string[]) {
		const h = savedHarness(turns, input === undefined ? {} : { input });
		const names: BackendName[] = [];
		const code = await run(argv, h.io, (name) => {
			names.push(name);
			return h.backend;
		});
		return { h, code, names };
	}

	it("saves a session by default: the file holds the prompt and the answer, under the home", async () => {
		const id = await save("explain the parser", "it parses", 1_700_000_000);
		expect(await saved()).toEqual([
			expect.objectContaining({
				id,
				turns: 1,
				lastPrompt: "explain the parser",
				backend: "claude-code",
				resumable: true,
			}),
		]);
		const file = await readFile(join(new SessionStore(home).folder(cwd), `${id}.jsonl`), "utf8");
		expect(file).toContain('"text":"it parses"');
	});

	it("saves nothing with --no-session, nor without a home", async () => {
		const withFlag = savedHarness([answer("x")]);
		expect(await run(["--no-session", "hi"], withFlag.io, withFlag.createBackend)).toBe(0);
		expect(withFlag.backend.startOptions).not.toHaveProperty("persist");
		expect(await readdir(home)).toEqual([]);

		const noHome = harness([answer("x")], { backendId: "claude-code" });
		expect(await run(["hi"], noHome.io, noHome.createBackend)).toBe(0);
		expect(noHome.backend.startOptions).not.toHaveProperty("persist");
		expect(await readdir(home)).toEqual([]);
	});

	it("--continue prints what was said, resumes the newest session of the folder and goes on interactively", async () => {
		await save("old question", "old answer", 1_700_000_000);
		const newest = await save("new question", "new answer", 1_800_000_000);
		const { h, code, names } = await resumeWith(["--continue"], [answer("second answer")], ["and then?"]);
		expect(code).toBe(0);
		expect(names).toEqual(["claude-code"]);
		expect(h.out().startsWith(`resumed session ${newest}: 1 turn\n> new question\nnew answer\n`)).toBe(true);
		expect(h.out()).not.toContain("old question");
		expect(h.out()).toContain("second answer");
		expect(h.backend.prompts).toEqual(["and then?"]);
		expect(h.backend.startOptions?.resume).toEqual({ sessionId: "cc-1800000000" });
		expect(h.err()).not.toContain("error:");
		// It is the same session, one turn longer.
		expect(await saved()).toHaveLength(2);
		expect((await saved()).find((info) => info.id === newest)).toMatchObject({ turns: 2, lastPrompt: "and then?" });
	});

	it("--resume <id> resumes that session, not the newest, and runs a prompt given with it", async () => {
		const older = await save("old question", "old answer", 1_700_000_000);
		await save("new question", "new answer", 1_800_000_000);
		const { h, code } = await resumeWith(["--resume", older, "follow up"]);
		expect(code).toBe(0);
		expect(h.out().startsWith(`resumed session ${older}: 1 turn\n> old question\nold answer\n`)).toBe(true);
		expect(h.backend.prompts).toEqual(["follow up"]);
		expect(h.backend.startOptions?.resume).toEqual({ sessionId: "cc-1700000000" });
	});

	it("prints each prompt with the final text of its turn only, shows hidden characters, and names a renamed session", async () => {
		const store = new SessionStore(home);
		const record = store.create(cwd);
		record.config({ backend: "claude-code", mode: "normal" });
		record.prompt("t1", "first\nsecond line");
		record.event({ type: "text_delta", text: "let me look", seq: 1, turnId: "t1" });
		record.event({ type: "tool_call_started", callId: "c", tool: "read", input: {}, seq: 2, turnId: "t1" });
		record.event({ type: "text_delta", text: "child words", seq: 3, turnId: "t1", agent: "worker", parentCallId: "c" });
		record.event({ type: "text_delta", text: "done \u001b[31mred", seq: 4, turnId: "t1" });
		record.prompt("t2", "no answer here");
		record.name("my work");
		await record.flush();
		const { h } = await resumeWith(["--resume", record.id, "go"]);
		expect(
			h
				.out()
				.startsWith(
					`resumed session ${record.id} "my work": 2 turns\n> first\n  second line\ndone ␛[31mred\n> no answer here\n`,
				),
		).toBe(true);
		expect(h.out()).not.toContain("let me look");
		expect(h.out()).not.toContain("child words");
	});

	it("prints what the user steered during a turn after its prompt, as a prompt of its own", async () => {
		const store = new SessionStore(home);
		const record = store.create(cwd);
		record.config({ backend: "claude-code", mode: "normal" });
		record.prompt("t1", "fix it");
		record.event({ type: "queued_message", id: "q1", kind: "steer", text: "use tabs", seq: 3, turnId: "t1" });
		record.event({ type: "text_delta", text: "fixed", seq: 4, turnId: "t1" });
		await record.flush();
		const { h } = await resumeWith(["--resume", record.id, "go"]);
		expect(h.out().startsWith(`resumed session ${record.id}: 1 turn\n> fix it\n> use tabs\nfixed\n`)).toBe(true);
	});

	it("restores the saved model and mode, and what is given on the command line wins", async () => {
		await save("q", "a", 1_700_000_000, ["--model", "sonnet", "--mode", "yolo"]);
		const restored = await resumeWith(["--continue"], [], ["/mode"]);
		expect(restored.h.backend.startOptions?.model).toBe("sonnet");
		expect(restored.h.out()).toContain("mode: yolo\n");

		const overridden = await resumeWith(["--continue", "--model", "opus", "--mode", "auto"], [], ["/mode"]);
		expect(overridden.h.backend.startOptions?.model).toBe("opus");
		expect(overridden.h.out()).toContain("mode: auto\n");
	});

	it("says there is nothing to continue, and starts nothing", async () => {
		const { h, code, names } = await resumeWith(["--continue"]);
		expect(code).toBe(1);
		expect(names).toEqual([]);
		expect(h.err()).toBe(`error: No saved session to continue in ${cwd}.\n`);
		expect(h.out()).toBe("");
	});

	it("says a session is missing, from a newer format or corrupt, and starts nothing", async () => {
		const folder = new SessionStore(home).folder(cwd);
		await mkdir(folder, { recursive: true });
		const header = { kind: "atelier.session", version: 1, createdAt: "2026-01-01T00:00:00.000Z", cwd };
		await writeFile(join(folder, "future.jsonl"), `${JSON.stringify({ ...header, id: "future", version: 3 })}\n`);
		await writeFile(
			join(folder, "broken.jsonl"),
			`${JSON.stringify({ ...header, id: "broken" })}\n{oops\n{"type":"name","name":"x"}\n`,
		);
		const cases: [string, string][] = [
			["absent", `error: No saved session "absent" for ${cwd}.\n`],
			[
				"future",
				"error: Saved session future cannot be resumed: it was saved with session format version 3, and this Atelier reads version 1.\n",
			],
			["broken", "error: Saved session broken is corrupt: line 2 is not valid JSON.\n"],
		];
		for (const [id, message] of cases) {
			const { h, code, names } = await resumeWith(["--resume", id]);
			expect(code).toBe(1);
			expect(names).toEqual([]);
			expect(h.err()).toBe(message);
		}
		// --continue passes over a file it cannot resume.
		expect((await resumeWith(["--continue"])).h.err()).toBe(`error: No saved session to continue in ${cwd}.\n`);
	});

	it("refuses a session another process is writing, takes over the lock of one that is gone, and lets go when it ends", async () => {
		const id = await save("q", "a", 1_700_000_000);
		const store = new SessionStore(home);
		const lockPath = join(store.folder(cwd), `${id}.jsonl.lock`);
		const other = store.continue(cwd, await store.load(cwd, id));
		await other.lock();
		const busy = await resumeWith(["--resume", id, "go"]);
		expect(busy.code).toBe(1);
		expect(busy.h.err()).toBe(
			`error: Session ${id} is already in use by another Atelier process (pid ${process.pid}).\n`,
		);
		expect(busy.h.out()).toBe("");
		expect(busy.h.backend.startOptions).toBeUndefined();
		await other.release();

		await writeFile(lockPath, `${execFileSync(process.execPath, ["-p", "process.pid"]).toString().trim()}\n`);
		const taken = await resumeWith(["--resume", id, "go"]);
		expect(taken.code).toBe(0);
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("starts nothing when the backend cannot resume, and leaves the file as it was", async () => {
		const id = await save("q", "a", 1_700_000_000);
		const path = join(new SessionStore(home).folder(cwd), `${id}.jsonl`);
		const before = await readFile(path, "utf8");
		const h = savedHarness([answer("x")]);
		h.backend.startError = "Claude Code has no session cc-1700000000";
		expect(await run(["--resume", id, "go"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe(`error: Could not resume session ${id}: Claude Code has no session cc-1700000000\n`);
		expect(h.out()).toBe("");
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("refuses a --model of another backend on resume, saying how to move the session there", async () => {
		const id = await save("q", "a", 1_700_000_000);
		const { h, code, names } = await resumeWith(["--resume", id, "--model", "openai-codex/gpt-6-luna"]);
		expect(code).toBe(2);
		expect(names).toEqual([]);
		expect(h.err()).toBe(
			`error: Session ${id} was saved on claude-code, and --model openai-codex/gpt-6-luna names another backend: a resumed session keeps its backend. Resume it without that --model, then choose openai-codex/gpt-6-luna in /model (in the terminal interface) to move it there with a summary of the conversation.\n`,
		);
		const same = await resumeWith(["--resume", id, "--model", "claude-code/sonnet", "go"]);
		expect(same.code).toBe(0);
		expect(same.h.backend.startOptions?.model).toBe("sonnet");
	});

	it("refuses a --backend other than the one the session was saved on", async () => {
		const id = await save("q", "a", 1_700_000_000);
		const { h, code, names } = await resumeWith(["--resume", id, "--backend", "anthropic-api"]);
		expect(code).toBe(2);
		expect(names).toEqual([]);
		expect(h.err()).toBe(`error: Session ${id} was saved on claude-code; --backend anthropic-api cannot resume it.\n`);
	});

	it("needs a home directory to read the sessions from", async () => {
		const h = harness([], { backendId: "claude-code" });
		expect(await run(["--continue"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe("error: --continue and --resume need a home directory to read ~/.atelier/sessions from.\n");
	});
});

describe("remembered answers", () => {
	const bash = (input: Record<string, string | boolean>): FakeStep => ({ toolCall: { tool: "bash", input } });
	const leave = (command: string) => bash({ command, unsandboxed: true, reason: "a GUI app" });
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "atelier-cli-rules-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});
	const rulesFile = () => join(home, ".atelier", "permissions.json");

	it("offers the command's rule, and s keeps it for the rest of the session", async () => {
		const turn = [leave("echo -n one"), bash({ command: "echo -n two" }), { event: finished }];
		const h = harness([turn], { isTTY: true, answers: ["s"], home });
		await run(["--no-review", "x"], h.io, h.createBackend);
		expect(h.out()).toContain(
			'Run this command OUTSIDE the sandbox?\n  echo -n one\n  reason: a GUI app\n  s: Allow "echo" in this session\n  a: Allow "echo" always\n[y/N/s/a] ',
		);
		expect(h.out().match(/\[y\/N/g)).toHaveLength(1);
		expect(h.backend.toolResults[1]?.output).toContain("two");
		expect(await exists(rulesFile())).toBe(false);
	});

	it("a saves the rule in ~/.atelier/permissions.json", async () => {
		const h = harness([[leave("echo -n one"), { event: finished }]], { isTTY: true, answers: ["a"], home });
		await run(["--no-review", "x"], h.io, h.createBackend);
		expect(JSON.parse(await readFile(rulesFile(), "utf8")).allow).toEqual([{ bash: "echo" }]);
	});

	it("offers no Allow always for an interpreter", async () => {
		const h = harness([[leave("node -e 1"), { event: finished }]], { isTTY: true, answers: ["a"], home });
		await run(["--no-review", "x"], h.io, h.createBackend);
		expect(h.out()).toContain('  s: Allow "node" in this session\n[y/N/s] ');
		expect(h.out()).not.toContain("a: Allow");
		expect(h.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
	});

	it("/permissions lists the rules and /permissions remove deletes one", async () => {
		await mkdir(join(home, ".atelier"));
		await writeFile(
			rulesFile(),
			JSON.stringify({ kind: "atelier.permissions", version: 1, allow: [{ bash: "open" }] }),
			{
				mode: 0o600,
			},
		);
		const h = harness([], {
			input: ["/permissions", "/permissions remove 2", "/permissions remove 1", "/permissions", "/permissions x"],
			home,
		});
		await run(["--no-review"], h.io, h.createBackend);
		expect(h.out()).toContain("1. always  bash  open\n");
		expect(h.err()).toContain("error: no rule 2\n");
		expect(h.out()).toContain("removed: always bash open\n");
		expect(h.out()).toContain("No permission rules.\n");
		expect(h.err()).toContain("usage: /permissions | /permissions remove <number>\n");
		expect(JSON.parse(await readFile(rulesFile(), "utf8")).allow).toEqual([]);
	});
});

describe("login and logout", () => {
	requireIsolatedHome();
	const stored = async (home: string) =>
		JSON.parse(await readFile(join(home, ".atelier", "auth.json"), "utf8").catch(() => "{}"));

	it("atelier login api-key anthropic stores the key read from stdin, and never prints it", async () => {
		const home = dirname(cwd);
		const h = harness([], { input: ["sk-ant-piped"], home });
		expect(await run(["login", "api-key", "anthropic"], h.io, h.createBackend)).toBe(0);
		expect((await stored(home)).anthropic).toEqual({ type: "api_key", key: "sk-ant-piped" });
		expect(h.out()).toContain(
			"✓ Anthropic: API key stored in ~/.atelier/auth.json; --backend anthropic-api uses it.\n",
		);
		expect(h.out() + h.err()).not.toContain("sk-ant-piped");
		const out = harness([], { home });
		expect(await run(["logout", "api-key"], out.io, out.createBackend)).toBe(0);
		expect(out.out()).toContain("Anthropic API key removed from ~/.atelier/auth.json.\n");
		expect((await stored(home)).anthropic).toBeUndefined();
	});

	it("reads the key without echo when stdin is a terminal, even with stdout redirected", async () => {
		const home = dirname(cwd);
		const h = harness([], { isTTY: true, keepStdinOpen: true, home });
		const modes: boolean[] = [];
		// stdout is not a terminal: no session raw mode, only the input's.
		Object.assign(h.io, { setInputRaw: (on: boolean) => modes.push(on) });
		const pending = run(["login", "api-key", "anthropic"], h.io, h.createBackend);
		await vi.waitFor(() => expect(h.out()).toContain("Anthropic API key (hidden): "), { timeout: 5000 });
		expect(modes).toEqual([true]);
		(h.io.stdin as PassThrough).write("sk-ant-typed\r");
		expect(await pending).toBe(0);
		expect(modes).toEqual([true, false]);
		expect(h.out()).not.toContain("sk-ant-typed");
		expect(JSON.parse(await readFile(join(home, ".atelier", "auth.json"), "utf8")).anthropic.key).toBe("sk-ant-typed");
	});

	it("/login in a line session with stdout redirected hides only the key's line", async () => {
		const home = dirname(cwd);
		const h = harness([], { isTTY: true, input: ["/login api-key anthropic"], keepStdinOpen: true, home });
		const modes: boolean[] = [];
		Object.assign(h.io, { setInputRaw: (on: boolean) => modes.push(on) });
		const pending = run(["--no-session"], h.io, h.createBackend);
		await vi.waitFor(() => expect(h.out()).toContain("Anthropic API key (hidden): "), { timeout: 5000 });
		await vi.waitFor(() => expect(modes).toEqual([true]), { timeout: 5000 });
		(h.io.stdin as PassThrough).write("sk-ant-typed\r");
		await vi.waitFor(() => expect(h.out()).toContain("✓ Anthropic: API key stored"), { timeout: 5000 });
		expect(modes).toEqual([true, false]);
		(h.io.stdin as PassThrough).end();
		expect(await pending).toBe(0);
		expect(h.backend.prompts).toEqual([]);
	});

	it("atelier login signs in to Codex with the redirect URL pasted on the terminal", async () => {
		const auth = await new FakeOpenAiAuth().start();
		const access = fakeCodexAccess("acct-pasted");
		auth.routes.set("/oauth/token", () => ({
			json: { access_token: access, refresh_token: fakeRefresh(), expires_in: 3600 },
		}));
		const home = dirname(cwd);
		const h = harness([], { isTTY: true, keepStdinOpen: true, home });
		let page = "";
		// The browser cannot reach Atelier (port 1 is not one it can listen on): the user pastes where it ended.
		Object.assign(h.io, {
			env: { DISPLAY: ":0" },
			openaiLogin: {
				openai: { authUrl: auth.url, callbackPort: 1 },
				openBrowser: async (url: string) => {
					page = url;
				},
			},
		});
		try {
			const pending = run(["login", "account", "openai-codex"], h.io, h.createBackend);
			await vi.waitFor(() => expect(h.out()).toContain("Choose 1-2"), { timeout: 5000 });
			(h.io.stdin as PassThrough).write("1\r");
			await vi.waitFor(() => expect(h.out()).toContain("Paste the redirect URL"), { timeout: 5000 });
			const state = new URL(page).searchParams.get("state");
			(h.io.stdin as PassThrough).write(`http://localhost:1/auth/callback?code=c-1&state=${state}\r`);
			expect(await pending).toBe(0);
			expect(h.out()).toContain("✓ OpenAI Codex: signed in, stored in ~/.atelier/auth.json");
			expect(h.out()).not.toContain(access);
			const stored = JSON.parse(await readFile(join(home, ".atelier", "auth.json"), "utf8"));
			expect(stored["openai-codex"]).toMatchObject({ access, accountId: "acct-pasted" });
		} finally {
			await auth.stop();
		}
	});

	it("atelier login without a terminal says what to give, and signing in with an account needs one", async () => {
		const h = harness([], { home: dirname(cwd) });
		expect(await run(["login"], h.io, h.createBackend)).toBe(1);
		expect(h.err()).toBe(
			"error: choosing needs a terminal; give the method and the provider: atelier login api-key anthropic\n",
		);
		const account = harness([], { home: dirname(cwd) });
		expect(await run(["login", "account", "anthropic"], account.io, account.createBackend)).toBe(1);
		expect(account.err()).toBe("error: signing in with an account needs a terminal: run atelier login in one\n");
	});

	it("takes no session options and at most a method and a provider", async () => {
		const h = harness([]);
		expect(await run(["login", "--model", "x"], h.io, h.createBackend)).toBe(2);
		expect(h.err()).toContain("atelier login takes no session options (--model).");
		const extra = harness([]);
		expect(await run(["logout", "api-key", "anthropic", "more"], extra.io, extra.createBackend)).toBe(2);
		expect(extra.err()).toContain(
			"Usage: atelier logout [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]",
		);
	});

	it("/login in the line-by-line session reads the key without echoing it", async () => {
		const home = dirname(cwd);
		const h = harness([], { raw: true, input: ["/login api-key anthropic"], keepStdinOpen: true, home });
		const pending = run(["--no-session"], h.io, h.createBackend);
		await vi.waitFor(() => expect(h.out()).toContain("Anthropic API key (hidden): "), { timeout: 5000 });
		(h.io.stdin as PassThrough).write("sk-ant-typed\r");
		await vi.waitFor(() => expect(h.out()).toContain("✓ Anthropic: API key stored"), { timeout: 5000 });
		(h.io.stdin as PassThrough).end();
		expect(await pending).toBe(0);
		expect((await stored(home)).anthropic).toEqual({ type: "api_key", key: "sk-ant-typed" });
		expect(h.out()).not.toContain("sk-ant-typed");
		expect(h.backend.prompts).toEqual([]);
	});
});

describe("login warning at start", () => {
	it("warns before the first prompt when the session's backend has no login, and says nothing otherwise", async () => {
		const asked: string[] = [];
		const h = harness([[{ event: started }, { event: finished }]]);
		Object.assign(h.io, {
			checkLogin: async (backend: string) => {
				asked.push(backend);
				return "Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account.";
			},
		});
		expect(await run(["--no-session", "hi"], h.io, h.createBackend)).toBe(0);
		expect(asked).toEqual(["claude-code"]);
		expect(h.err()).toContain(
			"warning: Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account.\n",
		);
		const quiet = harness([[{ event: started }, { event: finished }]]);
		Object.assign(quiet.io, { checkLogin: async () => undefined });
		expect(await run(["--no-session", "hi"], quiet.io, quiet.createBackend)).toBe(0);
		expect(quiet.err()).not.toContain("warning:");
	});
});
