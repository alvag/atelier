import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type AtelierEvent, type ClientCommand, FakeBackend, type FakeStep, RpcServer } from "@atelier/core";
import type { CoreExit } from "@atelier/core/client";
import { decodeServerMessage, encodeMessage, LineSplitter } from "@atelier/core/protocol";
import { resetCapabilitiesCache, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";
import { type CliIO, run } from "../src/run.ts";
import type { CoreLink } from "../src/tui/app.ts";

requireIsolatedHome();

// The TUI, the real local shell runner, the real RPC server and session core, and only the model backend is fake.
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const answer: FakeStep[] = [
	{ event: { type: "text_delta", text: "ok" } },
	{ event: { type: "turn_finished", stopReason: "end_turn", usage } },
];

let cwd: string;
let home: string;
const closing = new Set<() => Promise<void>>();
const releases = new Set<() => void>();
beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-shell-e2e-")));
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-shell-e2e-home-")));
	vi.stubEnv("HOME", home);
	vi.stubEnv("SHELL", "/bin/sh");
});
afterEach(async () => {
	for (const release of releases) release();
	releases.clear();
	await Promise.all([...closing].map((close) => close()));
	vi.unstubAllEnvs();
	resetCapabilitiesCache();
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

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

/** The core in this process over the protocol's own encoding, saving sessions under `home`. */
function inProcessCore(backend: FakeBackend) {
	const commands: ClientCommand[] = [];
	let finished = 0;
	const connect = async (): Promise<CoreLink> => {
		const input = new PassThrough();
		const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		const listeners = new Set<(sessionId: string, event: AtelierEvent) => void>();
		const splitter = new LineSplitter();
		const server = new RpcServer({
			input,
			write: (chunk) => {
				for (const line of splitter.push(chunk)) {
					const message = decodeServerMessage(line);
					if (message.type === "event") {
						for (const listener of listeners) listener(message.sessionId, message.event);
						if (message.event.type === "turn_finished") finished++;
					}
					if (message.type !== "response") continue;
					const waiting = pending.get(message.id);
					pending.delete(message.id);
					if (message.ok) waiting?.resolve(message.result);
					else waiting?.reject(new Error(message.error.message));
				}
			},
			createBackend: () => backend,
			tools: [],
			systemPromptAppend: "",
			home,
		});
		const running = server.run();
		let nextId = 0;
		return {
			request(command) {
				commands.push(command);
				return new Promise((resolve, reject) => {
					const id = `r${++nextId}`;
					pending.set(id, { resolve, reject });
					input.write(encodeMessage({ ...command, type: "command", id }));
				});
			},
			onEvent(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onExit: (_listener: (exit: CoreExit) => void) => () => {},
			async close() {
				input.end();
				await running;
			},
		};
	};
	return { connect, commands, finished: () => finished };
}

/** Opens the TUI with no `runShell` hook: `!` commands run through the real runner. */
function open(turns: FakeStep[][], args: string[] = ["--no-review"]) {
	const backend = new FakeBackend(turns, "claude-code");
	const core = inProcessCore(backend);
	const screen = fakeTerminal();
	const errors: string[] = [];
	const io: CliIO = {
		stdin: new PassThrough(),
		isTTY: true,
		stdout: () => {},
		stderr: (text) => {
			errors.push(text);
		},
		cwd,
		home,
		color: false,
		tools: [],
		tui: { terminal: screen.terminal, connect: core.connect, statusIntervalMs: 0 },
	};
	const code = run(args, io, () => backend);
	const close = async () => {
		for (let i = 0; i < 3; i++) screen.type("\x03");
		await code;
	};
	closing.add(close);
	const forget = () => closing.delete(close);
	void code.then(forget, forget);
	const send = (text: string) => {
		screen.type(text);
		screen.type("\r");
	};
	const shellResults = () => core.commands.filter((command) => command.command === "session.shell_result");
	return { backend, core, screen, code, send, errors, shellResults };
}

const exists = (name: string) => existsSync(join(cwd, name));

describe("TUI user shell commands, end to end", { timeout: 30_000 }, () => {
	it("uses the system temporary directory", () => {
		if (process.platform !== "darwin") return;
		const system = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
		expect(tmpdir().replace(/\/$/, "")).toBe(system.replace(/\/$/, ""));
	});

	it("shows the output, calls no model for ! and !!, and gives the model the ! results once, in order, on the next prompt", async () => {
		const h = open([answer, answer]);
		await until(h.screen.started);
		h.send("!printf '\\146irst-out\\n'; exit 3");
		await until(() => h.shellResults().length === 1);
		await until(() => h.screen.screen().includes("first-out") && h.screen.screen().includes("exit 3"));
		h.send("!!printf '\\163ecret-out\\n'");
		await until(() => h.shellResults().length === 2);
		await until(() => h.screen.screen().includes("secret-out") && h.screen.screen().includes("excluded from context"));
		h.send("!printf '\\164hird-out\\n'; exit 4");
		await until(() => h.shellResults().length === 3);
		await until(() => h.screen.screen().includes("third-out") && h.screen.screen().includes("exit 4"));
		expect(h.backend.prompts).toEqual([]);
		h.send("hello model");
		await until(() => h.backend.prompts.length === 1);
		const prompt = h.backend.prompts[0] ?? "";
		expect(prompt.indexOf("first-out")).toBeGreaterThanOrEqual(0);
		expect(prompt.indexOf("third-out")).toBeGreaterThan(prompt.indexOf("first-out"));
		expect(prompt.indexOf("hello model")).toBeGreaterThan(prompt.indexOf("third-out"));
		expect(prompt).toContain("Command exited with code 3.");
		expect(prompt).not.toContain("secret-out");
		await until(() => h.core.finished() === 1 && h.screen.screen().includes("ok"));
		h.send("again");
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toBe("again");
		await until(() => h.core.finished() === 2);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});

	it("spawns a shell only when the editor submits it", async () => {
		const h = open([answer]);
		await until(h.screen.started);
		h.screen.type("!touch typed-only");
		h.screen.type("\x1b[200~!touch pasted-only\n\x1b[201~");
		// Esc clears a shell draft; a model prompt that merely mentions a command must not run it either.
		h.screen.type("\x1b");
		h.send("please do not run !touch mentioned-only");
		await until(() => h.core.finished() === 1);
		h.send("!touch submitted; printf '\\144one-marker\\n'");
		await until(() => h.shellResults().length === 1);
		await until(() => exists("submitted") && h.screen.screen().includes("done-marker"));
		expect(exists("typed-only") || exists("pasted-only") || exists("mentioned-only")).toBe(false);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});

	it("keeps !! out of the model's context, and a resume shows the commands without running them again", async () => {
		const first = open([answer]);
		first.backend.resumeState = { sessionId: "cc-1" };
		await until(first.screen.started);
		first.send("first prompt");
		await until(() => first.core.finished() === 1);
		first.send("!echo ran >> count.txt; printf '\\153ept-out\\n'");
		await until(() => first.shellResults().length === 1 && first.screen.screen().includes("kept-out"));
		first.send("!!echo ran >> count.txt; printf '\\150idden-out\\n'");
		await until(() => first.shellResults().length === 2);
		await until(
			() => first.screen.screen().includes("hidden-out") && first.screen.screen().includes("excluded from context"),
		);
		first.send("/exit");
		expect(await first.code).toBe(0);
		expect(first.core.commands.filter((c) => (c.command as string) === "session.shell_result")).toHaveLength(2);
		expect((await readFile(join(cwd, "count.txt"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);

		const second = open([answer], ["--no-review", "--continue"]);
		second.backend.resumeState = { sessionId: "cc-1" };
		await until(() => second.screen.screen().includes("hidden-out"));
		expect(second.screen.screen()).toContain("kept-out");
		second.send("next");
		await until(() => second.backend.prompts.length === 1);
		expect(second.backend.prompts[0]).toContain("kept-out");
		expect(second.backend.prompts[0]).not.toContain("hidden-out");
		await until(() => second.core.finished() === 1);
		second.send("/exit");
		expect(await second.code).toBe(0);
		expect((await readFile(join(cwd, "count.txt"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
	});

	it("cancels a running shell with Esc and leaves the active model turn running", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.add(release);
		const h = open([[{ event: { type: "text_delta", text: "working" } }, { run: () => held }, ...answer]]);
		await until(h.screen.started);
		h.send("work");
		await until(() => h.backend.prompts.length === 1);
		h.send("!touch started; sleep 60");
		await until(() => exists("started"));
		h.screen.type("\x1b");
		await until(() => h.screen.screen().includes("cancelled"));
		expect(h.backend.interrupts).toBe(0);
		release();
		await until(() => h.core.finished() === 1);
		expect(h.backend.interrupts).toBe(0);
		h.send("/exit");
		expect(await h.code).toBe(0);
	});
});
