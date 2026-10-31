import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AtelierEvent, ClientCommand } from "@atelier/core";
import type { CoreExit } from "@atelier/core/client";
import { resetCapabilitiesCache, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliIO, run } from "../src/run.ts";
import type { CoreLink } from "../src/tui/app.ts";
import { Conversation } from "../src/tui/conversation.ts";
import { painter, Shade } from "../src/tui/style.ts";
import type { UserShellOptions, UserShellResult } from "../src/tui/user-shell.ts";
import { png } from "./support/png.ts";

const BUSY = "A shell command is already running. Press Esc to cancel it first.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const done: UserShellResult = { output: "", exitCode: 0, cancelled: false, truncated: false };

let cwd: string;
let home: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-shell-tui-"));
	home = await mkdtemp(join(tmpdir(), "atelier-shell-home-"));
	vi.stubEnv("HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	resetCapabilitiesCache();
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

/** Lets the promises already settled run, so a request the TUI awaited has been answered. */
const turn = () => new Promise((resolve) => setImmediate(resolve));
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: the styles are what is taken out
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

function fakeTerminal() {
	let onInput: ((data: string) => void) | undefined;
	let written = "";
	const terminal: Terminal = {
		start: (input) => {
			onInput = input;
		},
		stop: () => {},
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
		screen: () => plain(written),
		type: (data: string) => onInput?.(data),
		started: () => onInput !== undefined,
	};
}

/** A core that answers what the TUI asks and says what it was sent; turns end when a test says so. */
function fakeCore(
	options: { entries?: unknown[]; shellFails?: boolean; shellHangs?: boolean; shellAck?: Promise<void> } = {},
) {
	const commands: ClientCommand[] = [];
	let listener: ((sessionId: string, event: AtelierEvent) => void) | undefined;
	const connect = async (): Promise<CoreLink> => ({
		async request(command) {
			commands.push(command);
			if (command.command === "sessions.list") return { sessions: [{ id: "old", backend: "fake", resumable: true }] };
			if (command.command === "session.resume") return { sessionId: "s1", entries: options.entries ?? [] };
			if ((command.command as string) === "session.shell_result" && options.shellFails) throw new Error("disk full");
			// A core that went away and never answers.
			if ((command.command as string) === "session.shell_result" && options.shellHangs) return new Promise(() => {});
			if (command.command === "session.shell_result") await options.shellAck;
			return command.command === "session.start" ? { sessionId: "s1" } : {};
		},
		onEvent(next) {
			listener = next;
			return () => {};
		},
		onExit: (_next: (exit: CoreExit) => void) => () => {},
		async close() {},
	});
	const sent = (name: string) => commands.filter((command) => (command.command as string) === name);
	const finishTurn = () =>
		listener?.("s1", {
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			costUsd: 0,
			seq: 1,
			turnId: "t",
		} as AtelierEvent);
	const emit = (event: Record<string, unknown>) => listener?.("s1", { seq: 1, turnId: "t", ...event } as AtelierEvent);
	return { connect, commands, sent, finishTurn, emit };
}

/** A runner that starts nothing: each call waits for the test to finish it, or for the abort. */
function fakeRunner() {
	const calls: { command: string; options: UserShellOptions; finish: (result: UserShellResult) => void }[] = [];
	const runShell = (command: string, options: UserShellOptions) =>
		new Promise<UserShellResult>((resolve) => {
			calls.push({ command, options, finish: resolve });
			options.signal?.addEventListener("abort", () => resolve({ ...done, exitCode: null, cancelled: true }));
		});
	return { calls, runShell };
}

function open(
	args: string[] = [],
	coreOptions: Parameters<typeof fakeCore>[0] = {},
	tui: Partial<NonNullable<CliIO["tui"]>> = {},
) {
	const core = fakeCore(coreOptions);
	const runner = fakeRunner();
	const screen = fakeTerminal();
	const io: CliIO = {
		stdin: new PassThrough(),
		isTTY: true,
		stdout: () => {},
		stderr: () => {},
		cwd,
		home,
		color: false,
		tui: { terminal: screen.terminal, connect: core.connect, runShell: runner.runShell, statusIntervalMs: 0, ...tui },
	};
	const code = run(args.length === 0 ? ["--no-session"] : args, io, (() => undefined) as never);
	const send = (text: string) => {
		screen.type(text);
		screen.type("\r");
	};
	return { core, runner, screen, code, send };
}

describe("TUI shell commands", { timeout: 20_000 }, () => {
	it("runs !cmd in the session's folder, shows its output and saves only the result, with no model call", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("!echo hi");
		await until(() => h.runner.calls.length === 1);
		expect(h.runner.calls[0]?.command).toBe("echo hi");
		expect(h.runner.calls[0]?.options.cwd).toBe(cwd);
		h.runner.calls[0]?.options.onOutput?.("live hi\n");
		await until(() => h.screen.screen().includes("live hi"));
		h.runner.calls[0]?.finish({ ...done, output: "hi\n", exitCode: 3 });
		await until(() => h.core.sent("session.shell_result").length === 1);
		expect(h.core.sent("session.shell_result")[0]).toMatchObject({
			sessionId: "s1",
			result: { command: "echo hi", excludeFromContext: false, output: "hi\n", exitCode: 3, cancelled: false },
		});
		const saved = h.core.sent("session.shell_result")[0] as unknown as { result: { executionId: string } };
		expect(saved.result.executionId).toMatch(UUID);
		await until(() => h.screen.screen().includes("exit 3"));
		h.send("!!echo secret");
		await until(() => h.runner.calls.length === 2);
		h.runner.calls[1]?.finish({ ...done, output: "secret\n" });
		await until(() => h.core.sent("session.shell_result").length === 2);
		expect(h.core.sent("session.shell_result")[1]).toMatchObject({
			result: { command: "echo secret", excludeFromContext: true },
		});
		expect(h.core.sent("session.send")).toEqual([]);
		expect(h.core.sent("session.queue")).toEqual([]);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});

	it("runs at once during a turn, bypassing the steer queue, and refuses a second command keeping the draft", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("work");
		await until(() => h.core.sent("session.send").length === 1);
		await turn();
		h.send("!tail -f log");
		await until(() => h.runner.calls.length === 1);
		expect(h.core.sent("session.queue")).toEqual([]);
		for (let i = 0; i < 3; i++) h.runner.calls[0]?.options.onOutput?.(`chunk ${i}\n`);
		await until(() => h.screen.screen().includes("chunk 2"));
		h.screen.type("!second");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes(BUSY));
		expect(h.runner.calls).toHaveLength(1);
		// The draft stays: Esc stops the first command, and Enter then runs it.
		h.screen.type("\x1b");
		await until(() => h.runner.calls[0]?.options.signal?.aborted === true);
		expect(h.core.sent("session.interrupt")).toEqual([]);
		await until(() => h.core.sent("session.shell_result").length === 1);
		h.screen.type("\r");
		await until(() => h.runner.calls.length === 2);
		expect(h.runner.calls[1]?.command).toBe("second");
		h.screen.type("\x1b");
		await until(() => h.core.sent("session.shell_result").length === 2);
		h.core.finishTurn();
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("clears a shell draft with Esc before it interrupts a turn, and interrupts on the next Esc", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("work");
		await until(() => h.core.sent("session.send").length === 1);
		await turn();
		h.screen.type("!ls");
		h.screen.type("\x1b");
		h.screen.type("\r");
		expect(h.core.sent("session.interrupt")).toEqual([]);
		expect(h.runner.calls).toEqual([]);
		expect(h.core.sent("session.queue")).toEqual([]);
		h.screen.type("\x1b");
		await until(() => h.core.sent("session.interrupt").length === 1);
		h.core.finishTurn();
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("marks the editor as a shell outside the sandbox, and says what !! leaves out of the context", async () => {
		const h = open();
		await until(h.screen.started);
		h.screen.type("zzq");
		await until(() => h.screen.screen().includes("zzq"));
		expect(h.screen.screen()).not.toContain("Shell · outside sandbox");
		h.screen.type("\x15");
		h.screen.type("!ls");
		await until(() => h.screen.screen().includes("Shell · outside sandbox"));
		expect(h.screen.screen()).not.toContain("excluded from context");
		h.screen.type("\x01");
		h.screen.type("!");
		await until(() => h.screen.screen().includes("Shell · outside sandbox · excluded from context"));
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("recalls an accepted shell command from the history", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("!echo again");
		await until(() => h.runner.calls.length === 1);
		h.runner.calls[0]?.finish(done);
		await until(() => h.core.sent("session.shell_result").length === 1);
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.runner.calls.length === 2);
		expect(h.runner.calls[1]?.command).toBe("echo again");
		h.runner.calls[1]?.finish(done);
		await until(() => h.core.sent("session.shell_result").length === 2);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});

	it("sends a bare ! or !! as an ordinary prompt", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("!");
		await until(() => h.core.sent("session.send").length === 1);
		await turn();
		h.core.finishTurn();
		await turn();
		h.send("!!");
		await until(() => h.core.sent("session.send").length === 2);
		expect(h.core.sent("session.send").map((command) => (command as { prompt: string }).prompt)).toEqual(["!", "!!"]);
		expect(h.runner.calls).toEqual([]);
		h.core.finishTurn();
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("refuses a shell draft with an attached image, keeping the draft and the image", async () => {
		const h = open([], {}, { platform: "darwin", readClipboardImage: async () => png() });
		await until(h.screen.started);
		h.screen.type("!ls ");
		h.screen.type("\x16");
		await until(() => h.screen.screen().includes("[Image #1]"));
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Images"));
		expect(h.runner.calls).toEqual([]);
		expect(h.core.sent("session.send")).toEqual([]);
		// Dropping the shell mark sends the draft as a prompt, and the image is still there.
		h.screen.type("\x01");
		h.screen.type("\x1b[3~");
		h.screen.type("\r");
		await until(() => h.core.sent("session.send").length === 1);
		await turn();
		expect((h.core.sent("session.send")[0] as { images?: unknown[] }).images).toHaveLength(1);
		h.core.finishTurn();
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("shows the shell results of a resumed session, !! included, and starts nothing", async () => {
		const result = { executionId: "e", output: "hello\n", exitCode: 0, cancelled: false, truncated: false };
		const h = open(["--resume", "old"], {
			entries: [
				{ type: "prompt", turnId: "t", text: "first" },
				{ type: "shell_result", result: { ...result, command: "echo hello", excludeFromContext: false } },
				{ type: "shell_result", result: { ...result, command: "echo private", excludeFromContext: true, exitCode: 2 } },
			],
		});
		await until(() => h.screen.screen().includes("echo private"));
		const screen = h.screen.screen();
		expect(screen).toContain("echo hello");
		expect(screen).toContain("hello");
		expect(screen).toContain("excluded from context");
		expect(screen).toContain("exit 2");
		expect(h.runner.calls).toEqual([]);
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("aborts a running command when quitting, and saves its result before the session closes", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("!sleep 100");
		await until(() => h.runner.calls.length === 1);
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
		expect(h.runner.calls[0]?.options.signal?.aborted).toBe(true);
		const names = h.core.commands.map((command) => command.command as string);
		expect(names.indexOf("session.shell_result")).toBeGreaterThan(-1);
		expect(names.indexOf("session.shell_result")).toBeLessThan(names.indexOf("session.close"));
		expect(h.core.sent("session.shell_result")[0]).toMatchObject({ result: { cancelled: true } });
	});

	it("shows an error when the result is not saved, keeps the output visible and never runs the command again", async () => {
		const h = open([], { shellFails: true });
		await until(h.screen.started);
		h.send("!echo kept");
		await until(() => h.runner.calls.length === 1);
		h.runner.calls[0]?.finish({ ...done, output: "kept output\n" });
		await until(() => h.screen.screen().includes("disk full"));
		expect(h.screen.screen()).toContain("kept output");
		expect(h.runner.calls).toHaveLength(1);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});

	it("passes the command's bytes after the marker through, trailing spaces and heredoc lines included", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("!printf 'a' ");
		await until(() => h.runner.calls.length === 1);
		expect(h.runner.calls[0]?.command).toBe("printf 'a' ");
		h.runner.calls[0]?.finish(done);
		await until(() => h.core.sent("session.shell_result").length === 1);
		h.screen.type("\x1b[200~!!cat <<EOF\n  indented\nEOF\n\x1b[201~");
		h.screen.type("\r");
		await until(() => h.runner.calls.length === 2);
		expect(h.runner.calls[1]?.command).toBe("cat <<EOF\n  indented\nEOF\n");
		h.runner.calls[1]?.finish(done);
		await until(() => h.core.sent("session.shell_result").length === 2);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});

	it("keeps an ! followed only by blanks as an ordinary prompt", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("!  ");
		await until(() => h.core.sent("session.send").length === 1);
		await turn();
		expect(h.runner.calls).toEqual([]);
		h.core.finishTurn();
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("cancels a running command with Esc even while a question is open, and leaves the question open", async () => {
		const h = open();
		await until(h.screen.started);
		h.send("work");
		await until(() => h.core.sent("session.send").length === 1);
		await turn();
		h.send("!sleep 100");
		await until(() => h.runner.calls.length === 1);
		const questions = [{ id: "q1", question: "Pick one?", options: [{ id: "a", label: "Alpha" }] }];
		h.core.emit({ type: "user_question_requested", callId: "u1", questions });
		await until(() => h.screen.screen().includes("Pick one?"));
		h.screen.type("\x1b");
		await until(() => h.runner.calls[0]?.options.signal?.aborted === true);
		await until(() => h.core.sent("session.shell_result").length === 1);
		expect(h.core.sent("session.answer_user")).toEqual([]);
		expect(h.core.sent("session.interrupt")).toEqual([]);
		// Ctrl+C closes the question, interrupts the turn, and quits.
		for (let i = 0; i < 3; i++) h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("waits for a completed shell result to be saved before sending the next prompt", async () => {
		const ack = Promise.withResolvers<void>();
		const h = open([], { shellAck: ack.promise });
		try {
			await until(h.screen.started);
			h.send("!printf saved");
			await until(() => h.runner.calls.length === 1);
			h.runner.calls[0]?.finish({ ...done, output: "saved" });
			await until(() => h.core.sent("session.shell_result").length === 1);
			h.send("explain the output");
			expect(h.core.sent("session.send")).toEqual([]);
			h.screen.type("keep this draft");
			ack.resolve();
			await until(() => h.core.sent("session.send").length === 1);
			expect(h.core.sent("session.send")[0]).toMatchObject({ prompt: "explain the output", sessionId: "s1" });
			h.core.finishTurn();
			await turn();
			h.screen.type("\r");
			await until(() => h.core.sent("session.send").length === 2);
			expect(h.core.sent("session.send")[1]).toMatchObject({ prompt: "keep this draft" });
		} finally {
			ack.resolve();
			h.core.finishTurn();
			h.screen.type("\x03");
			await h.code;
		}
	});

	it.each(["/new", "/resume old"])(
		"keeps %s responsive and never sends a waiting prompt in the replacement session",
		async (control) => {
			const ack = Promise.withResolvers<void>();
			const h = open([], { shellAck: ack.promise });
			try {
				await until(h.screen.started);
				h.send("!printf saved");
				await until(() => h.runner.calls.length === 1);
				h.runner.calls[0]?.finish(done);
				await until(() => h.core.sent("session.shell_result").length === 1);
				h.send("old prompt");
				expect(h.core.sent("session.send")).toEqual([]);
				h.send(control);
				await until(() =>
					control === "/new" ? h.core.sent("session.start").length === 2 : h.core.sent("session.resume").length === 1,
				);
				await turn();
				h.send("new prompt");
				await until(() => h.core.sent("session.send").length === 1);
				ack.resolve();
				await turn();
				expect(h.core.sent("session.send")).toMatchObject([{ prompt: "new prompt" }]);
			} finally {
				ack.resolve();
				h.core.finishTurn();
				h.screen.type("\x03");
				await h.code;
			}
		},
	);

	it("clears a shell draft with Esc while leaving an open question alone", async () => {
		const h = open();
		try {
			await until(h.screen.started);
			h.send("work");
			await until(() => h.core.sent("session.send").length === 1);
			await turn();
			h.screen.type("!echo draft");
			const questions = [{ id: "q1", question: "Pick one?", options: [{ id: "a", label: "Alpha" }] }];
			h.core.emit({ type: "user_question_requested", callId: "u1", questions });
			await until(() => h.screen.screen().includes("Pick one?"));
			h.screen.type("\x1b");
			expect(h.core.sent("session.answer_user")).toEqual([]);
			expect(h.core.sent("session.interrupt")).toEqual([]);
			h.screen.type("\x03");
			await until(() => h.core.sent("session.answer_user").length === 1);
			h.core.finishTurn();
			await turn();
			h.screen.type("\r");
			expect(h.runner.calls).toEqual([]);
			h.send("after question");
			await until(() => h.core.sent("session.send").length === 2);
			expect(h.core.sent("session.send")[1]).toMatchObject({ prompt: "after question" });
		} finally {
			for (let i = 0; i < 3; i++) h.screen.type("\x03");
			await h.code;
		}
	});

	it("does not wait for a core that never saves the result when the session moves on", async () => {
		const h = open([], { shellHangs: true }, { closeTimeoutMs: 50 });
		await until(h.screen.started);
		h.send("!sleep 100");
		await until(() => h.runner.calls.length === 1);
		h.send("/new");
		await until(() => h.core.sent("session.start").length === 2);
		expect(h.runner.calls[0]?.options.signal?.aborted).toBe(true);
		expect(h.core.sent("session.shell_result")).toHaveLength(1);
		h.screen.type("\x03");
		expect(await h.code).toBe(130);
	});

	it("keeps a command's live output in one bounded block", () => {
		const conversation = new Conversation(painter(false), "/repo", new Shade(false));
		const block = conversation.shell("seq 1 5000", false);
		for (let i = 1; i <= 5000; i++) block.output(`line ${i}\n`);
		block.output("\u001b[31mred\u001b[0m\n");
		const lines = conversation.render(80);
		expect(lines.length).toBeLessThan(80);
		const text = lines.join("\n");
		expect(text).toContain("line 5000");
		expect(text).not.toContain("line 1 ");
		expect(text).toContain("␛[31mred");
		expect(text).not.toContain("\u001b");
		block.finish({ ...done, output: "tail\n", truncated: true, fullOutputPath: "/tmp/x/output.txt" });
		const final = conversation.render(80).join("\n");
		expect(final).toContain("exit 0");
		expect(final).toContain("/tmp/x/output.txt");
		expect(final.match(/seq 1 5000/g)).toHaveLength(1);
	});
});
