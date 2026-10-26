import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { Terminal } from "@earendil-works/pi-tui";
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
function inProcessCore(backend: FakeBackend, saveSessions: boolean, children: FakeBackend[]) {
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
				return () => (created++ === 0 ? backend : (children.shift() ?? new FakeBackend([])));
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
		setTitle: () => {},
		setProgress: () => {},
		setProgramStatus: () => {},
	};
	return {
		terminal,
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the styles are what is taken out
		screen: () => written.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g, ""),
		type: (data: string) => onInput?.(data),
		started: () => onInput !== undefined,
		stopped: () => stopped,
	};
}

function harness(turns: FakeStep[][], options: { saveSessions?: boolean; children?: FakeBackend[] } = {}) {
	const backend = new FakeBackend(turns);
	let terminate: ((signal: number) => void) | undefined;
	const core = inProcessCore(backend, options.saveSessions ?? false, options.children ?? []);
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
		tui: { terminal: screen.terminal, connect: core.connect },
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

	it("asks an approval in a dialog that starts on Deny, and allows what is chosen", async () => {
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
		expect(h.backend.toolResults[0]?.output).toBe("The user denied this command.");
		await until(() => h.screen.screen().includes("$0.50"));

		h.screen.type("two");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("echo second"));
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 2);
		expect(h.backend.toolResults[1]?.output).toContain("second");
		await until(() => h.screen.screen().includes("$1.00"));
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
		h.screen.type("\x1b[A");
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
		h.screen.type("\x1b[A");
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
