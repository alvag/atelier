import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import {
	type AtelierEvent,
	type AtelierEventBody,
	type ClientCommand,
	coreTools,
	createBashTool,
	FakeBackend,
	type FakeStep,
	RpcServer,
	Sandbox,
} from "@atelier/core";
import type { CoreExit } from "@atelier/core/client";
import { decodeServerMessage, encodeMessage, LineSplitter } from "@atelier/core/protocol";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.ts";
import type { CoreLink } from "../src/tui/app.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const started: AtelierEventBody = { type: "session_started", backend: "fake", model: "m", authSource: "subscription" };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.5 };

/** `bash` without a sandbox: in normal mode every command asks. */
const tools = (() => {
	const bash = createBashTool({ sandbox: new Sandbox({ platform: "linux" }) });
	return coreTools.map((tool) => (tool.name === "bash" ? bash : tool));
})();

let cwd: string;
let home: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-tui-"));
	home = await mkdtemp(join(tmpdir(), "atelier-tui-home-"));
	vi.stubEnv("HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

/** The core in this process, over the protocol's own encoding: what the TUI sends is what a server receives. */
function inProcessCore(backend: FakeBackend, saveSessions: boolean, children: FakeBackend[], backendId?: string) {
	const commands: ClientCommand[] = [];
	const envs: Record<string, string>[] = [];
	let closed = false;
	const connect = async (env: Record<string, string>): Promise<CoreLink> => {
		envs.push(env);
		const input = new PassThrough();
		const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		const eventListeners = new Set<(sessionId: string, event: AtelierEvent) => void>();
		const exitListeners = new Set<(exit: CoreExit) => void>();
		const splitter = new LineSplitter();
		const server = new RpcServer({
			input,
			write: (chunk) => {
				for (const line of splitter.push(chunk)) {
					const message = decodeServerMessage(line);
					if (message.type === "event")
						for (const listener of eventListeners) listener(message.sessionId, message.event);
					if (message.type !== "response") continue;
					const waiting = pending.get(message.id);
					pending.delete(message.id);
					if (message.ok) waiting?.resolve(message.result);
					else waiting?.reject(new Error(message.error.message));
				}
			},
			// The session's own backend first, then one for each subagent.
			createBackend: (() => {
				let created = 0;
				return () => (created++ === 0 ? backend : (children.shift() ?? new FakeBackend([], backendId)));
			})(),
			review: env.ATELIER_REVIEW !== "off",
			noSandbox: env.ATELIER_SANDBOX === "off",
			tools,
			systemPromptAppend: "",
			home,
			sessions: saveSessions,
		});
		const running = server.run();
		let nextId = 0;
		return {
			request(command) {
				commands.push(command);
				const id = `r${++nextId}`;
				return new Promise((resolve, reject) => {
					pending.set(id, { resolve, reject });
					input.write(encodeMessage({ ...command, type: "command", id }));
				});
			},
			onEvent(listener) {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			onExit(listener) {
				exitListeners.add(listener);
				return () => exitListeners.delete(listener);
			},
			async close() {
				input.end();
				await running;
				closed = true;
			},
		};
	};
	return { connect, commands, envs, closed: () => closed };
}

/** A terminal that keeps what the TUI wrote, without its styles, and types keys into it. */
function fakeTerminal() {
	let onInput: ((data: string) => void) | undefined;
	let written = "";
	let stopped = false;
	const statuses: ProgramStatus[] = [];
	const titles: string[] = [];
	const terminal: Terminal = {
		start: (input) => {
			onInput = input;
		},
		stop: () => {
			stopped = true;
		},
		drainInput: async () => {},
		write: (data) => {
			written += data;
		},
		columns: 100,
		rows: 40,
		kittyProtocolActive: false,
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: (title) => {
			titles.push(title);
		},
		setProgress: () => {},
		setProgramStatus: (status) => {
			statuses.push(status);
		},
	};
	return {
		terminal,
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the styles are what is taken out
		screen: () => written.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g, ""),
		type: (data: string) => onInput?.(data),
		started: () => onInput !== undefined,
		stopped: () => stopped,
		statuses,
		titles,
	};
}

function harness(
	turns: FakeStep[][],
	options: { saveSessions?: boolean; children?: FakeBackend[]; backendId?: string } = {},
) {
	const backend = new FakeBackend(turns, options.backendId);
	let terminate: ((signal: number) => void) | undefined;
	const core = inProcessCore(backend, options.saveSessions ?? false, options.children ?? [], options.backendId);
	const screen = fakeTerminal();
	let stderr = "";
	const io = {
		stdin: new PassThrough(),
		isTTY: true,
		stdout: () => {},
		stderr: (text: string) => {
			stderr += text;
		},
		cwd,
		home,
		color: false,
		tools,
		tui: { terminal: screen.terminal, connect: core.connect, ...({ answerGuardMs: 0 } as { answerGuardMs?: number }) },
		onTerminate: (handler: (signal: number) => void) => {
			terminate = handler;
			return () => {
				terminate = undefined;
			};
		},
	};
	return { backend, core, screen, io, err: () => stderr, terminate: (signal: number) => terminate?.(signal) };
}

describe("TUI", { timeout: 20_000 }, () => {
	it("sends the prompt typed in the editor and shows the answer, the tool card and the footer", async () => {
		const h = harness([
			[
				{ event: started },
				{ event: { type: "text_delta", text: "Done **now**." } },
				{ toolCall: { tool: "read", input: { path: "a.ts" } } },
				{ event: finished },
			],
		]);
		await writeFile(join(cwd, "a.ts"), "one\ntwo\n");
		const code = run(["--no-session", "--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("fix it");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(h.backend.prompts).toEqual(["fix it"]);
		expect(h.core.commands[0]).toMatchObject({ command: "session.start", cwd, mode: "auto", noSession: true });
		const screen = h.screen.screen();
		expect(screen).toContain("❯ fix it");
		expect(screen).toContain("Done now.");
		expect(screen).toContain("▸ read a.ts · 2 lines ✓");
		expect(screen).toContain("m · profile default · auto · sandbox ✗ · $0.50");
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
		expect(h.screen.stopped()).toBe(true);
		expect(h.core.closed()).toBe(true);
		expect(h.backend.closed).toBe(true);
	});

	it("asks an approval in a dialog that starts on Allow, and denies what is chosen", async () => {
		const h = harness([
			[{ toolCall: { tool: "bash", input: { command: "echo first" } } }, { event: finished }],
			[{ toolCall: { tool: "bash", input: { command: "echo second" } } }, { event: finished }],
		]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("one");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		expect(h.screen.screen()).toContain("echo first");
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("first");
		await until(() => h.screen.screen().includes("$0.50"));

		h.screen.type("two");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("echo second"));
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 2);
		expect(h.backend.toolResults[1]?.output).toBe("The user denied this command.");
		await until(() => h.screen.screen().includes("$1.00"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("shows a long command's first line in the approval, and all of it with Ctrl+O", async () => {
		const h = harness([
			[{ toolCall: { tool: "bash", input: { command: "echo one\necho two\necho three" } } }, { event: finished }],
		]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		const dialog = () => h.screen.screen().slice(h.screen.screen().lastIndexOf("Run this command?"));
		expect(dialog()).toContain("echo one … 2 more lines (Ctrl+O)");
		expect(dialog()).not.toContain("echo three");
		h.screen.type("\x0f");
		await until(() => dialog().includes("echo three"));
		expect(dialog()).toContain("echo two");
		expect(dialog()).not.toContain("more lines");
		h.screen.type("\x0f");
		await until(() => !dialog().includes("echo three"));
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("three");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("ignores the keys typed just as an approval appears", async () => {
		const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { event: finished }]]);
		h.io.tui = { ...h.io.tui, answerGuardMs: 300 };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		const shownAt = Date.now();
		h.screen.type("\r");
		h.screen.type("\x1b[B");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(h.backend.toolResults).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 300 - (Date.now() - shownAt))));
		// The Down typed too early did not move the answer: Enter takes Allow.
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("hi");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("asks the approval a subagent needs, and gives it the answer", async () => {
		const worker = new FakeBackend([
			[
				{ toolCall: { tool: "bash", input: { command: "echo childcmd" } } },
				{ event: { type: "text_delta", text: "ran it" } },
				{ event: finished },
			],
		]);
		const h = harness(
			[[{ toolCall: { tool: "task", input: { agent: "worker", prompt: "do" } } }, { event: finished }]],
			{
				children: [worker],
			},
		);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command? (asked by worker)"));
		expect(h.screen.screen()).toContain("echo childcmd");
		h.screen.type("\r");
		await until(() => worker.toolResults.length === 1);
		expect(worker.toolResults[0]?.output).toContain("childcmd\n");
		// The worker's card says $0.50 first; the main turn's end says $0.5000.
		await until(() => h.screen.screen().includes("$0.5000"));
		expect(h.screen.screen()).toContain("└ worker · 1 tool");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("ignores a paste in a question", async () => {
		const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { event: finished }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		h.screen.type("\x1b[200~\r\x1b[201~");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(h.backend.toolResults).toEqual([]);
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("hi");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("interrupts a turn with Esc and quits with Ctrl+C", async () => {
		const h = harness([[{ event: { type: "text_delta", text: "working" } }, { waitForInterrupt: true }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("long job");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("working"));
		h.screen.type("\x1b");
		await until(() => h.backend.interrupts === 1);
		await until(() => h.screen.screen().includes("interrupted"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("changes the mode with /mode and reviews against a ref with /review", async () => {
		const h = harness([]);
		const code = run(["--no-session", "--mode", "yolo"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/mode normal");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("mode: normal (this session)"));
		expect(h.core.commands).toContainEqual({
			command: "session.set_mode",
			sessionId: expect.any(String),
			mode: "normal",
		});
		h.screen.type("/review main");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("· error"));
		expect(h.core.commands).toContainEqual(expect.objectContaining({ command: "session.review", ref: "main" }));
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("changes the model and the effort by name, and the next turn runs with them", async () => {
		const h = harness([[{ event: finished }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/model claude-sonnet-5-5");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("the prompt cache starts over"));
		expect(h.screen.screen()).toContain("model: claude-sonnet-5-5 from the next turn");
		h.screen.type("/effort high");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("effort: high from the next turn"));
		expect(h.screen.screen()).toContain("claude-sonnet-5-5 high · profile default");
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(Object.assign({}, ...h.backend.configured)).toEqual({ model: "claude-sonnet-5-5", thinking: "high" });
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("lists the modes with the one in use, and Shift+Tab takes the mode between normal and auto", async () => {
		const h = harness([]);
		const code = run(["--no-session", "--mode", "yolo"], h.io, () => h.backend);
		await until(h.screen.started);
		await until(() => h.screen.screen().includes("profile default · yolo"));
		h.screen.type("/mode");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Permission mode"));
		expect(h.screen.screen()).toMatch(/yolo +current · a plain git push/);
		// yolo is selected: Up goes to auto.
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("mode: auto (this session)"));
		h.screen.type("\x1b[Z");
		h.screen.type("\x1b[Z");
		const modes = () =>
			h.core.commands.flatMap((command) => (command.command === "session.set_mode" ? [command.mode] : []));
		await until(() => modes().length === 3);
		expect(modes()).toEqual(["auto", "normal", "auto"]);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("starts a new session with /new, and resumes the one before from /resume's list", async () => {
		// Saved on claude-code, which resumes by its session id.
		const h = harness([[{ event: finished }]], { saveSessions: true, backendId: "claude-code" });
		h.backend.resumeState = { sessionId: "cc-1" };
		const code = run(["--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("first prompt");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("/new");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("── new session ──"));
		const starts = h.core.commands.filter((command) => command.command === "session.start");
		expect(starts).toEqual([
			{ command: "session.start", cwd, mode: "auto" },
			{ command: "session.start", cwd, mode: "auto" },
		]);
		await until(() => h.backend.closed);

		h.screen.type("/resume");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Resume a session"));
		expect(h.screen.screen()).toMatch(/first prompt +just now · 1 turn/);
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("── resumed session ──"));
		await until(() => h.screen.screen().includes(": 1 turn"));
		const resumed = h.core.commands.find((command) => command.command === "session.resume");
		expect(resumed).toMatchObject({ command: "session.resume", cwd });
		// The session /new started is closed once the resumed one runs.
		await until(() => h.core.commands.filter((command) => command.command === "session.close").length === 2);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("expands and folds the tool cards with Ctrl+O", async () => {
		const h = harness([
			[{ toolCall: { tool: "bash", input: { command: "echo one\necho two" } } }, { event: finished }],
		]);
		const code = run(["--no-session", "--mode", "yolo"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("run");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(h.screen.screen()).toContain("▸ bash echo one · exit 0 ✓");
		expect(h.screen.screen()).not.toContain("│ $ echo one");
		h.screen.type("\x0f");
		await until(() => h.screen.screen().includes("│ $ echo one"));
		expect(h.screen.screen()).toContain("▾ bash echo one · exit 0 ✓");
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("gives the terminal back, closes the session and exits 143 on SIGTERM, even during a turn", async () => {
		const h = harness([[{ event: { type: "text_delta", text: "working" } }, { waitForInterrupt: true }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("long job");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("working"));
		h.terminate(15);
		expect(await code).toBe(143);
		expect(h.screen.stopped()).toBe(true);
		expect(h.backend.closed).toBe(true);
		expect(h.core.closed()).toBe(true);
	});

	it("starts the core without the sandbox or the review when the switches say so", async () => {
		const h = harness([]);
		const code = run(["--no-session", "--no-sandbox", "--no-review"], h.io, () => h.backend);
		await until(h.screen.started);
		expect(h.core.envs).toEqual([{ ATELIER_SANDBOX: "off", ATELIER_REVIEW: "off" }]);
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("fails before taking the terminal when there is no session to continue", async () => {
		const h = harness([], { saveSessions: true });
		expect(await run(["--continue"], h.io, () => h.backend)).toBe(1);
		expect(h.err()).toBe(`error: No saved session to continue in ${cwd}.\n`);
		expect(h.screen.started()).toBe(false);
		expect(h.core.closed()).toBe(true);
	});

	it("runs a prompt given as an argument without the TUI", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		let out = "";
		const stdout = (text: string) => {
			out += text;
		};
		const code = await run(["--no-session", "hi"], { ...h.io, stdout }, () => h.backend);
		expect(code).toBe(0);
		expect(h.core.envs).toEqual([]);
		expect(out).toContain("atelier · fake · m · subscription");
	});
});

describe("TUI questions, hostile text and shutdown", { timeout: 20_000 }, () => {
	const pasteCases: [string, string[]][] = [
		["in two chunks", ["\x1b[200~echo\x1b[A", "\r\x1b[201~"]],
		["in three chunks", ["\x1b[200~echo", "\x1b[A\r", "more\x1b[201~"]],
		["with a split start marker", ["\x1b[20", "0~\x1b[A\r\x1b[201~"]],
		["with a split end marker", ["\x1b[200~\x1b[A\r\x1b[20", "1~"]],
		["with its markers apart from its content", ["\x1b[200~", "\x1b[A", "\r", "\x1b[201~"]],
	];

	it.each(pasteCases)("never answers a question with a paste %s", async (_name, chunks) => {
		const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { event: finished }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		for (const chunk of chunks) h.screen.type(chunk);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(h.backend.toolResults).toEqual([]);
		// Allow is still the selected answer.
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("hi");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("takes keys typed after a split paste", async () => {
		const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { event: finished }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		h.screen.type("\x1b[200~x\x1b[B");
		h.screen.type("\r\x1b[201~");
		h.screen.type("\x1b[B");
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("hi");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	/** A core that answers `session.start` and lets the test send events and hold back `session.close`. */
	function stubCore(options: { closeHangs?: boolean; answer?: (command: ClientCommand) => unknown } = {}) {
		const listeners = new Set<(sessionId: string, event: AtelierEvent) => void>();
		const log = { commands: [] as ClientCommand[], closed: false };
		const link: CoreLink = {
			request: (command) => {
				log.commands.push(command);
				if (command.command === "session.close" && options.closeHangs) return new Promise(() => {});
				return Promise.resolve(options.answer?.(command) ?? { sessionId: "s1" });
			},
			onEvent: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onExit: () => () => {},
			close: async () => {
				log.closed = true;
			},
		};
		const emit = (event: Record<string, unknown>, sessionId = "s1") => {
			for (const listener of listeners) listener(sessionId, event as unknown as AtelierEvent);
		};
		return { link, log, emit };
	}

	it("shows the event's strings with markers for control characters", async () => {
		const h = harness([]);
		const stub = stubCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		stub.emit({ type: "session_started", backend: "fake", model: "mo\x1b[31mdel", authSource: "subscription" });
		stub.emit({ type: "tool_call_started", callId: "c1", tool: "to\x1b[31mol", input: {} });
		stub.emit({
			type: "approval_requested",
			callId: "c2",
			command: "echo hi",
			confirm: "ru\x1b[31mle",
			agent: "wor\x1b[31mker",
			parentCallId: "c1",
		});
		await until(() => h.screen.screen().includes("Run this command?"));
		const screen = h.screen.screen();
		expect(screen).toContain("(guard: ru␛[31mle)");
		expect(screen).toContain("(asked by wor␛[31mker)");
		expect(screen).toContain("mo␛[31mdel");
		expect(screen).toContain("atelier · fake · mo␛[31mdel");
		expect(screen).toContain("to␛[31mol");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("opens the feature's tasks over the editor with Ctrl+T and /feature, from its events", async () => {
		const h = harness([]);
		const stub = stubCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/feature");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("no ODD feature is active in this session"));
		stub.emit({
			type: "feature_changed",
			name: "m14",
			path: "odd/tasks/m14.md",
			title: "M14",
			tasks: [
				{ id: "T1", title: "Hot model", specs: [], status: "done" },
				{ id: "T2", title: "Hot profile", specs: [], status: "in_progress" },
			],
		});
		await until(() => h.screen.screen().includes("◆ M14 · 1/2 done · now T2 Hot profile · Ctrl+T or /feature: tasks"));
		expect(h.screen.screen()).toContain("T2 1/2");
		h.screen.type("\x14");
		await until(() => h.screen.screen().includes("▸ T2  in progress  Hot profile"));
		expect(h.screen.screen()).toContain("T1  done         Hot model");
		stub.emit({
			type: "feature_changed",
			name: "m14",
			path: "odd/tasks/m14.md",
			title: "M14",
			tasks: [
				{ id: "T1", title: "Hot model", specs: [], status: "done" },
				{ id: "T2", title: "Hot profile", specs: [], status: "done" },
				{ id: "T3", title: "Hot backend", specs: [], status: "in_progress" },
			],
		});
		await until(() => h.screen.screen().includes("▸ T3  in progress  Hot backend"));
		expect(h.screen.screen()).toContain("T3 2/3");
		h.screen.type("/feature");
		h.screen.type("\r");
		await until(() => h.screen.screen().split("Ctrl+T or /feature: tasks").length === 3);
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("asks a review question with the question and three answers only, starting on Review", async () => {
		const h = harness([]);
		const stub = stubCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		stub.emit({
			type: "review_consent_requested",
			reviewId: "r1",
			level: "high",
			reasons: ["path: src/auth.ts (auth)"],
			lenses: ["risk"],
			lensesReason: "guards",
		});
		await until(() => h.screen.screen().includes("Review this high-risk change?"));
		const screen = h.screen.screen();
		expect(screen).toContain("→ Review this change");
		expect(screen).toContain("Skip this time");
		expect(screen).toContain("Review all this session");
		expect(screen).not.toContain("src/auth.ts");
		expect(screen).not.toContain("guards");
		h.screen.type("\x1b[B");
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => stub.log.commands.some((command) => command.command === "session.review_consent"));
		expect(stub.log.commands.find((command) => command.command === "session.review_consent")).toMatchObject({
			reviewId: "r1",
			answer: "granted_for_session",
		});
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	/** A core on claude-code with two models and two profiles, which answers each change with the configuration it leaves. */
	function listingCore() {
		let configuration: Record<string, unknown> = {
			backend: "claude-code",
			model: "opus",
			thinking: "medium",
			permissionMode: "normal",
			profile: { name: "cheap", origin: "active" },
			pending: false,
		};
		const change = (fields: Record<string, unknown>) => {
			configuration = { ...configuration, ...fields };
			return configuration;
		};
		return stubCore({
			answer: (command) => {
				switch (command.command) {
					case "session.start":
						return { sessionId: "s1", configuration };
					case "options.list":
						return {
							backends: [
								{ name: "claude-code", models: ["opus", "sonnet"] },
								{ name: "anthropic-api", models: ["api-model"] },
							],
							efforts: ["low", "medium", "high"],
							modes: ["normal", "auto", "yolo"],
							profiles: ["cheap", "fast"],
							active: "cheap",
						};
					case "session.set_model":
						return change({ model: command.model });
					case "session.set_effort":
						return change({ thinking: command.effort });
					case "session.set_profile":
						return change({ profile: { name: command.profile, origin: "explicit" } });
					case "session.set_backend":
						return {
							...change({ backend: command.backend, model: "api-model" }),
							backendChange: { from: "claude-code", summarized: true },
						};
					default:
						return {};
				}
			},
		});
	}

	/**
	 * A core whose `session.set_mode` answers wait for the test, and with `holdStart`, every `session.start` after the
	 * first; the sessions are s1, s2, ... and start in `mode` unless asked for another.
	 */
	function heldCore(options: { mode: string; holdStart?: boolean }) {
		const held: { command: ClientCommand; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
		let starts = 0;
		const hold = (command: ClientCommand) =>
			new Promise((resolve, reject) => {
				held.push({ command, resolve, reject });
			});
		const started = (command: Extract<ClientCommand, { command: "session.start" }>) => ({
			sessionId: `s${starts}`,
			configuration: {
				backend: "claude-code",
				model: "opus",
				permissionMode: command.mode ?? options.mode,
				profile: { name: "p", origin: "explicit" },
				pending: false,
			},
		});
		const stub = stubCore({
			answer: (command) => {
				if (command.command === "session.set_mode") return hold(command);
				if (command.command !== "session.start") return {};
				starts++;
				if (starts > 1 && options.holdStart) return hold(command).then(() => started(command));
				return started(command);
			},
		});
		return { ...stub, held };
	}

	/** The mode the footer showed last. */
	const footerMode = (screen: string) => [...screen.matchAll(/profile p · (normal|auto|yolo)/g)].at(-1)?.[1];
	const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

	const outOfOrder: [string, [number, "fail" | "ok"][], string][] = [
		[
			"both fail, the older first",
			[
				[0, "fail"],
				[1, "fail"],
			],
			"normal",
		],
		[
			"both fail, the newer first",
			[
				[1, "fail"],
				[0, "fail"],
			],
			"normal",
		],
		[
			"the newer fails first, then the older is accepted",
			[
				[1, "fail"],
				[0, "ok"],
			],
			"auto",
		],
		[
			"the older is accepted, then the newer fails",
			[
				[0, "ok"],
				[1, "fail"],
			],
			"auto",
		],
	];
	it.each(outOfOrder)(
		"shows the mode the core is in when two Shift+Tab requests end: %s",
		async (_name, ends, mode) => {
			const h = harness([]);
			const stub = heldCore({ mode: "normal" });
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => footerMode(h.screen.screen()) === "normal");
			h.screen.type("\x1b[Z");
			h.screen.type("\x1b[Z");
			await until(() => stub.held.length === 2);
			expect(stub.held.map(({ command }) => command.command === "session.set_mode" && command.mode)).toEqual([
				"auto",
				"normal",
			]);
			for (const [index, end] of ends) {
				const request = stub.held[index];
				const asked = request?.command as Extract<ClientCommand, { command: "session.set_mode" }>;
				if (end === "ok") request?.resolve({ mode: asked.mode });
				else request?.reject(new Error("refused"));
				await tick();
			}
			await until(() => footerMode(h.screen.screen()) === mode);
			h.screen.type("\x04");
			expect(await code).toBe(0);
		},
	);

	it("sends nothing while /new starts a session, and then sends to the new one", async () => {
		const h = harness([]);
		const stub = heldCore({ mode: "normal", holdStart: true });
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		const sends = () => stub.log.commands.filter((command) => command.command === "session.send");
		h.screen.type("/new");
		h.screen.type("\r");
		await until(() => stub.held.length === 1);
		h.screen.type("hello");
		h.screen.type("\r");
		await tick();
		expect(sends()).toEqual([]);
		stub.held[0]?.resolve(undefined);
		await until(() => stub.log.commands.some((command) => command.command === "session.close"));
		expect(stub.log.commands).toContainEqual({ command: "session.close", sessionId: "s1" });
		// What was typed is still in the editor, and goes to the new session once /new has ended.
		await tick();
		h.screen.type("\r");
		await until(() => sends().length === 1);
		await tick();
		stub.emit({ type: "turn_finished", stopReason: "end_turn", usage }, "s2");
		h.screen.type("again");
		h.screen.type("\r");
		await until(() => sends().length === 2);
		expect(sends()).toEqual([
			{ command: "session.send", sessionId: "s2", prompt: "hello" },
			{ command: "session.send", sessionId: "s2", prompt: "again" },
		]);
		// The first Ctrl+C interrupts the turn, the second quits.
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("keeps the new session's mode when a mode request of the session before fails late", async () => {
		const h = harness([]);
		const stub = heldCore({ mode: "yolo" });
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(() => footerMode(h.screen.screen()) === "yolo");
		h.screen.type("\x1b[Z");
		await until(() => stub.held.length === 1);
		h.screen.type("/new");
		h.screen.type("\r");
		await until(() => stub.log.commands.some((command) => command.command === "session.close"));
		expect(stub.log.commands).toContainEqual({ command: "session.start", cwd, mode: "normal", noSession: true });
		stub.held[0]?.reject(new Error("refused"));
		await tick();
		h.screen.type("x");
		await tick();
		expect(footerMode(h.screen.screen())).toBe("normal");
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("picks the model, the effort and the profile from lists that start on the ones in use", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		await until(() => h.screen.screen().includes("opus medium · profile cheap · normal"));
		const sent = (name: string) => stub.log.commands.filter((command) => command.command === name);

		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Model on claude-code"));
		expect(h.screen.screen()).toMatch(/opus +current/);
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("model: sonnet from the next turn"));
		expect(sent("session.set_model")).toEqual([{ command: "session.set_model", sessionId: "s1", model: "sonnet" }]);

		h.screen.type("/effort");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Thinking level"));
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("effort: high from the next turn"));

		h.screen.type("/profile");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Profile"));
		expect(h.screen.screen()).toMatch(/cheap +current · active/);
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("profile: fast from the next turn"));
		expect(h.screen.screen()).toContain("sonnet high · profile fast · normal");

		// Esc closes a list without changing anything.
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => sent("options.list").length === 4);
		h.screen.type("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(sent("session.set_model")).toHaveLength(1);
		expect(sent("session.set_effort")).toEqual([{ command: "session.set_effort", sessionId: "s1", effort: "high" }]);
		expect(sent("session.set_profile")).toEqual([{ command: "session.set_profile", sessionId: "s1", profile: "fast" }]);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("closes the session /new started when its effort is refused, keeps the old one and drops the effort", async () => {
		const h = harness([]);
		let starts = 0;
		const stub = stubCore({
			answer: (command) => {
				if (command.command === "session.start") return { sessionId: `s${++starts}` };
				if (command.command === "session.set_effort" && command.sessionId !== "s1")
					return Promise.reject(new Error("effort not supported"));
				return {};
			},
		});
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		const sent = (name: string) => stub.log.commands.filter((command) => command.command === name);

		h.screen.type("/effort high");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("effort: high from the next turn"));

		h.screen.type("/new");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("error: effort not supported"));
		expect(sent("session.close")).toEqual([{ command: "session.close", sessionId: "s2" }]);

		// The old session still takes prompts.
		h.screen.type("still here");
		h.screen.type("\r");
		await until(() => sent("session.send").length === 1);
		expect(sent("session.send")).toEqual([{ command: "session.send", sessionId: "s1", prompt: "still here" }]);
		stub.emit({ type: "turn_finished", stopReason: "end_turn", usage }, "s1");

		// The refused effort is not asked again: the second /new starts a session and does not repeat the request.
		await until(() => h.screen.screen().includes("still here"));
		h.screen.type("/new");
		h.screen.type("\r");
		await until(() => starts === 3);
		await until(() => sent("session.close").length === 2);
		expect(sent("session.set_effort")).toHaveLength(2);
		expect(sent("session.close")).toEqual([
			{ command: "session.close", sessionId: "s2" },
			{ command: "session.close", sessionId: "s1" },
		]);
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it.each([
		["/model a b", "usage: /model [name]"],
		["/effort high now", "usage: /effort [level]"],
		["/profile a b", "usage: /profile [name]"],
		["/backend a b", "usage: /backend [claude-code|anthropic-api]"],
		["/new x", "usage: /new"],
		["/resume a b", "usage: /resume [id]"],
		["/undo-correction x", "usage: /undo-correction"],
		["/review a b", "usage: /review [ref]"],
	])("prints the usage for %s and does not send it to the model", async (line, usageLine) => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type(line);
		h.screen.type("\r");
		await until(() => h.screen.screen().includes(usageLine));
		expect(stub.log.commands.map((command) => command.command)).toEqual(["session.start"]);
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("asks before moving to another backend, starting on Stay", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		const moves = () => stub.log.commands.filter((command) => command.command === "session.set_backend");

		h.screen.type("/backend");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Backend"));
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Move this session to anthropic-api?"));
		expect(h.screen.screen()).toContain("detail is lost, and the prompt cache starts over.");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("backend: claude-code (unchanged)"));
		expect(moves()).toEqual([]);

		h.screen.type("/backend anthropic-api");
		h.screen.type("\r");
		await until(() => h.screen.screen().split("Move this session to anthropic-api?").length === 3);
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("with a summary of the conversation"));
		expect(moves()).toEqual([{ command: "session.set_backend", sessionId: "s1", backend: "anthropic-api" }]);
		expect(h.screen.screen()).toContain("api-model medium · profile cheap");
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	/** A TUI on a stub core that emits the approvals a test asks for, with no key guard. */
	async function approvalCore() {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		await until(() => h.screen.screen().includes("profile cheap"));
		const approvals = () => stub.log.commands.filter((command) => command.command === "session.approve");
		const ask = (command: string, reason?: string) =>
			stub.emit({ type: "approval_requested", tool: "bash", callId: "a1", command, ...(reason ? { reason } : {}) });
		const dialog = () => h.screen.screen().slice(h.screen.screen().lastIndexOf("Run this command"));
		return { h, code, approvals, ask, dialog };
	}

	it("never answers an approval with a paste begun in the editor before it appeared", async () => {
		const { h, code, approvals, ask, dialog } = await approvalCore();
		h.screen.type("\x1b[200~text pasted while the agent works");
		ask("rm -r build");
		await until(() => dialog().includes("rm -r build"));
		h.screen.type("\r");
		h.screen.type("\x1b[201~");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(approvals()).toEqual([]);
		h.screen.type("\r");
		await until(() => approvals().length === 1);
		expect(approvals()[0]).toMatchObject({ callId: "a1", approved: true });
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it.each([2, 3, 4, 5])(
		"never answers an approval with a paste whose start marker the approval cut after %i bytes",
		async (cut) => {
			const { h, code, approvals, ask, dialog } = await approvalCore();
			h.screen.type("\x1b[200~".slice(0, cut));
			ask("rm -r build");
			await until(() => dialog().includes("rm -r build"));
			h.screen.type(`${"\x1b[200~".slice(cut)}pasted text`);
			h.screen.type("\r");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(approvals()).toEqual([]);
			h.screen.type("\x1b[201~");
			h.screen.type("\r");
			await until(() => approvals().length === 1);
			expect(approvals()[0]).toMatchObject({ approved: true });
			h.screen.type("\x03");
			expect(await code).toBe(130);
		},
	);

	it("counts every line of the reason among the lines a folded approval leaves out", async () => {
		const { h, code, ask, dialog } = await approvalCore();
		ask("echo safe", "first\nsecond\nthird");
		await until(() => dialog().includes("OUTSIDE the sandbox"));
		expect(dialog()).toContain("echo safe … 3 more lines (Ctrl+O)");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("shows a command's first line with text when it starts with blank lines", async () => {
		const { h, code, ask, dialog } = await approvalCore();
		ask("\n\necho concealed");
		await until(() => dialog().includes("Run this command?"));
		expect(dialog()).toContain("echo concealed … 2 more lines (Ctrl+O)");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("quits and gives the terminal back when the core never answers session.close", async () => {
		const h = harness([]);
		const stub = stubCore({ closeHangs: true });
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, closeTimeoutMs: 50 } as typeof h.io.tui;
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("\x03");
		expect(await code).toBe(130);
		expect(h.screen.stopped()).toBe(true);
		expect(stub.log.closed).toBe(true);
	});

	describe("program status", () => {
		const atelier = (state: ProgramStatus["state"], rest: Partial<ProgramStatus> = {}) => ({
			state,
			app: "atelier",
			...rest,
		});

		it("reports idle, working, blocked on an approval, working and done, and clears on exit", async () => {
			const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo first" } } }, { event: finished }]]);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("Run this command?"));
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			expect(h.screen.statuses).toEqual([
				atelier("idle"),
				atelier("working"),
				atelier("blocked", { kind: "permission", message: "Run this command?" }),
				atelier("working"),
				atelier("done"),
				atelier("clear"),
			]);
			expect(h.screen.titles).toEqual([`Atelier - ${basename(cwd)}`]);
		});

		it("reports idle for an interrupted turn and error for a failed one", async () => {
			const h = harness([
				[{ event: { type: "text_delta", text: "working" } }, { waitForInterrupt: true }],
				[{ throw: "boom" }],
			]);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("long job");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("working"));
			h.screen.type("\x1b");
			await until(() => h.screen.screen().includes("interrupted"));
			expect(h.screen.statuses).toEqual([atelier("idle"), atelier("working"), atelier("idle")]);
			h.screen.type("again");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 5);
			expect(h.screen.statuses.slice(3)).toEqual([atelier("working"), atelier("error")]);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("reports a review consent as a question", async () => {
			const h = harness([]);
			const stub = stubCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			stub.emit({ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: [], lenses: [] });
			await until(() => h.screen.screen().includes("Review this high-risk change?"));
			expect(h.screen.statuses.at(-1)).toEqual(
				atelier("blocked", { kind: "question", message: "Review this high-risk change?" }),
			);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("does not report a list of the TUI's own as blocked", async () => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("/mode");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("yolo"));
			expect(h.screen.statuses).toEqual([atelier("idle")]);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});
	});
});
