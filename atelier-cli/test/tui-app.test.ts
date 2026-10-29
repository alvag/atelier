import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
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
	folderKey,
	RpcServer,
	Sandbox,
} from "@atelier/core";
import type { CoreExit } from "@atelier/core/client";
import { decodeServerMessage, encodeMessage, LineSplitter } from "@atelier/core/protocol";
import { type ProgramStatus, resetCapabilitiesCache, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeOpenAiAuth, fakeJwt, fakeRefresh } from "../../atelier-core/test/support/fake-openai-auth.ts";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";
import { run } from "../src/run.ts";
import type { CoreLink } from "../src/tui/app.ts";
import { HerdrStatusReporter } from "../src/tui/herdr-status.ts";

/** `/stats` reads as it does, after `held` when a test sets it. */
const statsRead = vi.hoisted(() => ({ held: undefined as Promise<void> | undefined }));
vi.mock("../src/tui/stats-command.ts", async (original) => {
	const command = await original<typeof import("../src/tui/stats-command.ts")>();
	return {
		...command,
		statsNote: async (...args: Parameters<typeof command.statsNote>) => {
			await statsRead.held;
			return command.statsNote(...args);
		},
	};
});

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
	// pi-tui reads the terminal's capabilities from the environment once and keeps them.
	resetCapabilitiesCache();
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
	/** Commands the core answers with an error instead of running them. */
	const failing = new Set<string>();
	const envs: Record<string, string>[] = [];
	const exitListeners = new Set<(exit: CoreExit) => void>();
	let closed = false;
	const connect = async (env: Record<string, string>): Promise<CoreLink> => {
		envs.push(env);
		const input = new PassThrough();
		const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		const eventListeners = new Set<(sessionId: string, event: AtelierEvent) => void>();
		exitListeners.clear();
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
				if (failing.has(command.command)) return Promise.reject(new Error(`${command.command} refused`));
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
	/** Tells the TUI the core exited, as a crashed process would. */
	const exit = (coreExit: CoreExit) => {
		for (const listener of exitListeners) listener(coreExit);
	};
	return { connect, commands, failing, envs, closed: () => closed, exit };
}

/** Takes out styles and terminal sequences; OSC and APC ones (hyperlinks, Kitty images) end at BEL or ST. */
const plain = (text: string) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the styles are what is taken out
	text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

/** A terminal that keeps what the TUI wrote, without its styles, and types keys into it. */
function fakeTerminal(columns = 100) {
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
		columns,
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
		screen: () => plain(written),
		type: (data: string) => onInput?.(data),
		/** Everything written, styles and terminal sequences included. */
		raw: () => written,
		started: () => onInput !== undefined,
		stopped: () => stopped,
		statuses,
		titles,
	};
}

function harness(
	turns: FakeStep[][],
	options: { saveSessions?: boolean; children?: FakeBackend[]; backendId?: string; columns?: number } = {},
) {
	const backend = new FakeBackend(turns, options.backendId);
	let terminate: ((signal: number) => void) | undefined;
	const core = inProcessCore(backend, options.saveSessions ?? false, options.children ?? [], options.backendId);
	const screen = fakeTerminal(options.columns);
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
		// No test runs the real Claude Code or asks the real Keychain: a missing binary and an empty Keychain.
		claudeCode: join(home, "no-claude-in-tests"),
		runSecurity: async () => ({ code: 44, stdout: "", stderr: "" }),
		tui: {
			terminal: screen.terminal,
			connect: core.connect,
			...({ answerGuardMs: 0, statusIntervalMs: 0 } as { answerGuardMs?: number }),
		},
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
		expect(screen).toContain("⎿ Read 1 file");
		expect(screen).toContain(`m · ${basename(cwd)} · profile default · auto · sandbox ✗ · $0.50`);
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
		expect(h.screen.stopped()).toBe(true);
		expect(h.core.closed()).toBe(true);
		expect(h.backend.closed).toBe(true);
	});

	it("prints the session's setup and its cost with /status, and not in the transcript", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/status");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("cost: none yet"));
		h.screen.type("hi");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(h.screen.screen()).not.toContain("atelier · fake · m · subscription");
		h.screen.type("/status");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("cost: $0.5000 this session"));
		expect(h.screen.screen()).toContain("atelier · fake · m · subscription");
		expect(h.backend.prompts).toEqual(["hi"]);
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	/** Saves a session of `folder` with one billed turn that ended `daysAgo`, as the core lays it out. */
	async function savedSession(folder: string, id: string, costUsd: number, daysAgo = 1): Promise<void> {
		const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
		const path = join(home, ".atelier", "sessions", folderKey(folder));
		await mkdir(path, { recursive: true });
		const lines = [
			{ kind: "atelier.session", version: 1, id, cwd: folder, createdAt: at },
			{ type: "config", backend: "anthropic-api", model: "saved-model", mode: "normal" },
			{ type: "event", event: { ...finished, seq: 2, turnId: "t", usage, costUsd, at } },
		];
		await writeFile(join(path, `${id}.jsonl`), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	}

	it("prints this session's stats with /stats and this folder's with /stats project, with their costs", async () => {
		await savedSession(cwd, "older", 2);
		await savedSession(cwd, "ancient", 3, 60);
		await savedSession(join(cwd, "elsewhere"), "other", 7);
		const h = harness([[{ event: started }, { event: finished }]], { saveSessions: true, columns: 160 });
		const code = run(["--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("hi");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("/stats");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("stats · this session · finished turns"));
		const session = h.screen.screen();
		expect(session).toContain("reading saved sessions…");
		expect(session).toContain("≈$0.50 subscription (API-equivalent, not billed)");
		expect(session).toMatch(/By model +cost +turns/);
		expect(session).not.toContain("By project");
		expect(session).not.toContain("$2.00");

		h.screen.type("/stats project");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("stats · this folder · last 30 days · 2 sessions"));
		expect(h.screen.screen()).toContain("$2.00 billed · ≈$0.50 subscription");
		expect(h.screen.screen()).toMatch(/By day +cost/);
		expect(h.screen.screen()).not.toContain("$7.00");

		h.screen.type("/stats project --since all");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("stats · this folder · all time · 3 sessions"));
		expect(h.screen.screen()).toContain("$5.00 billed");

		h.screen.type("/stats --since soon");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("--since must be a number of days (7d), a date (2026-10-01) or all"));
		h.screen.type("/stats everything");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("usage: /stats [project] [--since 7d|YYYY-MM-DD|all]"));
		expect(h.backend.prompts).toEqual(["hi"]);
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	it("runs /stats while a turn runs, counting the turns that finished, and queues nothing", async () => {
		await savedSession(cwd, "older", 2);
		const gate: { release?: () => void } = {};
		const h = harness(
			[
				[
					{ event: started },
					{ run: () => new Promise<void>((resolve) => (gate.release = resolve)) },
					{ event: finished },
				],
			],
			{ saveSessions: true, columns: 160 },
		);
		const code = run(["--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => gate.release !== undefined);
		h.screen.type("/stats");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("No finished turns yet."));
		h.screen.type("/stats project");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("stats · this folder · last 30 days · 1 session"));
		expect(h.screen.screen()).not.toContain("commands run when the turn ends");
		expect(h.core.commands.filter((command) => command.command === "session.queue")).toEqual([]);
		gate.release?.();
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	it("prints a /stats read in the session it was asked in, and reads again in the next one at once", async () => {
		const h = harness([[{ event: started }, { event: finished }]], { saveSessions: true, columns: 160 });
		const code = run(["--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("hi");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		const release: { read?: () => void } = {};
		statsRead.held = new Promise<void>((resolve) => (release.read = resolve));
		try {
			h.screen.type("/stats");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("reading saved sessions…"));
			h.screen.type("/new");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("── new session ──"));
			// The session moved on once the one before is closed.
			await until(() => h.core.commands.some((command) => command.command === "session.close"));
			h.screen.type("/stats");
			h.screen.type("\r");
			await until(() => h.screen.screen().split("reading saved sessions…").length > 2);
			expect(h.screen.screen()).not.toContain("still reading");
			release.read?.();
			await until(() => h.screen.screen().includes("No finished turns yet."));
			await until(() => h.screen.screen().includes("≈$0.50 subscription"));
		} finally {
			statsRead.held = undefined;
		}
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
		const after = plain(h.screen.raw().slice(h.screen.raw().lastIndexOf("\x1b[?1049l")));
		const at = (text: string) => after.indexOf(text);
		// The first session's report stays above the rule, the new session's empty one under it.
		expect(at("≈$0.50 subscription")).toBeGreaterThan(-1);
		expect(at("≈$0.50 subscription")).toBeLessThan(at("── new session ──"));
		expect(at("── new session ──")).toBeLessThan(at("No finished turns yet."));
	});

	it("says a session that is not saved has no stats of its own", async () => {
		const h = harness([]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/stats");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("stats: this session is not saved"));
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	it("shows the prompt on a shade taken from the terminal's background, with color", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		h.io.color = true;
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		// The terminal answers the TUI's question about its colors: a dark background.
		await until(() => h.screen.raw().includes("\x1b]11;?"));
		h.screen.type("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
		h.screen.type("\x1b[?62c");
		h.screen.type("hi");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(h.screen.screen()).toContain("› hi");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the background's sequence is what is checked
		expect(h.screen.raw()).toMatch(/\x1b\[48;(?:2;49;49;49|5;236)m› hi/);
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	it("shades the prompt and the editor a little darker on a light terminal, with color", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		h.io.color = true;
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		// The terminal answers a light background: #f0f0f0, whose shade is #e0e0e0.
		await until(() => h.screen.raw().includes("\x1b]11;?"));
		h.screen.type("\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\");
		h.screen.type("\x1b[?62c");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the background's sequence is what is checked
		const light = /\x1b\[48;(?:2;224;224;224|5;254)m/.source;
		h.screen.type("hi");
		// The editor's band takes the shade as soon as the terminal says its colors.
		await until(() => new RegExp(`${light}› hi`).test(h.screen.raw()));
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		const raw = h.screen.raw();
		// The prompt sent is a full-width block on the shade.
		expect(raw).toMatch(new RegExp(`${light}› hi {2,}\x1b\\[49m`));
		// The empty editor after it is on the same shade.
		expect(raw.slice(raw.lastIndexOf("› hi"))).toMatch(new RegExp(`${light}› .*Ask Atelier to do anything`));
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	it("keeps the palette's shade, without an unhandled rejection, when asking the terminal its colors fails", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const h = harness([]);
			h.io.color = true;
			const write = h.screen.terminal.write;
			h.screen.terminal.write = (data) => {
				if (data.includes("\x1b]11;?")) throw new Error("the terminal went away");
				write(data);
			};
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("Ask Atelier to do anything"));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(rejections).toEqual([]);
			expect(h.screen.raw()).toContain("\x1b[100m");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("shows the editor as a shaded band after ›, with a placeholder while it is empty, with color", async () => {
		const h = harness([]);
		h.io.color = true;
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(() => h.screen.screen().includes("Ask Atelier to do anything"));
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the background's sequence is what is checked
		expect(h.screen.raw()).toMatch(/\x1b\[100m› .*Ask Atelier to do anything/);
		expect(h.screen.screen()).not.toContain("─".repeat(20));
		h.screen.type("fix it");
		await until(() => h.screen.screen().includes("› fix it"));
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("keeps the editor's lines and no placeholder without color", async () => {
		const h = harness([]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(() => h.screen.screen().includes("─".repeat(20)));
		expect(h.screen.screen()).not.toContain("Ask Atelier to do anything");
		expect(h.screen.screen()).not.toContain("›");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("shows the status line items of ~/.atelier/settings.json, and starts with a warning when one is wrong", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		await mkdir(join(home, ".atelier"));
		await writeFile(
			join(home, ".atelier", "settings.json"),
			JSON.stringify({ kind: "atelier.settings", version: 1, tui: { statusLine: ["cost", "weather", "mode"] } }),
		);
		const code = run(["--no-session", "--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes(" $0.50 · auto"));
		expect(h.screen.screen().replace(/\s+/g, " ")).toContain('unknown status line item "weather"; skipped');
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("shows the working folder and its git branch, read again when a turn ends", async () => {
		const h = harness([[{ event: started }, { event: finished }]]);
		await mkdir(join(cwd, ".git"));
		await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(() => h.screen.screen().includes(`${basename(cwd)} · main ·`));
		await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/feat/next\n");
		h.screen.type("switch");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes(`${basename(cwd)} · feat/next ·`));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	describe("full screen", () => {
		const ALT_ON = "\x1b[?1049h";
		const ALT_OFF = "\x1b[?1049l";
		const rows = (count: number, word: string) =>
			Array.from({ length: count }, (_, i) => `${word} ${String(i + 1).padStart(2, "0")}`).join("\n\n");

		it("takes the alternate screen with a header, and leaves the transcript in the terminal on exit", async () => {
			const h = harness([
				[{ event: started }, { event: { type: "text_delta", text: "Hello back." } }, { event: finished }],
			]);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("Atelier "));
			expect(h.screen.raw()).toContain(ALT_ON);
			// The folder as far as the terminal's width goes: a long temporary directory is cut with an ellipsis.
			const shownPath = h.screen.screen().match(/Atelier \S+ · (\S+)/)?.[1] ?? "";
			const kept = shownPath.replace(/(?:\.\.\.|…)$/, "");
			expect(kept.length).toBeGreaterThan(1);
			if (kept === shownPath) expect(shownPath).toBe(cwd);
			else expect(cwd.startsWith(kept)).toBe(true);
			h.screen.type("hello");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			const after = plain(h.screen.raw().slice(h.screen.raw().lastIndexOf(ALT_OFF)));
			expect(after).toContain("Atelier ");
			expect(after).toContain("❯ hello");
			expect(after).toContain("Hello back.");
			// The editor and the status line stay behind in the alternate screen.
			expect(after).not.toContain("sandbox ✗");
		});

		it("shows the header in a terminal with Kitty images, such as Herdr or Warp", async () => {
			vi.stubEnv("TERM_PROGRAM", "herdr");
			resetCapabilitiesCache();
			// Wide enough for the whole folder, however long the temporary directory is.
			const h = harness([], { columns: cwd.length + 100 });
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("Atelier "));
			expect(h.screen.screen()).toMatch(new RegExp(`Atelier \\S+ · \\S*${basename(cwd)}`));
			h.screen.type("\x04");
			expect(await code).toBe(0);
		});

		it("keeps the main screen with --no-fullscreen or the setting", async () => {
			const flag = harness([]);
			const first = run(["--no-session", "--no-fullscreen"], flag.io, () => flag.backend);
			await until(() => flag.screen.screen().includes("Atelier "));
			flag.screen.type("\x04");
			expect(await first).toBe(0);
			expect(flag.screen.raw()).not.toContain(ALT_ON);

			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "settings.json"),
				JSON.stringify({ kind: "atelier.settings", version: 1, tui: { fullscreen: false } }),
			);
			const setting = harness([]);
			const second = run(["--no-session"], setting.io, () => setting.backend);
			await until(() => setting.screen.screen().includes("Atelier "));
			setting.screen.type("\x04");
			expect(await second).toBe(0);
			expect(setting.screen.raw()).not.toContain(ALT_ON);
		});

		it("scrolls with PageUp, PageDown and the wheel, and follows new output only at the end", async () => {
			const h = harness([
				[{ event: started }, { event: { type: "text_delta", text: rows(60, "row") } }, { event: finished }],
				[{ event: { type: "text_delta", text: "fresh answer" } }, { event: { ...finished, costUsd: 1 } }],
			]);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("long");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("row 60"));
			await until(() => h.screen.screen().includes("$0.50"));
			const since = (mark: number) => plain(h.screen.raw().slice(mark));

			let mark = h.screen.raw().length;
			for (let i = 0; i < 4; i++) h.screen.type("\x1b[5~");
			await until(() => since(mark).includes("row 01"));
			mark = h.screen.raw().length;
			for (let i = 0; i < 4; i++) h.screen.type("\x1b[6~");
			await until(() => since(mark).includes("row 60"));

			// Scrolled up with the wheel, a new answer does not move the view; back at the end, it shows.
			mark = h.screen.raw().length;
			for (let i = 0; i < 30; i++) h.screen.type("\x1b[<64;10;5M");
			await until(() => since(mark).includes("Jump to latest"));
			mark = h.screen.raw().length;
			h.screen.type("more");
			h.screen.type("\r");
			await until(() => since(mark).includes("$1.50"));
			expect(since(mark)).not.toContain("fresh answer");
			mark = h.screen.raw().length;
			for (let i = 0; i < 60; i++) h.screen.type("\x1b[<65;10;5M");
			await until(() => since(mark).includes("fresh answer"));
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("says why the core exited after giving the terminal back", async () => {
			const h = harness([]);
			let saidAt = -1;
			h.io.stderr = (text: string) => {
				if (text.includes("The core exited")) saidAt = h.screen.raw().length;
			};
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("Atelier "));
			h.core.exit({ code: 1, signal: null, stderr: "boom" });
			expect(await code).toBe(1);
			expect(saidAt).toBeGreaterThan(h.screen.raw().lastIndexOf(ALT_OFF));
		});

		it("shows Atelier's version in the status line when it is chosen", async () => {
			const h = harness([]);
			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "settings.json"),
				JSON.stringify({ kind: "atelier.settings", version: 1, tui: { statusLine: ["version", "mode"] } }),
			);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => /v\d+\.\d+\.\d+\S* · normal/.test(h.screen.screen()));
			h.screen.type("\x04");
			expect(await code).toBe(0);
		});

		it("opens a block of calls with a click on its line", async () => {
			const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo one" } } }, { event: finished }]]);
			const code = run(["--no-session", "--mode", "yolo"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("run");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("◇ "));
			// The row the line was last drawn on, from the cursor move before it.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the cursor moves are what is read
			const drawn = [...h.screen.raw().matchAll(/\x1b\[(\d+);1H\x1b\[2K ⎿ Ran 1 command/g)].at(-1);
			const row = drawn?.[1] ?? "0";
			h.screen.type(`\x1b[<0;5;${row}M`);
			h.screen.type(`\x1b[<0;5;${row}m`);
			await until(() => h.screen.screen().includes("│ $ echo one"));
			expect(h.screen.screen()).toContain("✓ bash echo one · exit 0");
			h.screen.type("\x04");
			expect(await code).toBe(0);
		});

		describe("a click on the editor's band, with color", () => {
			/**
			 * The row the line that starts with `text` was last drawn on, from the cursor move before it; the line is read
			 * without its styles, since the editor's cursor is one inside the text.
			 */
			const rowOf = (raw: string, text: string) => {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: the cursor moves are what is read
				const lines = [...raw.matchAll(/\x1b\[(\d+);1H\x1b\[2K(.*?)(?=\x1b\[\d+;\d+H|$)/gs)];
				const drawn = lines.filter((line) => plain(line[2] ?? "").startsWith(text)).at(-1);
				if (drawn?.[1] === undefined) throw new Error(`the line "${text}" was never drawn`);
				return Number(drawn[1]);
			};
			/** A left click, pressed and released on the same cell; `column` and `row` start at 1. */
			const click = (h: ReturnType<typeof harness>, column: number, row: number) => {
				h.screen.type(`\x1b[<0;${column};${row}M`);
				h.screen.type(`\x1b[<0;${column};${row}m`);
			};
			/** Types `text`, then waits until the editor shows it on the line that starts with `line`. */
			const typeShown = async (h: ReturnType<typeof harness>, text: string, line: string) => {
				h.screen.type(text);
				await until(() => h.screen.screen().includes(line));
			};

			it("puts the cursor before the text when it lands on the › or the space after it", async () => {
				const h = harness([[{ event: started }, { event: finished }]]);
				h.io.color = true;
				const code = run(["--no-session"], h.io, () => h.backend);
				await until(h.screen.started);
				await typeShown(h, "fix it", "› fix it");
				click(h, 1, rowOf(h.screen.raw(), "› fix it"));
				await typeShown(h, "A", "› Afix it");
				click(h, 2, rowOf(h.screen.raw(), "› Afix it"));
				await typeShown(h, "B", "› BAfix it");
				h.screen.type("\r");
				await until(() => h.screen.screen().includes("$0.50"));
				expect(h.backend.prompts).toEqual(["BAfix it"]);
				h.screen.type("\x04");
				expect(await code).toBe(0);
			});

			it("puts the cursor at the end of the text when it lands on the right edge", async () => {
				const h = harness([[{ event: started }, { event: finished }]]);
				h.io.color = true;
				const code = run(["--no-session"], h.io, () => h.backend);
				await until(h.screen.started);
				await typeShown(h, "fix it", "› fix it");
				click(h, 1, rowOf(h.screen.raw(), "› fix it"));
				click(h, h.screen.terminal.columns, rowOf(h.screen.raw(), "› fix it"));
				await typeShown(h, "!", "› fix it!");
				h.screen.type("\r");
				await until(() => h.screen.screen().includes("$0.50"));
				expect(h.backend.prompts).toEqual(["fix it!"]);
				h.screen.type("\x04");
				expect(await code).toBe(0);
			});

			it("finds the text after the mark on every wrapped line of a narrow terminal", async () => {
				const h = harness([[{ event: started }, { event: finished }]], { columns: 12 });
				h.io.color = true;
				const code = run(["--no-session"], h.io, () => h.backend);
				await until(h.screen.started);
				// Ten columns are left after the mark, one of them for the cursor: the text wraps after nine.
				await typeShown(h, "abcdefghijklmnop", "  jklmnop");
				expect(h.screen.screen()).toContain("› abcdefghi");
				// On the second line's fifth column, the third after its indent: before its third letter.
				click(h, 5, rowOf(h.screen.raw(), "  jklmnop"));
				await typeShown(h, "X", "  jkXlmnop");
				// On the first line's mark: before the text.
				click(h, 1, rowOf(h.screen.raw(), "› abcdefghi"));
				await typeShown(h, "Y", "› Yabcdefgh");
				h.screen.type("\r");
				// The footer is too narrow for the cost: the turn's end is the program status it reports.
				await until(() => h.screen.statuses.at(-1)?.state === "done");
				expect(h.backend.prompts).toEqual(["YabcdefghijkXlmnop"]);
				h.screen.type("\x04");
				expect(await code).toBe(0);
			});
		});

		it("copies the text selected with the mouse to the clipboard", async () => {
			const h = harness([]);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("Atelier "));
			// Pressed on the header's first column (the first row), dragged to its 40th and released.
			h.screen.type("\x1b[<0;1;1M");
			h.screen.type("\x1b[<32;40;1M");
			h.screen.type("\x1b[<0;40;1m");
			await until(() => h.screen.raw().includes("\x1b]52;c;"));
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the clipboard sequence is what is read
			const copied = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(h.screen.raw())?.[1] ?? "";
			expect(Buffer.from(copied, "base64").toString()).toContain("Atelier");
			h.screen.type("\x04");
			expect(await code).toBe(0);
		});
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
		// Allow, the two answers that remember "echo second", then Deny.
		h.screen.type("\x1b[B");
		h.screen.type("\x1b[B");
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
			[{ toolCall: { tool: "bash", input: { command: "echo 1\necho 2\necho 3" } } }, { event: finished }],
		]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		const dialog = () => h.screen.screen().slice(h.screen.screen().lastIndexOf("Run this command?"));
		expect(dialog()).toContain("echo 1 … 2 more lines (Ctrl+O)");
		expect(dialog()).not.toContain("echo 3");
		h.screen.type("\x0f");
		await until(() => dialog().includes("echo 3"));
		expect(dialog()).toContain("echo 2");
		expect(dialog()).not.toContain("more lines");
		h.screen.type("\x0f");
		await until(() => !dialog().includes("echo 3"));
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("3");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("hides the editor while a question is open, even from a click, and gives back what it held", async () => {
		const gate: { release?: () => void } = {};
		const h = harness([
			[
				{ run: () => new Promise<void>((resolve) => (gate.release = resolve)) },
				{ toolCall: { tool: "bash", input: { command: "echo hi" } } },
				{ event: finished },
			],
			[{ event: finished }],
		]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => gate.release !== undefined);
		h.screen.type("draft");
		await until(() => h.screen.screen().includes("draft"));
		// The row the editor was last drawn on, from the cursor move before it.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the cursor moves are what is read
		const rows = [...h.screen.raw().matchAll(/\x1b\[(\d+);1H\x1b\[2K[^\x1b]*draft/g)];
		const row = rows.at(-1)?.[1] ?? "0";
		gate.release?.();
		await until(() => h.screen.screen().includes("Run this command?"));
		const shown = h.screen.raw().length;
		const since = () => plain(h.screen.raw().slice(shown));
		// A click where the editor was, then keys and Enter: they all go to the question, which Enter answers.
		h.screen.type(`\x1b[<0;5;${row}M`);
		h.screen.type(`\x1b[<0;5;${row}m`);
		h.screen.type("xyz");
		h.screen.type("\r");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toContain("hi");
		expect(h.core.commands.filter((command) => command.command === "session.queue")).toEqual([]);
		// The editor came back with what it held, without what was typed to the question.
		await until(() => since().includes("draft"));
		expect(since()).not.toContain("xyz");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\r");
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toBe("draft");
		await until(() => h.screen.screen().includes("$1.00"));
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("denies an approval with Ctrl+C during a turn, and interrupts the turn only with the next one", async () => {
		const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo hi" } } }, { waitForInterrupt: true }]]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Run this command?"));
		h.screen.type("\x03");
		await until(() => h.backend.toolResults.length === 1);
		expect(h.backend.toolResults[0]?.output).toBe("The user denied this command.");
		expect(h.backend.interrupts).toBe(0);
		h.screen.type("\x03");
		await until(() => h.backend.interrupts === 1);
		await until(() => h.screen.screen().includes("interrupted"));
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
		await until(() => h.screen.screen().includes("◇ "));
		expect(h.screen.screen()).toContain("⎿ Ran 1 subagent");
		h.screen.type("\x0f");
		await until(() => h.screen.screen().includes("└ worker · 1 tool"));
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

	it("queues a steer with Enter and a follow-up with Alt+Enter while a turn runs, shows them and sends them", async () => {
		const gate: { release?: () => void } = {};
		const h = harness([
			[
				{ event: { type: "text_delta", text: "working" } },
				{ run: () => new Promise<void>((resolve) => (gate.release = resolve)) },
				{ toolCall: { tool: "read", input: { path: "a.ts" } } },
				{ event: finished },
			],
			[{ event: finished }],
		]);
		await writeFile(join(cwd, "a.ts"), "one\n");
		const code = run(["--no-session", "--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => gate.release !== undefined);
		h.screen.type("use tabs");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("↳ steer: use tabs"));
		h.screen.type("then docs");
		h.screen.type("\x1b\r");
		await until(() => h.screen.screen().includes("↳ follow-up: then docs"));
		expect(h.screen.screen()).toContain("Shift+↑ edit");
		// A command waits for the turn to end, in the editor.
		h.screen.type("/status");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("commands run when the turn ends"));
		expect(h.core.commands.filter((command) => command.command === "session.queue")).toEqual([
			{ command: "session.queue", sessionId: expect.any(String), kind: "steer", text: "use tabs" },
			{ command: "session.queue", sessionId: expect.any(String), kind: "follow_up", text: "then docs" },
		]);
		gate.release?.();
		await until(() => h.backend.prompts.length === 2);
		await until(() => h.screen.screen().includes("❯ then docs"));
		expect(h.backend.prompts).toEqual(["go", "then docs"]);
		expect(h.backend.toolResults[0]?.steering).toContain("use tabs");
		expect(h.screen.screen()).toContain("❯ use tabs");
		await until(() => h.screen.screen().includes("$1.00"));
		h.screen.type("\x03");
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});

	it("puts the text back in the editor when the core does not queue it", async () => {
		const h = harness([
			[{ event: { type: "text_delta", text: "working" } }, { waitForInterrupt: true }],
			[{ event: finished }],
		]);
		h.core.failing.add("session.queue");
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("working"));
		h.screen.type("use tabs");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("session.queue refused"));
		// Back in the editor: once the turn is over, Enter sends it.
		h.screen.type("\x1b");
		await until(() => h.screen.screen().includes("interrupted"));
		h.screen.type("\r");
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toBe("use tabs");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("takes the queue back to the editor with Shift+Up or Alt+Up and when the turn is interrupted", async () => {
		const h = harness([
			[{ event: { type: "text_delta", text: "working" } }, { waitForInterrupt: true }],
			[{ event: finished }],
		]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("working"));
		h.screen.type("one");
		h.screen.type("\r");
		h.screen.type("two");
		h.screen.type("\x1b\r");
		await until(() => h.screen.screen().includes("↳ follow-up: two"));
		/** How many times the screen has drawn `text`: the editor draws what comes back to it once more. */
		const drawn = (text: string) => h.screen.screen().split(text).length - 1;
		const queued = () =>
			h.core.commands.flatMap((command) => (command.command === "session.queue" ? [command.text] : []));
		const unqueued = () => h.core.commands.filter((command) => command.command === "session.unqueue").length;
		let before = drawn("two");
		h.screen.type("\x1b[1;2A");
		await until(() => unqueued() === 1);
		await until(() => drawn("two") > before);
		// What came back is in the editor: Enter queues it again, as one steer.
		h.screen.type("\r");
		await until(() => queued().at(-1) === "one\n\ntwo");
		await until(() => h.screen.screen().includes("↳ steer: one two"));
		// Alt+Up takes it back too, where the terminal sends Option as Alt.
		before = drawn("two");
		h.screen.type("\x1b[1;3A");
		await until(() => unqueued() === 2);
		await until(() => drawn("two") > before);
		h.screen.type("\r");
		await until(() => queued().length === 4);
		expect(queued().at(-1)).toBe("one\n\ntwo");
		before = drawn("two");
		h.screen.type("\x1b");
		await until(() => h.screen.screen().includes("interrupted"));
		// The interrupt gave it back again, and Enter now sends it as a prompt.
		await until(() => drawn("two") > before);
		h.screen.type("\r");
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toBe("one\n\ntwo");
		h.screen.type("\x04");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x04");
		expect(await code).toBe(0);
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
		expect(h.screen.screen()).toContain(`claude-sonnet-5-5 high · ${basename(cwd)} · profile default`);
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
			{ command: "session.start", cwd, mode: "auto", userQuestions: true },
			{ command: "session.start", cwd, mode: "auto", userQuestions: true },
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

	it("titles the terminal with the first prompt or the name, on /new, /resume and /rename, each title once", async () => {
		const h = harness([[{ event: finished }], [{ event: finished }]], { saveSessions: true, backendId: "claude-code" });
		h.backend.resumeState = { sessionId: "cc-1" };
		const folder = basename(cwd);
		const code = run(["--mode", "auto"], h.io, () => h.backend);
		await until(h.screen.started);
		const send = async (line: string, shown: string) => {
			h.screen.type(line);
			h.screen.type("\r");
			await until(() => h.screen.screen().includes(shown));
		};
		await send("/status", "cost: none yet");
		await send("fix the footer", "$0.50");
		await send("and the docs", "$1.00");
		expect(h.screen.titles).toEqual([`Atelier - ${folder}`, `Atelier - fix the footer - ${folder}`]);
		await send("/new", "── new session ──");
		await until(() => h.screen.titles.at(-1) === `Atelier - ${folder}`);
		await send("/resume", "Resume a session");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("── resumed session ──"));
		await until(() => h.screen.titles.at(-1) === `Atelier - fix the footer - ${folder}`);
		await send("/rename", "usage: /rename <name>");
		await send(`/rename ${"n".repeat(201)}`, "must have 1 to 200 characters");
		await send("/rename  Footer work ", "session renamed to Footer work");
		expect(h.core.commands.filter((command) => command.command === "session.rename").at(-1)).toMatchObject({
			cwd,
			name: "Footer work",
		});
		expect(h.screen.titles).toEqual([
			`Atelier - ${folder}`,
			`Atelier - fix the footer - ${folder}`,
			`Atelier - ${folder}`,
			`Atelier - fix the footer - ${folder}`,
			`Atelier - Footer work - ${folder}`,
		]);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("folds the thinking once the turn moves on, and opens and folds it with Ctrl+R", async () => {
		const h = harness([
			[
				{ event: { type: "thinking_delta", text: "Weighing the alias." } },
				{ event: { type: "text_delta", text: "Settled." } },
				{ event: finished },
			],
		]);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("think");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(h.screen.screen()).toContain("✻ Thinking…");
		expect(h.screen.screen()).not.toContain("Weighing the alias.");
		h.screen.type("\x12");
		await until(() => h.screen.screen().includes("✻ Weighing the alias."));
		// The screen keeps what was written before: the fold is one more `✻ Thinking…` after the open thinking.
		h.screen.type("\x12");
		await until(() => h.screen.screen().split("✻ Weighing the alias.").at(-1)?.includes("✻ Thinking…") === true);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("starts with the thinking folded when the setting says so, and opens and folds it with Ctrl+R", async () => {
		const h = harness([[{ event: { type: "thinking_delta", text: "Weighing the alias." } }, { event: finished }]]);
		await mkdir(join(home, ".atelier"));
		await writeFile(
			join(home, ".atelier", "settings.json"),
			JSON.stringify({ kind: "atelier.settings", version: 1, tui: { hideThinking: true } }),
		);
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("think");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		expect(h.screen.screen()).toContain("✻ Thinking…");
		expect(h.screen.screen()).not.toContain("Weighing the alias.");
		h.screen.type("\x12");
		await until(() => h.screen.screen().includes("✻ Weighing the alias."));
		h.screen.type("\x12");
		await until(() => h.screen.screen().includes("✻ Thinking…"));
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("puts an open tool card on a background of its own once the terminal says its colors", async () => {
		const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo one" } } }, { event: finished }]]);
		h.io.color = true;
		const code = run(["--no-session", "--mode", "yolo"], h.io, () => h.backend);
		await until(h.screen.started);
		await until(() => h.screen.raw().includes("\x1b]11;?"));
		h.screen.type("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
		h.screen.type("\x1b[?62c");
		h.screen.type("run");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("$0.50"));
		h.screen.type("\x0f");
		await until(() => h.screen.screen().includes("$ echo one"));
		// The card's background is lighter than the terminal's #1e1e1e, and not the prompt's shade.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the background's sequence is what is checked
		const card = /\x1b\[48;(?:2;(\d+);\d+;\d+|5;\d+)m ✓ bash echo one/.exec(h.screen.raw());
		expect(card).not.toBeNull();
		if (card?.[1] !== undefined) expect(Number(card[1])).toBeGreaterThan(30);
		expect(card?.[0]).not.toContain("49;49;49");
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
		expect(h.screen.screen()).toContain("⎿ Ran 1 command");
		expect(h.screen.screen()).not.toContain("│ $ echo one");
		h.screen.type("\x0f");
		await until(() => h.screen.screen().includes("│ $ echo one"));
		expect(h.screen.screen()).toContain("✓ bash echo one · exit 0");
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
		expect(screen).toContain("to␛[31mol");
		// The first Ctrl+C closes the question, the second quits.
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("shows the session's MCP servers with /mcp, asking the core for them", async () => {
		const h = harness([]);
		const stub = stubCore({
			answer: (command) =>
				command.command === "session.mcp"
					? {
							servers: [{ name: "docs", transport: "http", state: "connected", tools: ["search", "read"] }],
							problems: [],
						}
					: undefined,
		});
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/mcp");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("docs (http): connected, 2 tools"));
		expect(h.screen.screen()).toContain("search, read");
		expect(stub.log.commands).toContainEqual({ command: "session.mcp", sessionId: "s1" });
		h.screen.type("/mcp login docs");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Signing in to docs: the browser opens"));
		expect(stub.log.commands).toContainEqual({ command: "session.mcp_login", sessionId: "s1", server: "docs" });
		h.screen.type("\x03");
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
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
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
	function listingCore(
		signedIn: string[] = ["claude-code", "openai-codex"],
		fields: Record<string, unknown> = {},
		listed: Record<string, unknown> = {},
	) {
		let configuration: Record<string, unknown> = {
			backend: "claude-code",
			model: "opus",
			thinking: "medium",
			effort: "medium",
			permissionMode: "normal",
			profile: { name: "cheap", origin: "active" },
			pending: false,
			...fields,
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
								// The default is said, not taken from the list's order.
								{ name: "claude-code", default: "sonnet", models: ["opus", "sonnet"] },
								{ name: "anthropic-api", default: "api-model", models: ["api-model"] },
								{ name: "openai-codex", default: "gpt-luna", models: ["gpt-luna"] },
							],
							models: signedIn.flatMap((provider) =>
								(provider === "claude-code" ? ["opus", "sonnet"] : ["gpt-luna"]).map((model) => ({ provider, model })),
							),
							efforts: ["low", "medium", "high"],
							modes: ["normal", "auto", "yolo"],
							profiles: ["cheap", "fast"],
							active: "cheap",
							...listed,
						};
					case "session.set_model":
						return change({ model: command.model });
					case "session.set_effort":
						return change({ thinking: command.effort, effort: command.effort });
					case "session.set_profile":
						return change({ profile: { name: command.profile, origin: "explicit" } });
					case "session.set_backend":
						return {
							...change({ backend: command.backend, model: command.model ?? "api-model" }),
							backendChange: { from: "claude-code", summarized: true },
						};
					case "sessions.list":
						return {
							sessions: ["old1", "old2"].map((id) => ({
								id,
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
								turns: 1,
								lastPrompt: `prompt of ${id}`,
								resumable: true,
							})),
						};
					case "session.resume":
						return { sessionId: "s1", configuration, entries: [] };
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
		expect(stub.log.commands).toContainEqual({
			command: "session.start",
			cwd,
			mode: "normal",
			noSession: true,
			userQuestions: true,
		});
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
		await until(() => h.screen.screen().includes(`opus medium · ${basename(cwd)} · profile cheap · normal`));
		const sent = (name: string) => stub.log.commands.filter((command) => command.command === name);

		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("gpt-luna [openai-codex]"));
		expect(h.screen.screen()).toMatch(/opus \[claude-code\] +current/);
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
		expect(h.screen.screen()).toContain(`sonnet high · ${basename(cwd)} · profile fast · normal`);

		// Esc closes a list without changing anything.
		const mark = h.screen.raw().length;
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => plain(h.screen.raw().slice(mark)).includes("gpt-luna [openai-codex]"));
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
		["/model a b", "usage: /model [provider/model]"],
		["/effort high now", "usage: /effort [level]"],
		["/profile a b", "usage: /profile [name]"],
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
		// The models are asked for at start, whatever is typed.
		expect(stub.log.commands.map((command) => command.command).filter((name) => name !== "options.list")).toEqual([
			"session.start",
		]);
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("asks before moving to a model of another provider, starting on Stay, and moves with that model", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		const moves = () => stub.log.commands.filter((command) => command.command === "session.set_backend");

		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("gpt-luna [openai-codex]"));
		h.screen.type("\x1b[B");
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Move this session to openai-codex?"));
		expect(h.screen.screen()).toContain("detail is lost, and the prompt cache starts over.");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("model: opus (unchanged)"));
		expect(moves()).toEqual([]);

		h.screen.type("/model openai-codex/gpt-luna");
		h.screen.type("\r");
		await until(() => h.screen.screen().split("Move this session to openai-codex?").length === 3);
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("with a summary of the conversation"));
		expect(moves()).toEqual([
			{ command: "session.set_backend", sessionId: "s1", backend: "openai-codex", model: "gpt-luna" },
		]);
		expect(h.screen.screen()).toContain("backend: openai-codex, model: gpt-luna from the next turn");
		expect(h.screen.screen()).toContain(`gpt-luna medium · ${basename(cwd)} · profile cheap`);
		expect(stub.log.commands.filter((command) => command.command === "session.set_model")).toEqual([]);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("completes /model with the models of every provider signed in to, filtered as it is typed", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(() => stub.log.commands.some((command) => command.command === "options.list"));
		const mark = h.screen.raw().length;
		const since = () => plain(h.screen.raw().slice(mark));
		for (const key of "/model ") h.screen.type(key);
		await until(() => /gpt-luna +openai-codex/.test(since()));
		expect(since()).toMatch(/opus +claude-code · current/);
		expect(since()).toMatch(/sonnet +claude-code/);
		for (const key of "gpt") h.screen.type(key);
		await until(() => /\/model gpt *─+→ gpt-luna +openai-codex *$/.test(since()));
		h.screen.type("\t");
		await until(() => h.screen.screen().includes("/model openai-codex/gpt-luna"));
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Move this session to openai-codex?"));
		h.screen.type("\x1b");
		await until(() => h.screen.screen().includes("model: opus (unchanged)"));
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("filters /model's list by what is typed, with a counter and the model selected under it", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Select a model"));
		const dialog = () => h.screen.screen().slice(h.screen.screen().lastIndexOf("Select a model"));
		await until(() => dialog().includes("(1/3)"));
		expect(dialog()).toContain("claude-code/opus");
		expect(dialog()).toContain("Only showing models from configured providers. Use /login to add providers.");
		h.screen.type("\x1b[B");
		await until(() => dialog().includes("(2/3)") && dialog().includes("claude-code/sonnet"));
		for (const key of "gpt") h.screen.type(key);
		await until(() => dialog().includes("> gpt") && dialog().includes("(1/1)"));
		expect(dialog()).toContain("openai-codex/gpt-luna");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Move this session to openai-codex?"));
		h.screen.type("\x1b");
		await until(() => h.screen.screen().includes("model: opus (unchanged)"));
		const mark = h.screen.raw().length;
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => plain(h.screen.raw().slice(mark)).includes("Select a model"));
		for (const key of "zzz") h.screen.type(key);
		await until(() => dialog().includes("no model matches") && dialog().includes("(0/0)"));
		h.screen.type("\r");
		h.screen.type("\x1b");
		await until(() => !h.screen.screen().endsWith("│"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(stub.log.commands.map((command) => command.command)).not.toContain("session.set_model");
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("marks current the versioned id an alias in use stands for, and shows under the list what is known of the selected model", async () => {
		const h = harness([]);
		const stub = listingCore(
			undefined,
			{},
			{
				backends: [
					{
						name: "claude-code",
						default: "claude-opus-5-5",
						models: ["claude-opus-5-5", "claude-sonnet-5-5"],
						aliases: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" },
					},
				],
				models: [
					{
						provider: "claude-code",
						model: "claude-opus-5-5",
						name: "Claude Opus 5.5",
						contextWindow: 1_000_000,
						images: true,
					},
					{ provider: "claude-code", model: "claude-sonnet-5-5", contextWindow: 200_000, images: false },
					{ provider: "claude-code", model: "claude-haiku-5-5" },
				],
			},
		);
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("claude-sonnet-5-5 [claude-code]"));
		expect(h.screen.screen()).toMatch(/claude-opus-5-5 \[claude-code\] +current/);
		expect(h.screen.screen()).not.toContain("opus [claude-code]");
		expect(h.screen.screen()).toContain("Claude Opus 5.5 · 1M context · images");
		h.screen.type("\x1b[B");
		await until(() => h.screen.screen().includes("200K context · text only"));
		h.screen.type("\x1b[B");
		await until(() => h.screen.screen().includes("claude-code/claude-haiku-5-5"));
		h.screen.type("\x1b");
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("marks the backend's default current when no model was chosen, wherever the list has it", async () => {
		const h = harness([]);
		const stub = listingCore(undefined, { model: undefined });
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("gpt-luna [openai-codex]"));
		expect(h.screen.screen()).toMatch(/sonnet \[claude-code\] +current/);
		expect(h.screen.screen()).not.toMatch(/opus \[claude-code\] +current/);
		h.screen.type("\x1b");
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("keeps the model in use marked current and signed out when its provider has no sign-in", async () => {
		const h = harness([]);
		const stub = listingCore(["openai-codex"]);
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/model");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("gpt-luna [openai-codex]"));
		expect(h.screen.screen()).toMatch(/opus \[claude-code\] +current · signed out/);
		expect(h.screen.screen()).not.toContain("sonnet [claude-code]");
		h.screen.type("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(stub.log.commands.map((command) => command.command)).not.toContain("session.set_model");
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("asks for the models at start, and again after /login and /logout, so a new sign-in is listed", async () => {
		const h = harness([]);
		const stub = listingCore();
		Object.assign(h.io, { env: {} });
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		const lists = () => stub.log.commands.filter((command) => command.command === "options.list").length;
		await until(() => lists() === 1);
		h.screen.type("/login api-key opencode-go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("0 characters (hidden)"));
		h.screen.type("test-key");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("API key stored"));
		await until(() => lists() === 2);
		h.screen.type("/logout api-key opencode-go");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("API key removed"));
		await until(() => lists() === 3);
		h.screen.type("\x04");
		expect(await code).toBe(0);
	});

	it("says what is wrong with a model it cannot read, and that /backend is gone, without a turn", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/model claude-code/");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes('error: no model after the "claude-code/" prefix'));
		h.screen.type("/back");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(h.screen.screen()).not.toContain("Move the session to another backend");
		h.screen.type("end anthropic-api");
		h.screen.type("\r");
		await until(() =>
			h.screen.screen().includes("/backend no longer exists: pick a model of another provider in /model"),
		);
		h.screen.type("/backend");
		h.screen.type("\r");
		await until(
			() =>
				h.screen.screen().split("/backend no longer exists: pick a model of another provider in /model").length === 3,
		);
		expect(stub.log.commands.map((command) => command.command)).not.toContain("session.send");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("refuses a --model of another backend on resume, before taking the terminal, saying how to move", async () => {
		const h = harness([]);
		const stub = stubCore({
			answer: (command) =>
				command.command === "sessions.list"
					? { sessions: [{ id: "old1", backend: "claude-code", resumable: true }] }
					: { sessionId: "s1" },
		});
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		expect(await run(["--resume", "old1", "--model", "openai-codex/gpt-6-luna"], h.io, () => h.backend)).toBe(1);
		expect(h.err()).toBe(
			"error: Session old1 was saved on claude-code, and --model openai-codex/gpt-6-luna names another backend: a resumed session keeps its backend. Resume it without that --model, then choose openai-codex/gpt-6-luna in /model to move it there with a summary of the conversation.\n",
		);
		expect(stub.log.commands.map((command) => command.command)).not.toContain("session.resume");
	});

	it("shows a resumed session's answered questions in the same block, between the prompt and the turn's text", async () => {
		const h = harness([], { columns: 120 });
		const questions = [
			{
				id: "q1",
				question: "Which language should commit messages use?",
				options: [
					{ id: "en", label: "English", recommended: true },
					{ id: "es", label: "Spanish" },
				],
			},
		];
		const event = (seq: number, body: Record<string, unknown>) => ({
			type: "event",
			event: { seq, turnId: "t1", ...body },
		});
		const entries = [
			{ type: "prompt", turnId: "t1", text: "set up commits" },
			event(1, { type: "tool_call_started", callId: "u1", tool: "ask_user", input: { questions } }),
			event(2, { type: "user_question_requested", callId: "u1", questions }),
			event(3, {
				type: "user_question_resolved",
				callId: "u1",
				result: { status: "answered", answers: [{ questionId: "q1", optionId: "es" }] },
			}),
			event(4, {
				type: "tool_call_finished",
				callId: "u1",
				ok: true,
				summary: "User answered 1 question.",
				truncated: false,
			}),
			{ type: "text", turnId: "t1", text: "Commits in Spanish, then." },
		];
		const stub = stubCore({
			answer: (command) =>
				command.command === "sessions.list"
					? { sessions: [{ id: "old1", backend: "claude-code", resumable: true }] }
					: command.command === "session.resume"
						? { sessionId: "s1", entries }
						: { sessionId: "s1" },
		});
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--resume", "old1"], h.io, () => h.backend);
		await until(() => h.screen.screen().includes("Commits in Spanish"));
		const screen = h.screen.screen();
		expect(screen).toContain("● Answered 1 question");
		expect(screen).toContain("⎿ Which language should commit messages use?  → Spanish");
		expect(screen.indexOf("> set up commits")).toBeLessThan(screen.indexOf("Answered 1 question"));
		expect(screen.indexOf("Answered 1 question")).toBeLessThan(screen.indexOf("Commits in Spanish"));
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
		return { h, code, approvals, ask, dialog, emit: stub.emit };
	}

	it("offers to remember an approval's rules and sends the chosen one", async () => {
		const { h, code, approvals, dialog, emit } = await approvalCore();
		const remembering = (callId: string, always: boolean) =>
			emit({
				type: "approval_requested",
				callId,
				command: "ego-browser nodejs",
				reason: "a GUI app",
				remember: { rules: ["ego-browser nodejs"], always },
			});
		remembering("a1", true);
		await until(() => dialog().includes('Allow "ego-browser nodejs" always'));
		expect(dialog()).toContain('Allow "ego-browser nodejs" in this session');
		expect(dialog()).toContain("Deny");
		h.screen.type("\x1b[B");
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => approvals().length === 1);
		expect(approvals()[0]).toMatchObject({ callId: "a1", approved: true, remember: "always" });

		remembering("a2", false);
		await until(() => h.screen.screen().includes("in this session") && approvals().length === 1);
		await until(() => !dialog().includes('"ego-browser nodejs" always'));
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => approvals().length === 2);
		expect(approvals()[1]).toMatchObject({ callId: "a2", approved: true, remember: "session" });
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	describe("structured user questions", () => {
		const batch = [
			{
				id: "q1",
				question: "Which \x1b[31mdb?",
				options: [
					{ id: "a", label: "Postgres", description: "the \x1b[2Jbig one", recommended: true },
					{ id: "b", label: "SQLite" },
				],
			},
			{
				id: "q2",
				question: "Which cache?",
				options: [
					{ id: "c", label: "Redis" },
					{ id: "d", label: "None", recommended: true },
				],
			},
		];
		const askUser = (emit: (event: Record<string, unknown>) => void, callId = "u1") =>
			emit({ type: "user_question_requested", callId, questions: batch });

		it("opts in on start, lists the recommended option first and unselected, and sends a complete batch", async () => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			await until(() => h.screen.screen().includes("profile cheap"));
			expect(stub.log.commands.find((command) => command.command === "session.start")).toMatchObject({
				userQuestions: true,
			});
			const answers = () => stub.log.commands.filter((command) => command.command === "session.answer_user");
			askUser(stub.emit);
			await until(() => h.screen.screen().includes("○ Q1   ○ Q2"));
			const screen = h.screen.screen();
			expect(screen).toMatch(/1\. Postgres +Recommended/);
			expect(screen).toContain("3. Type something…");
			expect(screen).toContain("↑↓ move · 1-3 pick · enter select · esc cancel");
			expect(screen).not.toContain("(Recommended)");
			expect(screen).not.toContain("\x1b[31m");
			expect(screen).toContain("␛[31mdb?");
			expect(screen.indexOf("Postgres")).toBeLessThan(screen.indexOf("SQLite"));
			// Nothing is selected: Enter alone answers nothing; Down selects the first choice, the recommended one.
			h.screen.type("\r");
			expect(answers()).toHaveLength(0);
			h.screen.type("\x1b[B");
			h.screen.type("\x1b[B");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("✔ Q1"));
			expect(answers()).toHaveLength(0);
			// A number answers its row at once; 3, Type something, takes the text typed in place.
			h.screen.type("3");
			await until(() => h.screen.screen().includes("enter send · ↑↓ move · esc cancel"));
			h.screen.type("   ");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("Type an answer, or esc to cancel"));
			expect(answers()).toHaveLength(0);
			h.screen.type("my cache");
			h.screen.type("\r");
			// The review comes before anything is sent.
			await until(() => h.screen.screen().includes("Review your answers"));
			expect(answers()).toHaveLength(0);
			h.screen.type("1");
			await until(() => answers().length === 1);
			expect(answers()[0]).toMatchObject({
				callId: "u1",
				answers: [
					{ questionId: "q1", optionId: "b" },
					{ questionId: "q2", other: "   my cache" },
				],
			});
			// What the user answered stays in the conversation once the core settles the batch.
			stub.emit({
				type: "user_question_resolved",
				callId: "u1",
				result: { status: "answered", answers: answers()[0]?.answers },
			});
			await until(() => h.screen.screen().includes("Answered 2 questions"));
			expect(h.screen.screen()).toContain("→ SQLite");
			expect(h.screen.screen()).toContain("→ Type something: my cache");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("names the tabs by their headers, goes back with ← and sends the answer changed there", async () => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("profile cheap"));
			const answers = () => stub.log.commands.filter((command) => command.command === "session.answer_user");
			const [db, cache] = batch;
			stub.emit({
				type: "user_question_requested",
				callId: "u3",
				questions: [
					{ ...db, header: "Database" },
					{ ...cache, header: "Cache" },
				],
			});
			await until(() => h.screen.screen().includes("○ Database   ○ Cache"));
			h.screen.type("1");
			await until(() => h.screen.screen().includes("✔ Database"));
			h.screen.type("\x1b[D");
			h.screen.type("2");
			h.screen.type("1");
			await until(() => h.screen.screen().includes("Review your answers"));
			h.screen.type("\r");
			await until(() => answers().length === 1);
			expect(answers()[0]).toMatchObject({
				callId: "u3",
				answers: [
					{ questionId: "q1", optionId: "b" },
					{ questionId: "q2", optionId: "d" },
				],
			});
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("neutralizes Arabic Letter Mark in TUI questions, labels and descriptions", async () => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("profile cheap"));
			stub.emit({
				type: "user_question_requested",
				callId: "alm",
				questions: [
					{
						id: "q1",
						question: "Q\u061C?",
						options: [
							{ id: "a", label: "L\u061C", description: "D\u061C", recommended: true },
							{ id: "b", label: "Second" },
						],
					},
				],
			});
			await until(() => h.screen.screen().includes("Type something…"));
			try {
				expect(h.screen.screen()).not.toContain("\u061C");
				for (const text of ["Q⟨U+061C⟩?", "L⟨U+061C⟩", "D⟨U+061C⟩"]) expect(h.screen.screen()).toContain(text);
			} finally {
				h.screen.type("\x03");
				h.screen.type("\x03");
				expect(await code).toBe(130);
			}
		});

		it("shows the whole question, labels and descriptions at 80 columns, and Ctrl+O opens no card behind it", async () => {
			const h = harness([], { columns: 80 });
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(() => h.screen.screen().includes("profile cheap"));
			const question =
				"Before changing the existing production database and its backup strategy, should we keep all existing records?";
			const label = "Keep all existing production records and create a separate migration backup";
			const description =
				"Before making any change, confirm that every production record remains available and that the backup can be restored independently.";
			const questions = [
				{
					id: "wide",
					question,
					options: [
						{ id: "a", label, description, recommended: true },
						{ id: "b", label: "Drop the data" },
					],
				},
			];
			stub.emit({ type: "tool_call_started", callId: "wide", tool: "ask_user", input: { questions } });
			stub.emit({ type: "user_question_requested", callId: "wide", questions });
			await until(() => h.screen.screen().includes("Type something…"));
			// Each row is written on its own: the words of a wrapped text meet across rows with blanks between them.
			const content = () => h.screen.screen().replace(/\s+/g, " ");
			try {
				for (const text of [question, label, description])
					expect(content()).toContain(text.split(" ").slice(0, 4).join(" "));
				for (const word of [...question.split(" "), ...label.split(" "), ...description.split(" ")])
					expect(content()).toContain(word);
				expect(h.screen.screen()).not.toContain("Question 1 of 1");
				const before = h.screen.screen().length;
				h.screen.type("\x0f");
				h.screen.type("\x1b[B");
				await until(() => h.screen.screen().length > before);
				expect(h.screen.screen().slice(before)).not.toContain('"recommended"');
			} finally {
				h.screen.type("\x03");
				h.screen.type("\x03");
				expect(await code).toBe(130);
			}
		});

		it("answers with the source id of the option selected, even an id that is a sentinel", async () => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			await until(() => h.screen.screen().includes("profile cheap"));
			const answers = () => stub.log.commands.filter((command) => command.command === "session.answer_user");
			const sentinels = [
				{
					id: "q1",
					question: "Pick",
					options: [
						{ id: "\0", label: "Zero", description: "first detail", recommended: true },
						{ id: "\0other", label: "Zero other" },
					],
				},
			];
			stub.emit({ type: "user_question_requested", callId: "u9", questions: sentinels });
			await until(() => h.screen.screen().includes("first detail"));
			h.screen.type("\x1b[B");
			h.screen.type("\r");
			await until(() => answers().length === 1);
			expect(answers()[0]).toMatchObject({ answers: [{ questionId: "q1", optionId: "\0" }] });
			stub.emit({ type: "user_question_resolved", callId: "u9", result: { status: "superseded" } });
			stub.emit({
				type: "user_question_requested",
				callId: "u10",
				questions: [{ ...sentinels[0], question: "Pick again" }],
			});
			await until(() => h.screen.screen().includes("Pick again"));
			h.screen.type("2");
			await until(() => answers().length === 2);
			expect(answers()[1]).toMatchObject({ answers: [{ questionId: "q1", optionId: "\0other" }] });
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("sends null when cancelled, and nothing when the core resolved it first", async () => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			await until(() => h.screen.screen().includes("profile cheap"));
			const answers = () => stub.log.commands.filter((command) => command.command === "session.answer_user");
			askUser(stub.emit);
			await until(() => h.screen.screen().includes("○ Q1   ○ Q2"));
			h.screen.type("\x1b");
			await until(() => answers().length === 1);
			expect(answers()[0]).toMatchObject({ callId: "u1", answers: null });
			stub.emit({ type: "user_question_resolved", callId: "u1", result: { status: "cancelled", reason: "user" } });
			// Resolved by the core while the user types an answer and an approval waits behind it.
			askUser(stub.emit, "u2");
			stub.emit({ type: "approval_requested", tool: "bash", callId: "a1", command: "echo hi" });
			await until(() => h.screen.screen().includes("○ Q1   ○ Q2"));
			h.screen.type("\x1b[A");
			h.screen.type("half typed");
			await until(() => h.screen.screen().includes("half typed"));
			stub.emit({ type: "user_question_resolved", callId: "u2", result: { status: "superseded" } });
			await until(() => h.screen.screen().includes("Run this command?"));
			// Keys go to the approval left behind, not to the closed question.
			h.screen.type("\x1b[B");
			h.screen.type("\r");
			await until(() => stub.log.commands.some((command) => command.command === "session.approve"));
			expect(answers()).toHaveLength(1);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});
	});

	it("offers Allow always in this project when the question offers it, and sends project", async () => {
		const { h, code, approvals, dialog, emit } = await approvalCore();
		emit({
			type: "approval_requested",
			callId: "a1",
			command: "pnpm install",
			reason: "needs the network",
			remember: { rules: ["pnpm install"], always: false, project: "/Users/ana/code/app" },
		});
		await until(() => dialog().includes('Allow "pnpm install" always in this project'));
		h.screen.type("\x1b[B");
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => approvals().length === 1);
		expect(approvals()[0]).toMatchObject({ callId: "a1", approved: true, remember: "project" });
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("lists a project rule with its project and an old rule that is not used", async () => {
		const h = harness([]);
		const rules = [
			{ id: "project:bash:make", scope: "project", kind: "bash", value: "make", project: "/Users/ana/code/app" },
			{ id: "always:bash:npm install", scope: "always", kind: "bash", value: "npm install", ignored: true },
		];
		const stub = stubCore({
			answer: (command) => (command.command === "session.permissions" ? { rules } : undefined),
		});
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/permissions");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("1. project bash  make  (in /Users/ana/code/app)"));
		expect(h.screen.screen()).toContain("2. always  bash  npm install  (not used: allow it in a project instead)");
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("lists the permission rules with /permissions and removes one", async () => {
		const h = harness([]);
		const rule = { id: "always:bash:open", scope: "always", kind: "bash", value: "open" };
		const stub = stubCore({
			answer: (command) =>
				command.command === "session.permissions"
					? { rules: [rule] }
					: command.command === "session.permissions_remove"
						? { rules: [] }
						: undefined,
		});
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/permissions");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("1. always  bash  open"));
		h.screen.type("/permissions remove 1");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("removed: always bash open"));
		expect(stub.log.commands).toContainEqual({
			command: "session.permissions_remove",
			sessionId: "s1",
			ruleId: "always:bash:open",
		});
		h.screen.type("/permissions remove 9");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("error: no rule 9"));
		h.screen.type("/permissions x");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("usage: /permissions | /permissions remove <number>"));
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

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

	it("ignores the keys typed just as a review consent appears", async () => {
		const h = harness([]);
		const stub = listingCore();
		h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 300 };
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		await until(() => h.screen.screen().includes("profile cheap"));
		const answers = () => stub.log.commands.filter((command) => command.command === "session.review_consent");
		stub.emit({
			type: "review_consent_requested",
			reviewId: "r1",
			level: "high",
			reasons: ["shell_process: a.ts:1"],
			lenses: ["risk"],
		});
		await until(() => h.screen.screen().includes("Review this high-risk change?"));
		const shownAt = Date.now();
		h.screen.type("\r");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(answers()).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 300 - (Date.now() - shownAt))));
		h.screen.type("\r");
		await until(() => answers().length === 1);
		expect(answers()[0]).toMatchObject({ reviewId: "r1", answer: "granted" });
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	/** Each kind of question, opened while no turn runs, and what the core receives when it is answered or closed. */
	const questionKinds: {
		name: string;
		title: string;
		open: (type: (keys: string) => void, emit: (event: Record<string, unknown>) => void) => void;
		/** What is typed before Enter answers it; a list with a search line takes it as the search. */
		typed?: string;
		/** True once Enter answered it, on its first answer. */
		answered: (sent: (name: string) => ClientCommand[], screen: string) => boolean;
		/** True once Ctrl+C or Ctrl+D closed it `times` times, as Esc would; the TUI's own lists send nothing. */
		closed?: (sent: (name: string) => ClientCommand[], times: number) => boolean;
	}[] = [
		{
			name: "/model's list",
			title: "Select a model",
			typed: "opus",
			open: (type) => type("/model"),
			answered: (_sent, screen) => screen.includes("model: opus (unchanged)"),
		},
		{
			name: "/resume's list",
			title: "Resume a session",
			open: (type) => type("/resume"),
			answered: (sent) => sent("session.resume").length === 1,
		},
		{
			name: "the review consent",
			title: "Review this high-risk change?",
			open: (_type, emit) =>
				emit({ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: [], lenses: ["risk"] }),
			answered: (sent) =>
				sent("session.review_consent").some((command) => "answer" in command && command.answer === "granted"),
			closed: (sent, times) =>
				sent("session.review_consent").filter((command) => "answer" in command && command.answer === "declined")
					.length === times,
		},
		{
			name: "an approval",
			title: "Run this command?",
			open: (_type, emit) => emit({ type: "approval_requested", tool: "bash", callId: "a1", command: "echo hi" }),
			answered: (sent) => sent("session.approve").some((command) => "approved" in command && command.approved),
			closed: (sent, times) =>
				sent("session.approve").filter((command) => "approved" in command && !command.approved).length === times,
		},
	];

	it.each(questionKinds)(
		"gives every key to $name with no turn running, and Ctrl+C or Ctrl+D close it as Esc does",
		async (kind) => {
			const h = harness([]);
			const stub = listingCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, answerGuardMs: 0 };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			await until(() => h.screen.screen().includes("profile cheap"));
			const sent = (name: string) => stub.log.commands.filter((command) => command.command === name);
			const since = (mark: number) => plain(h.screen.raw().slice(mark));
			/** Opens the question with `draft` in the editor: a list's command is sent first, and the draft typed as it loads. */
			const open = async (draft: string) => {
				const mark = h.screen.raw().length;
				const local = kind.closed === undefined;
				if (local) {
					kind.open(h.screen.type, stub.emit);
					h.screen.type("\r");
				}
				if (draft !== "") h.screen.type(draft);
				if (!local) kind.open(h.screen.type, stub.emit);
				await until(() => since(mark).includes(kind.title));
				return h.screen.raw().length;
			};

			// Typing and Enter answer it, queue nothing, and the draft comes back without what was typed.
			let shown = await open("draft");
			const typed = kind.typed ?? "xyz";
			h.screen.type(typed);
			h.screen.type("\r");
			await until(() => kind.answered(sent, h.screen.screen()));
			await until(() => since(shown).includes("draft"));
			expect(since(shown)).not.toContain(`draft${typed}`);
			expect(sent("session.queue")).toEqual([]);
			expect(sent("session.send")).toEqual([]);
			// Ctrl+C with no question clears the editor.
			h.screen.type("\x03");

			// Ctrl+C closes it and leaves the draft alone.
			shown = await open("draft");
			h.screen.type("\x03");
			await until(() => since(shown).includes("draft"));
			if (kind.closed) await until(() => kind.closed?.(sent, 1) === true);
			h.screen.type("\x03");

			// Ctrl+D with an empty editor closes it and does not quit: the editor takes the next keys.
			shown = await open("");
			h.screen.type("\x04");
			if (kind.closed) await until(() => kind.closed?.(sent, 2) === true);
			h.screen.type("later");
			await until(() => since(shown).includes("later"));
			expect(sent("session.send")).toEqual([]);
			h.screen.type("\x03");
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
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("shows a command's first line with text when it starts with blank lines", async () => {
		const { h, code, ask, dialog } = await approvalCore();
		ask("\n\necho concealed");
		await until(() => dialog().includes("Run this command?"));
		expect(dialog()).toContain("echo concealed … 2 more lines (Ctrl+O)");
		h.screen.type("\x03");
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

		/** A TUI on a core the test drives, the OSC 7501 live line held back `statusIntervalMs` between changes. */
		const stubbed = (statusIntervalMs = 0) => {
			const h = harness([]);
			const stub = stubCore();
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link, statusIntervalMs } as typeof h.io.tui;
			return { h, stub, code: run(["--no-session"], h.io, () => h.backend) };
		};
		const callStarted = (callId: string, tool: string, input: Record<string, unknown>) => ({
			type: "tool_call_started",
			callId,
			tool,
			input,
		});
		const callFinished = (callId: string) => ({
			type: "tool_call_finished",
			callId,
			ok: true,
			summary: "done",
			truncated: false,
		});
		const taskInProgress = (id: string, title: string) => ({
			type: "feature_changed",
			name: "row",
			path: "odd/tasks/row.md",
			title: "Row",
			tasks: [{ id, title, specs: [], status: "in_progress" }],
		});

		it("reports idle, working, blocked on an approval, working and done, and clears on exit", async () => {
			const h = harness([
				[
					{ event: { type: "text_delta", text: "Looking first." } },
					{ toolCall: { tool: "bash", input: { command: "echo first" } } },
					{ event: { type: "text_delta", text: "\n\nAll done: it passes.\nThe rest." } },
					{ event: finished },
				],
			]);
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
				atelier("working", { message: "bash echo first" }),
				atelier("blocked", { kind: "permission", message: "Run this command?" }),
				atelier("working", { message: "bash echo first" }),
				atelier("working"),
				atelier("done", { message: "All done: it passes." }),
				atelier("clear"),
			]);
			expect(h.screen.titles).toEqual([`Atelier - ${basename(cwd)}`, `Atelier - one - ${basename(cwd)}`]);
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
			expect(h.screen.statuses).toEqual([
				atelier("idle"),
				atelier("working"),
				atelier("idle", { message: "interrupted" }),
			]);
			h.screen.type("again");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 5);
			expect(h.screen.statuses.slice(3)).toEqual([atelier("working"), atelier("error", { message: "boom" })]);
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
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("reports the call running, else the task in progress, while working, each line once", async () => {
			const { h, stub, code } = stubbed();
			await until(h.screen.started);
			h.screen.type("go");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 2);
			stub.emit(taskInProgress("T2", "Hot profile"));
			// The main agent's text leaves the line as it is, and so do a subagent's calls; only the last text is told.
			stub.emit({ type: "text_delta", text: "First a look." });
			stub.emit(callStarted("c1", "edit", { path: "src/app.ts" }));
			stub.emit({ ...callStarted("c2", "read", { path: "b.ts" }), parentCallId: "c1" });
			stub.emit(callFinished("c1"));
			stub.emit({ type: "text_delta", text: "‮See\u001b[31m it " });
			stub.emit({ type: "text_delta", text: "x".repeat(300) });
			stub.emit({ type: "turn_finished", stopReason: "end_turn", usage });
			await until(() => h.screen.statuses.at(-1)?.state === "done");
			expect(h.screen.statuses).toEqual([
				atelier("idle"),
				atelier("working"),
				atelier("working", { message: "T2 Hot profile" }),
				atelier("working", { message: "edit src/app.ts" }),
				atelier("working", { message: "T2 Hot profile" }),
				// One line, without control or bidi characters, cut to 200 characters.
				atelier("done", { message: `See [31m it ${"x".repeat(187)}…` }),
			]);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("keeps reporting an earlier main call that still runs when a later one ends", async () => {
			const { h, stub, code } = stubbed();
			await until(h.screen.started);
			h.screen.type("go");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 2);
			stub.emit(callStarted("a", "bash", { command: "pnpm test" }));
			stub.emit(callStarted("b", "read", { path: "file.ts" }));
			await until(() => h.screen.statuses.at(-1)?.message === "read file.ts");
			stub.emit(callFinished("b"));
			await until(() => h.screen.statuses.length === 5);
			expect(h.screen.statuses.at(-1)).toEqual(atelier("working", { message: "bash pnpm test" }));
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("names a memory call as the transcript does", async () => {
			const { h, stub, code } = stubbed();
			await until(h.screen.started);
			h.screen.type("go");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 2);
			stub.emit(callStarted("a", "memory", { action: "search", query: "footer" }));
			await until(() => h.screen.statuses.length === 3);
			expect(h.screen.statuses.at(-1)).toEqual(atelier("working", { message: 'memory search "footer"' }));
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("reports at done the agent's last text even when a call came after it", async () => {
			const { h, stub, code } = stubbed();
			await until(h.screen.started);
			h.screen.type("go");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 2);
			stub.emit({ type: "text_delta", text: "Reading the config." });
			stub.emit(callStarted("c1", "read", { path: "a.ts" }));
			stub.emit(callFinished("c1"));
			stub.emit({ type: "text_delta", text: "\n\n" });
			stub.emit({ type: "turn_finished", stopReason: "end_turn", usage });
			await until(() => h.screen.statuses.at(-1)?.state === "done");
			expect(h.screen.statuses.at(-1)).toEqual(atelier("done", { message: "Reading the config." }));
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("reports a blocked question without control or bidi characters", async () => {
			const { h, stub, code } = stubbed();
			await until(h.screen.started);
			stub.emit({ type: "approval_requested", callId: "c1", command: "echo hi", confirm: "ru؜le\x1b]0;x\x07" });
			await until(() => h.screen.statuses.at(-1)?.state === "blocked");
			expect(h.screen.statuses.at(-1)).toEqual(
				atelier("blocked", { kind: "permission", message: "Run this command? (guard: ru⟨U+061C⟩le␛]0;x⟨U+0007⟩)" }),
			);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		// What a held line does once its time has passed after done or clear is driven in tui-program-status.test.ts.
		it("holds back the live line between changes, and sends the newest when its time comes", async () => {
			const { h, stub, code } = stubbed(100);
			await until(h.screen.started);
			h.screen.type("go");
			h.screen.type("\r");
			await until(() => h.screen.statuses.length === 2);
			// Held while the interval runs: only the newest goes when it ends.
			for (const id of ["c2", "c3"]) {
				stub.emit(callStarted(id, "bash", { command: `echo ${id}` }));
				stub.emit(callFinished(id));
			}
			stub.emit(callStarted("c4", "bash", { command: "echo c4" }));
			await until(() => h.screen.statuses.length === 3);
			expect(h.screen.statuses).toEqual([
				atelier("idle"),
				atelier("working"),
				atelier("working", { message: "bash echo c4" }),
			]);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("titles the terminal without control or bidi characters, cut to 50 characters", async () => {
			const h = harness([]);
			const stub = stubCore({
				answer: (command) => {
					if (command.command !== "session.resume") return undefined;
					// A saved prompt and a name set elsewhere, such as in the desktop, come back as they were written.
					return command.sessionId === "abc"
						? { sessionId: "s2", entries: [{ type: "prompt", turnId: "t", text: "saved\x1b]0;evil\x07 run" }] }
						: { sessionId: "s3", name: "named\x1b]2;x\x07 \u202eit", entries: [] };
				},
			});
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const folder = basename(cwd);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			// The editor keeps ESC and BEL out of what is typed; a saved prompt or name brings them back below.
			h.screen.type(`\u202efix ${"y".repeat(80)}`);
			h.screen.type("\r");
			await until(() => h.screen.titles.length === 2);
			expect(h.screen.titles[1]).toBe(`Atelier - fix ${"y".repeat(45)}… - ${folder}`);
			stub.emit({ type: "turn_finished", stopReason: "end_turn", usage });
			await until(() => h.screen.screen().includes("◇ done"));
			h.screen.type("/rename Mine");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("this session is not saved"));
			for (const id of ["abc", "def"]) {
				h.screen.type(`/resume ${id}`);
				h.screen.type("\r");
				await until(() => h.screen.titles.length === (id === "abc" ? 3 : 4));
			}
			expect(h.screen.titles.slice(2)).toEqual([
				`Atelier - saved ]0;evil run - ${folder}`,
				`Atelier - named ]2;x it - ${folder}`,
			]);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must not be there
			expect(h.screen.titles.join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("does not title the session with a slash command sent as a prompt", async () => {
			const { h, code } = stubbed();
			await until(h.screen.started);
			h.screen.type("/help");
			h.screen.type("\r");
			await until(() => h.screen.statuses.at(-1)?.state === "working");
			expect(h.screen.titles).toEqual([`Atelier - ${basename(cwd)}`]);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("titles the session with a first prompt that enters through the queue", async () => {
			const { h, stub, code } = stubbed();
			await until(h.screen.started);
			h.screen.type("/review");
			h.screen.type("\r");
			await until(() => h.screen.statuses.at(-1)?.state === "working");
			await until(() => h.screen.screen().includes("working…"));
			h.screen.type("first queued prompt");
			h.screen.type("\r");
			await until(() => stub.log.commands.some((command) => command.command === "session.queue"));
			stub.emit({ type: "turn_finished", stopReason: "end_turn", usage });
			stub.emit({ type: "queued_message", seq: 1, kind: "steer", text: "first queued prompt" });
			await until(() => h.screen.titles.length === 2);
			expect(h.screen.titles.at(-1)).toBe(`Atelier - first queued prompt - ${basename(cwd)}`);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("skips the saved slash commands for the title of a resumed session", async () => {
			const h = harness([]);
			const stub = stubCore({
				answer: (command) =>
					command.command === "session.resume"
						? {
								sessionId: "s2",
								entries: [
									{ type: "prompt", turnId: "t1", text: "/help" },
									{ type: "prompt", turnId: "t2", text: "real task" },
								],
							}
						: undefined,
			});
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("/resume abc");
			h.screen.type("\r");
			await until(() => h.screen.titles.length === 2);
			expect(h.screen.titles.at(-1)).toBe(`Atelier - real task - ${basename(cwd)}`);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("titles a resumed session with a saved queued message that came before its first prompt", async () => {
			const h = harness([]);
			const queued = { type: "queued_message", seq: 1, turnId: "t1", kind: "steer", text: "first queued prompt" };
			const stub = stubCore({
				answer: (command) =>
					command.command === "session.resume"
						? {
								sessionId: "s2",
								entries: [
									{ type: "prompt", turnId: "t1", text: "/review" },
									{ type: "event", event: queued },
									{ type: "prompt", turnId: "t2", text: "later" },
								],
							}
						: undefined,
			});
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("/resume abc");
			h.screen.type("\r");
			await until(() => h.screen.titles.length === 2);
			expect(h.screen.titles.at(-1)).toBe(`Atelier - first queued prompt - ${basename(cwd)}`);
			h.screen.type("\x03");
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
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});
	});

	describe("notifications", () => {
		const settle = async (notifications: Record<string, unknown>) => {
			await mkdir(join(home, ".atelier"), { recursive: true });
			await writeFile(
				join(home, ".atelier", "settings.json"),
				JSON.stringify({ kind: "atelier.settings", version: 1, tui: { notifications } }),
			);
		};
		/** The OSC 9 notifications written, without OSC 9;4 progress. */
		const notices = (raw: string) =>
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the notification's sequence is what is read
			[...raw.matchAll(/\x1b\]9;([^\x07]*)\x07/g)].map((match) => match[1]).filter((text) => !text?.startsWith("4;"));
		/** Bells on their own, not the ones that end an OSC sequence. */
		const bells = (raw: string) =>
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the sequences are what is taken out
			raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").split("\x07").length - 1;
		const inGhostty = (h: ReturnType<typeof harness>, env: Record<string, string> = {}) => {
			h.io = { ...h.io, env: { TERM_PROGRAM: "ghostty", ...env } } as typeof h.io;
		};
		const title = () => `Atelier · ${basename(cwd)}`;

		it("tells the terminal when the session waits for an approval and when the turn ends, once each", async () => {
			await settle({ minSeconds: 0 });
			const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo secret" } } }, { event: finished }]]);
			inGhostty(h);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => notices(h.screen.raw()).length === 1);
			expect(notices(h.screen.raw())).toEqual([`${title()}: Waiting for approval`]);
			h.screen.type("\r");
			await until(() => notices(h.screen.raw()).length === 2);
			expect(notices(h.screen.raw())).toEqual([`${title()}: Waiting for approval`, `${title()}: Turn finished`]);
			expect(h.screen.raw()).not.toContain("secret:");
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
		});

		it("says nothing of a turn shorter than ten seconds by default", async () => {
			const h = harness([[{ event: finished }]]);
			inGhostty(h);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			expect(notices(h.screen.raw())).toEqual([]);
		});

		it("says a failed turn, and nothing of an interrupted one", async () => {
			await settle({ minSeconds: 0 });
			const h = harness([
				[{ event: { type: "text_delta", text: "working" } }, { waitForInterrupt: true }],
				[{ throw: "boom" }],
			]);
			inGhostty(h);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("long job");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("working"));
			h.screen.type("\x1b");
			await until(() => h.screen.screen().includes("interrupted"));
			h.screen.type("again");
			h.screen.type("\r");
			await until(() => notices(h.screen.raw()).length === 1);
			expect(notices(h.screen.raw())).toEqual([`${title()}: Turn failed`]);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("says nothing while the terminal has the focus, and keeps its reports out of the editor", async () => {
			await settle({ minSeconds: 0 });
			const h = harness([[{ event: finished }], [{ event: finished }]]);
			inGhostty(h);
			const code = run(["--no-session", "--no-fullscreen"], h.io, () => h.backend);
			await until(h.screen.started);
			expect(h.screen.raw()).toContain("\x1b[?1004h");
			h.screen.type("\x1b[I");
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			expect(notices(h.screen.raw())).toEqual([]);
			h.screen.type("\x1b[O");
			h.screen.type("two");
			h.screen.type("\r");
			await until(() => notices(h.screen.raw()).length === 1);
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			expect(h.backend.prompts).toEqual(["one", "two"]);
			expect(h.screen.raw()).toContain("\x1b[?1004l");
		});

		it("keeps focus reports out of the editor and of a question full screen, alone or among other keys", async () => {
			await settle({ minSeconds: 0 });
			const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo first" } } }, { event: finished }]]);
			inGhostty(h);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("\x1b[I");
			h.screen.type("o\x1b[On\x1b[Ie");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("Run this command?"));
			// An Esc reaching the question would deny the command.
			h.screen.type("\x1b[O");
			h.screen.type("\x1b[I\x1b[O");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			expect(h.backend.prompts).toEqual(["one"]);
			expect(h.core.commands).toContainEqual(expect.objectContaining({ command: "session.approve", approved: true }));
		});

		it("gives the terminal back even when turning its focus reports off fails", async () => {
			const h = harness([]);
			inGhostty(h);
			const write = h.screen.terminal.write;
			h.screen.terminal.write = (data) => {
				// Only the TUI's own write: pi-tui's full screen turns them off among its own sequences.
				if (data === "\x1b[?1004l") throw new Error("the terminal went away");
				write(data);
			};
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			expect(h.screen.stopped()).toBe(true);
		});

		it("tells a turn that stopped for a reason other than an error as finished", async () => {
			await settle({ minSeconds: 0 });
			const h = harness([[{ event: { ...finished, stopReason: "max_tokens" } }]]);
			inGhostty(h);
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => notices(h.screen.raw()).length === 1);
			expect(notices(h.screen.raw())).toEqual([`${title()}: Turn finished`]);
			h.screen.type("\x03");
			expect(await code).toBe(130);
		});

		it("leaves the notices to Herdr, and rings the bell for Orca", async () => {
			await settle({ minSeconds: 0 });
			for (const [env, rung] of [
				[{ HERDR_ENV: "1" }, 0],
				[{ ORCA_PANE_KEY: "tab:1" }, 1],
			] as const) {
				const h = harness([[{ event: finished }]]);
				inGhostty(h, env);
				const code = run(["--no-session"], h.io, () => h.backend);
				await until(h.screen.started);
				h.screen.type("one");
				h.screen.type("\r");
				await until(() => h.screen.screen().includes("$0.50"));
				await until(() => bells(h.screen.raw()) === rung);
				h.screen.type("/exit");
				h.screen.type("\r");
				expect(await code).toBe(0);
				expect(notices(h.screen.raw())).toEqual([]);
				expect(bells(h.screen.raw())).toBe(rung);
			}
		});

		it("starts the system's notification with a sound when asked, and nothing when off", async () => {
			for (const [notifications, expected] of [
				[{ minSeconds: 0, via: "system", sound: true }, 1],
				[{ minSeconds: 0, enabled: false }, 0],
			] as const) {
				await settle(notifications);
				const spawned: string[][] = [];
				const h = harness([[{ event: finished }]]);
				inGhostty(h);
				const spawn = (command: string, args: string[]) => {
					spawned.push([command, ...args]);
				};
				h.io.tui = { ...h.io.tui, ...({ platform: "darwin", spawn } as object) };
				const code = run(["--no-session"], h.io, () => h.backend);
				await until(h.screen.started);
				h.screen.type("one");
				h.screen.type("\r");
				await until(() => h.screen.screen().includes("$0.50"));
				await until(() => spawned.length === expected);
				h.screen.type("/exit");
				h.screen.type("\r");
				expect(await code).toBe(0);
				expect(notices(h.screen.raw())).toEqual([]);
				if (expected === 0) expect(spawned).toEqual([]);
				else {
					expect(spawned[0]?.[0]).toBe("osascript");
					expect(spawned[0]?.join(" ")).toContain('sound name "Glass"');
					expect(spawned[0]?.slice(-2)).toEqual([title(), "Turn finished"]);
				}
			}
		});
	});

	describe("herdr", () => {
		interface HerdrCall {
			id: string;
			method: string;
			params: Record<string, unknown>;
		}

		/**
		 * A Herdr socket that keeps every request; `hold` keeps the replies back until `answer` sends them. As Herdr does, it
		 * refuses a `resume_argv` from a source that does not hold the pane, that is, has not reported a state yet.
		 */
		// A socket's path holds at most 104 bytes on macOS: the tests run in their folder and name the socket relative to it,
		// so a long temporary directory does not keep the fake Herdr from listening.
		let previousDir: string;
		beforeEach(() => {
			previousDir = process.cwd();
			process.chdir(cwd);
		});
		afterEach(() => {
			process.chdir(previousDir);
		});

		async function fakeHerdr(options: { hold?: boolean } = {}) {
			const path = "herdr.sock";
			const calls: HerdrCall[] = [];
			const refused: HerdrCall[] = [];
			const holders = new Set<unknown>();
			const held: (() => void)[] = [];
			const sockets = new Set<Socket>();
			const server = createServer((socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
				let buffered = "";
				socket.on("data", (chunk) => {
					buffered += chunk.toString();
					const lines = buffered.split("\n");
					buffered = lines.pop() ?? "";
					for (const line of lines) {
						const call = JSON.parse(line) as HerdrCall;
						calls.push(call);
						const { source } = call.params;
						if (call.method === "pane.report_agent") holders.add(source);
						if (call.method === "pane.release_agent") holders.delete(source);
						const refuse = call.params.resume_argv !== undefined && !holders.has(source);
						if (refuse) refused.push(call);
						const answered = refuse
							? {
									id: call.id,
									error: {
										message:
											"resume_argv requires the reporter to hold the pane; report its state with pane.report_agent first",
									},
								}
							: { id: call.id, result: {} };
						const reply = () => socket.end(`${JSON.stringify(answered)}\n`);
						if (options.hold) held.push(reply);
						else reply();
					}
				});
			});
			await new Promise<void>((resolve) => server.listen(path, resolve));
			const close = () =>
				new Promise<void>((resolve) => {
					for (const socket of sockets) socket.destroy();
					server.close(() => resolve());
				});
			const answer = () => {
				for (const reply of held.splice(0)) reply();
			};
			return { path, calls, refused, close, answer };
		}

		const herdrEnv = (socket: string) => ({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socket });
		/** What a call says, without what every call carries. */
		const said = ({ method, params }: HerdrCall): Record<string, unknown> => {
			const { pane_id: _pane, source: _source, agent: _agent, seq: _seq, ...rest } = params;
			return { method, ...rest };
		};

		it("reports the session, its states and the release to the pane, with a growing seq", async () => {
			const herdr = await fakeHerdr();
			const h = harness([[{ toolCall: { tool: "bash", input: { command: "echo secret" } } }, { event: finished }]]);
			h.io = { ...h.io, env: herdrEnv(herdr.path) } as typeof h.io;
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			await until(() => herdr.calls.some((call) => call.params.state === "idle"));
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("Run this command?"));
			await until(() => herdr.calls.some((call) => call.params.state === "blocked"));
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/new");
			h.screen.type("\r");
			await until(() => herdr.calls.filter((call) => call.method === "pane.report_agent_session").length === 2);
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			await herdr.close();

			const [first, second] = h.core.commands
				.filter((command) => command.command === "session.close")
				.map((command) => (command as { sessionId: string }).sessionId);
			// A state that a newer one replaces before Herdr answers the one in flight is never sent: a working may be missing.
			const reported = herdr.calls.map(said).filter((call) => call.state !== "working");
			const states = herdr.calls.map((call) => call.params.state).filter((state) => state !== undefined);
			expect(states.filter((state, at) => state === states[at - 1])).toEqual([]);
			expect(reported).toEqual([
				{ method: "pane.report_agent", state: "idle" },
				{ method: "pane.report_agent_session", agent_session_id: first },
				{ method: "pane.report_agent", state: "blocked", message: "Approval awaiting input" },
				{ method: "pane.report_agent", state: "idle" },
				{ method: "pane.report_agent_session", agent_session_id: second },
				{ method: "pane.release_agent" },
			]);
			for (const call of herdr.calls)
				expect(call.params).toMatchObject({ pane_id: "w1:p1", source: "atelier", agent: "atelier" });
			const seqs = herdr.calls.map((call) => call.params.seq as number);
			expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
			expect(new Set(seqs).size).toBe(seqs.length);
			expect(JSON.stringify(herdr.calls)).not.toContain("secret");
			// A nested Atelier started by a tool finds the pane taken.
			expect(h.core.envs).toEqual([{ ATELIER_HERDR_PANE: "w1:p1" }]);
			expect(h.err()).toBe("");
		});

		it("gives a saved session the command that resumes it, again after a move to another provider", async () => {
			const herdr = await fakeHerdr();
			const h = harness([]);
			const stub = listingCore();
			h.io = { ...h.io, env: herdrEnv(herdr.path) } as typeof h.io;
			h.io.tui = {
				terminal: h.screen.terminal,
				connect: async () => ({
					...stub.link,
					request: async (command) => {
						const answer = (await stub.link.request(command)) as Record<string, unknown>;
						return command.command === "session.start" ? { ...answer, savedId: "saved-1" } : answer;
					},
				}),
			};
			const code = run([], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("/model openai-codex/gpt-luna");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("Move this session to openai-codex?"));
			h.screen.type("\x1b[A");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("with a summary of the conversation"));
			const sessions = () => herdr.calls.filter((call) => call.method === "pane.report_agent_session");
			await until(() => sessions().length === 2);
			for (const call of sessions())
				expect(said(call)).toEqual({
					method: "pane.report_agent_session",
					agent_session_id: "saved-1",
					resume_argv: ["atelier", "--resume", "saved-1"],
				});
			h.screen.type("\x04");
			expect(await code).toBe(0);
			await herdr.close();
			// The first request makes Atelier hold the pane, so Herdr takes the resume command at start too.
			expect(herdr.calls[0]).toMatchObject({ method: "pane.report_agent", params: { state: "idle" } });
			expect(herdr.refused).toEqual([]);
		});

		it("reports a review consent as blocked with a generic message", async () => {
			const herdr = await fakeHerdr();
			const h = harness([]);
			const stub = stubCore();
			h.io = { ...h.io, env: herdrEnv(herdr.path) } as typeof h.io;
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			stub.emit({ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: [], lenses: [] });
			await until(() => herdr.calls.some((call) => call.params.state === "blocked"));
			expect(said(herdr.calls.at(-1) as HerdrCall)).toEqual({
				method: "pane.report_agent",
				state: "blocked",
				message: "Review consent awaiting input",
			});
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
			await herdr.close();
		});

		it.each([
			["outside Herdr", { HERDR_ENV: undefined }],
			["without a pane", { HERDR_PANE_ID: " " }],
			["inside an Atelier that already reports the pane", { ATELIER_HERDR_PANE: "w1:p1" }],
		])("reports nothing %s", async (_name, change) => {
			const herdr = await fakeHerdr();
			const h = harness([[{ event: finished }]]);
			h.io = { ...h.io, env: { ...herdrEnv(herdr.path), ...change } } as typeof h.io;
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			await herdr.close();
			expect(herdr.calls).toEqual([]);
			expect(h.core.envs).toEqual([{}]);
		});

		it("reports nothing when the socket path is not a socket", async () => {
			const path = join(cwd, "not-a-socket");
			await writeFile(path, "");
			const h = harness([]);
			h.io = { ...h.io, env: herdrEnv(path) } as typeof h.io;
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			h.screen.type("\x04");
			expect(await code).toBe(0);
			expect(h.core.envs).toEqual([{}]);
		});

		it("runs and exits as usual when the socket goes away", async () => {
			const herdr = await fakeHerdr();
			const h = harness([[{ event: finished }]]);
			h.io = { ...h.io, env: herdrEnv(herdr.path) } as typeof h.io;
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			await until(() => herdr.calls.length === 2);
			await herdr.close();
			h.screen.type("one");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("$0.50"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
			expect(h.err()).toBe("");
			expect(h.screen.screen()).not.toMatch(/herdr|ENOENT|ECONNREFUSED/i);
		});

		it("sends only the newest state while one is in flight, and never one Herdr already has", async () => {
			const herdr = await fakeHerdr({ hold: true });
			const reporter = HerdrStatusReporter.fromEnv(herdrEnv(herdr.path));
			reporter?.report("working");
			await until(() => herdr.calls.length === 1);
			reporter?.report("idle");
			reporter?.report("working");
			reporter?.report("blocked", { kind: "permission", message: "Run this command?" });
			herdr.answer();
			await until(() => herdr.calls.length === 2);
			reporter?.report("idle");
			reporter?.report("blocked", { kind: "permission", message: "Run this command?" });
			herdr.answer();
			const released = reporter?.release();
			await until(() => herdr.calls.length === 3);
			herdr.answer();
			await released;
			await herdr.close();
			expect(herdr.calls.map(said)).toEqual([
				{ method: "pane.report_agent", state: "working" },
				{ method: "pane.report_agent", state: "blocked", message: "Approval awaiting input" },
				{ method: "pane.release_agent" },
			]);
		});

		const featureChanged = (tasks: { id: string; title: string; status: string }[]) => ({
			type: "feature_changed",
			name: "herdr",
			path: "odd/tasks/herdr.md",
			title: "Herdr",
			tasks,
		});
		const cleared = { tokens: { summary: null, summary2: null } };

		it("shows the task in progress in the sidebar while a turn runs, cut to the sidebar's width", async () => {
			const herdr = await fakeHerdr();
			await writeFile(join(cwd, "session.json"), JSON.stringify({ sidebar_width: 30 }));
			const h = harness([]);
			const stub = stubCore();
			h.io = { ...h.io, env: herdrEnv(herdr.path) } as typeof h.io;
			h.io.tui = { terminal: h.screen.terminal, connect: async () => stub.link };
			const code = run(["--no-session"], h.io, () => h.backend);
			await until(h.screen.started);
			const metadata = () => herdr.calls.filter((call) => call.method === "pane.report_metadata");
			const long = "Show\nthe active‮ task in Herdr's\x07 sidebar, cut to its width";
			stub.emit(featureChanged([{ id: "T2", title: long, status: "in_progress" }]));
			h.screen.type("go");
			h.screen.type("\r");
			await until(() => metadata().length === 1);
			stub.emit(featureChanged([{ id: "T2", title: long, status: "done" }]));
			await until(() => metadata().length === 2);
			stub.emit(featureChanged([{ id: "T3", title: "Docs", status: "in_progress" }]));
			await until(() => metadata().length === 3);
			stub.emit({ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0 });
			await until(() => metadata().length === 4);
			h.screen.type("again");
			h.screen.type("\r");
			await until(() => metadata().length === 5);
			h.screen.type("\x03");
			h.screen.type("\x03");
			expect(await code).toBe(130);
			await herdr.close();

			for (const call of metadata())
				expect(call.params).toMatchObject({ pane_id: "w1:p1", source: "atelier:activity", agent: "atelier" });
			const docs = { tokens: { summary: "◐ T3 Docs", summary2: null }, ttl_ms: 30000 };
			expect(metadata().map(said)).toEqual(
				[
					{ tokens: { summary: "◐ T2 Show the active task", summary2: "in Herdr's sidebar, cut…" }, ttl_ms: 30000 },
					cleared,
					docs,
					cleared,
					docs,
					cleared,
				].map((params) => ({ method: "pane.report_metadata", ...params })),
			);
			expect(herdr.calls.at(-1)?.method).toBe("pane.release_agent");
		});

		it.each([
			["a word longer than the row", "x".repeat(300)],
			["two-byte characters", "ñ".repeat(300)],
			["three-byte characters", "漢".repeat(300)],
		])("keeps each summary token within Herdr's limits for %s", async (_name, title) => {
			const herdr = await fakeHerdr();
			await writeFile(join(cwd, "session.json"), JSON.stringify({ sidebar_width: 125 }));
			const reporter = HerdrStatusReporter.fromEnv(herdrEnv(herdr.path));
			reporter?.activity({ id: "T1", title });
			reporter?.report("working");
			const metadata = () => herdr.calls.find((call) => call.method === "pane.report_metadata");
			await until(() => metadata() !== undefined);
			await reporter?.release();
			await herdr.close();
			const { summary, summary2 } = (metadata() as HerdrCall).params.tokens as { summary: string; summary2: string };
			for (const token of [summary, summary2]) {
				expect([...token].length).toBeLessThanOrEqual(80);
				expect(Buffer.byteLength(token)).toBeLessThanOrEqual(128);
			}
			// With no space after the ID, the first row breaks inside the word.
			expect(summary.startsWith(`◐ T1 ${title.slice(0, 1)}`)).toBe(true);
			expect(summary2.endsWith("…")).toBe(true);
		});

		it("breaks a long word inside the first row at the default width", async () => {
			const herdr = await fakeHerdr();
			const reporter = HerdrStatusReporter.fromEnv(herdrEnv(herdr.path));
			reporter?.activity({ id: "T1", title: "x".repeat(60) });
			reporter?.report("working");
			const metadata = () => herdr.calls.find((call) => call.method === "pane.report_metadata");
			await until(() => metadata() !== undefined);
			await reporter?.release();
			await herdr.close();
			expect(metadata()?.params.tokens).toEqual({
				summary: `◐ T1 ${"x".repeat(19)}`,
				summary2: `${"x".repeat(23)}…`,
			});
		});

		it("refreshes the summary while the turn runs, 24 columns wide without Herdr's session file", async () => {
			const herdr = await fakeHerdr();
			const reporter = HerdrStatusReporter.fromEnv(herdrEnv(herdr.path), { refreshMs: 20 });
			const metadata = () => herdr.calls.filter((call) => call.method === "pane.report_metadata").map(said);
			reporter?.activity({ id: "T1", title: "abcdefghij klmnopqrst uvwxyz" });
			reporter?.report("working");
			await until(() => metadata().length === 3);
			reporter?.report("idle");
			await reporter?.release();
			await herdr.close();
			const summary = {
				method: "pane.report_metadata",
				tokens: { summary: "◐ T1 abcdefghij", summary2: "klmnopqrst uvwxyz" },
				ttl_ms: 30000,
			};
			expect(metadata().slice(0, 3)).toEqual([summary, summary, summary]);
			expect(metadata().at(-1)).toEqual({ method: "pane.report_metadata", ...cleared });
			expect(herdr.calls.at(-1)?.method).toBe("pane.release_agent");
		});
	});
});

describe("TUI login", { timeout: 20_000 }, () => {
	requireIsolatedHome();
	/** A stand-in for Claude Code whose login and logout change what `auth status` prints. */
	const fakeClaude = async () => {
		const path = join(home, "claude");
		await writeFile(join(home, "status.json"), '{"loggedIn":false,"authMethod":"none"}');
		await writeFile(
			path,
			`#!/bin/sh
case "$1 $2" in
"auth status") cat "${home}/status.json"; grep -q '"loggedIn":true' "${home}/status.json" ;;
"auth login") echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}' > "${home}/status.json" ;;
"auth logout") echo '{"loggedIn":false,"authMethod":"none"}' > "${home}/status.json" ;;
esac
`,
		);
		await chmod(path, 0o755);
		return path;
	};
	const authJson = async () =>
		JSON.parse(await readFile(join(home, ".atelier", "auth.json"), "utf8").catch(() => "{}"));

	it("asks the method and the provider in lists, and reads the API key without showing it", async () => {
		const h = harness([]);
		Object.assign(h.io, { claudeCode: await fakeClaude(), env: {} });
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/login");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Select authentication method"));
		expect(h.screen.screen()).toContain("Sign in with an API key");
		h.screen.type("\x1b[B");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("not configured"));
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Anthropic API key"));
		h.screen.type("sk-ant-");
		h.screen.type("\x1b[200~tui-secret\x1b[201~");
		await until(() => h.screen.screen().includes("17 characters"));
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("✓ Anthropic: API key stored"));
		expect((await authJson()).anthropic).toEqual({ type: "api_key", key: "sk-ant-tui-secret" });
		expect(h.screen.screen()).not.toContain("tui-secret");
		expect(h.backend.prompts).toEqual([]);
		h.screen.type("/logout api-key");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Anthropic API key removed"));
		expect((await authJson()).anthropic).toBeUndefined();
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("asks for the key and lists the methods as questions: the editor hides, Ctrl+C and Ctrl+D close them as Esc", async () => {
		const h = harness([]);
		// With color, so the empty editor shows its placeholder and its absence can be seen.
		Object.assign(h.io, { claudeCode: await fakeClaude(), env: {}, color: true });
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		await until(() => h.screen.screen().includes("Ask Atelier to do anything"));
		for (const close of ["\x03", "\x04"]) {
			const mark = h.screen.raw().length;
			const since = () => plain(h.screen.raw().slice(mark));
			h.screen.type("/login api-key anthropic");
			h.screen.type("\r");
			await until(() => since().includes("0 characters (hidden)"));
			h.screen.type("typed-secret-1");
			await until(() => since().includes("14 characters (hidden)"));
			// The editor is hidden while the key is asked, and the key never shows.
			expect(since()).not.toContain("Ask Atelier to do anything");
			expect(h.screen.raw()).not.toContain("typed-secret-1");
			h.screen.type(close);
			await until(() => since().includes("error: no key given; nothing changed"));
			await until(() => since().includes("Ask Atelier to do anything"));
		}
		for (const close of ["\x03", "\x04"]) {
			const mark = h.screen.raw().length;
			const since = () => plain(h.screen.raw().slice(mark));
			h.screen.type("/login");
			h.screen.type("\r");
			await until(() => since().includes("Select authentication method"));
			expect(since()).not.toContain("Ask Atelier to do anything");
			h.screen.type(close);
			await until(() => since().includes("Nothing changed."));
			await until(() => since().includes("Ask Atelier to do anything"));
		}
		expect(await authJson()).toEqual({});
		expect(h.backend.prompts).toEqual([]);
		// With no question open, Ctrl+C quits as before.
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});

	it("hands the terminal to Claude Code's sign-in and takes it back, then signs out only once confirmed", async () => {
		const h = harness([]);
		Object.assign(h.io, { claudeCode: await fakeClaude(), env: {} });
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/login account anthropic");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("✓ Anthropic: subscription configured (pro)"));
		expect(h.screen.stopped()).toBe(true);
		h.screen.type("/logout");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("signs out Claude Code on this machine too"));
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Nothing changed."));
		h.screen.type("/logout account");
		h.screen.type("\r");
		await until(() => h.screen.screen().split("signs out Claude Code on this machine too").length === 3);
		h.screen.type("\x1b[A");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("Signed out of Claude Code."));
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});
});

describe("TUI login warning", { timeout: 20_000 }, () => {
	it("says at start, before any prompt, what the session's backend lacks", async () => {
		const h = harness([]);
		const asked: string[] = [];
		Object.assign(h.io, {
			checkLogin: async (backend: string) => {
				asked.push(backend);
				return "Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account.";
			},
		});
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(() => h.screen.screen().includes("warning: Claude Code is not logged in: use /login"));
		expect(asked).toHaveLength(1);
		expect(h.backend.prompts).toEqual([]);
		h.screen.type("\x03");
		h.screen.type("\x03");
		expect(await code).toBe(130);
	});
});

describe("independent authentication security probes", { timeout: 20_000 }, () => {
	it("keeps a successful TUI key out of every protocol command and saved session", async () => {
		const h = harness([], { saveSessions: true, backendId: "claude-code" });
		const canary = "REVIEW_CANARY_NOT_A_CREDENTIAL";
		const code = run([], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/login api-key anthropic");
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("API key (hidden)"));
		h.screen.type(`\x1b[200~${canary}\x1b[201~`);
		h.screen.type("\r");
		await until(() => h.screen.screen().includes("API key stored"));
		expect(h.screen.raw().includes(canary)).toBe(false);
		expect(JSON.stringify(h.core.commands).includes(canary)).toBe(false);
		expect(h.backend.prompts).toEqual([]);
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
		const fs = await import("node:fs/promises");
		for (const entry of await fs.readdir(join(home, ".atelier", "sessions"), {
			recursive: true,
			withFileTypes: true,
		})) {
			if (entry.isFile())
				expect((await readFile(join(entry.parentPath, entry.name), "utf8")).includes(canary)).toBe(false);
		}
	});
	it("restarts the TUI after a fake child receives SIGINT without quitting Atelier", async () => {
		const h = harness([]);
		const fake = join(home, "claude.cjs");
		const startedFile = join(home, "fake-started");
		await writeFile(
			fake,
			`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[3]==='status'){console.log('{"loggedIn":false,"authMethod":"none"}');process.exit(1);}fs.writeFileSync(${JSON.stringify(startedFile)},String(process.pid));process.on('SIGINT',()=>process.exit(130));process.stdin.resume();`,
		);
		await chmod(fake, 0o755);
		let interrupt: (() => void) | undefined;
		let starts = 0;
		let stops = 0;
		const terminal = h.screen.terminal;
		const start = terminal.start.bind(terminal),
			stop = terminal.stop.bind(terminal);
		terminal.start = (...args) => {
			starts++;
			start(...args);
		};
		terminal.stop = () => {
			stops++;
			stop();
		};
		Object.assign(h.io, {
			claudeCode: fake,
			env: process.env,
			onInterrupt: (handler: () => void) => {
				interrupt = handler;
				return () => {
					interrupt = undefined;
				};
			},
		});
		const code = run(["--no-session"], h.io, () => h.backend);
		await until(h.screen.started);
		h.screen.type("/login account anthropic");
		h.screen.type("\r");
		let pid = 0;
		await vi.waitFor(async () => {
			pid = Number(await readFile(startedFile, "utf8"));
			expect(pid > 0).toBe(true);
		});
		expect(stops).toBe(1);
		expect(starts).toBe(1);
		interrupt?.();
		process.kill(pid, "SIGINT");
		await until(() => h.screen.screen().includes("Claude Code is still not logged in"));
		expect(starts).toBe(2);
		h.screen.type("/exit");
		h.screen.type("\r");
		expect(await code).toBe(0);
	});
});

describe("TUI sign-in with ChatGPT", { timeout: 20_000 }, () => {
	it("never shows the authorization code typed or pasted in the question", async () => {
		const auth = await new FakeOpenAiAuth().start();
		const code = `test-code-${randomUUID()}`;
		const h = harness([]);
		const run$ = run(
			["--no-session"],
			{
				...h.io,
				env: { DISPLAY: ":0" },
				openaiLogin: { openai: { authUrl: auth.url, callbackPort: 0 }, openBrowser: async () => {} },
			},
			() => h.backend,
		);
		try {
			await until(h.screen.started);
			h.screen.type("/login account openai-codex");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("How to sign in to OpenAI Codex"));
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("paste the URL it ends on"));
			h.screen.type(`\x1b[200~http://localhost:1455/auth/callback?code=${code}&state=x\x1b[201~`);
			h.screen.type("c");
			await until(() => h.screen.screen().includes("code=[hidden]"));
			expect(h.screen.raw()).not.toContain(code);
			h.screen.type("\x1b");
			await until(() => h.screen.screen().includes("cancelled"));
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await run$).toBe(0);
		} finally {
			await auth.stop();
		}
	});

	it("cancels a device code with Ctrl+C, stops polling, and stays open", async () => {
		const auth = await new FakeOpenAiAuth().start();
		let polls = 0;
		auth.routes.set("/api/accounts/deviceauth/usercode", () => ({
			json: { device_auth_id: "test-device", user_code: "TEST-CODE", interval: "0" },
		}));
		auth.routes.set("/api/accounts/deviceauth/token", () => {
			polls++;
			return { status: 403, json: {} };
		});
		const h = harness([]);
		const run$ = run(
			["--no-session"],
			{ ...h.io, env: { DISPLAY: ":0" }, openaiLogin: { openai: { authUrl: auth.url, minPollIntervalMs: 1 } } },
			() => h.backend,
		);
		try {
			await until(h.screen.started);
			h.screen.type("/login account openai-codex");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("How to sign in to OpenAI Codex"));
			h.screen.type("\x1b[B");
			h.screen.type("\r");
			await until(() => polls >= 2 && h.screen.screen().includes("Esc cancels"));
			h.screen.type("\x03");
			await until(() => h.screen.screen().includes("the sign-in was cancelled"));
			const after = polls;
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await run$).toBe(0);
			expect(polls).toBeLessThanOrEqual(after + 1);
			expect(auth.requests.some((request) => request.path === "/oauth/token")).toBe(false);
		} finally {
			await auth.stop();
		}
	});

	it("asks for the pasted URL in a question, closes it when the browser finishes, and stores the sign-in", async () => {
		const auth = await new FakeOpenAiAuth().start();
		const access = fakeJwt({ sub: "user" });
		auth.routes.set("/api/accounts/oauth/token", () => ({
			json: {
				access_token: access,
				refresh_token: fakeRefresh(),
				id_token: "id",
				expires_in: 3600,
				scope: "chatgpt.tokens.use.direct",
			},
		}));
		const free = createServer();
		await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
		const callbackPort = (free.address() as { port: number }).port;
		await new Promise((resolve) => free.close(resolve));
		let page = "";
		const h = harness([]);
		const code = run(
			["--no-session"],
			{
				...h.io,
				// A desktop with a display, wherever the suite runs.
				env: { DISPLAY: ":0" },
				openaiLogin: {
					openai: { authUrl: auth.url, callbackPort },
					openBrowser: async (url) => {
						page = url;
					},
				},
			},
			() => h.backend,
		);
		try {
			await until(h.screen.started);
			h.screen.type("/login account openai-chatgpt");
			h.screen.type("\r");
			await until(() => h.screen.screen().includes("paste the URL it ends on"));
			expect(h.screen.screen()).toContain("Sign in at:");
			const url = new URL(page);
			await fetch(
				`${url.searchParams.get("redirect_uri")}?code=c-1&state=${url.searchParams.get("state")}&client_id=issued-1`,
			);
			await until(() => h.screen.screen().includes("✓ Sign in with ChatGPT: signed in"));
			expect(JSON.parse(await readFile(join(home, ".atelier", "auth.json"), "utf8"))["openai-chatgpt"]).toMatchObject({
				access,
				clientId: "issued-1",
			});
			expect(JSON.stringify(h.core.commands).includes(access)).toBe(false);
			expect(h.backend.prompts).toEqual([]);
			// The question closed by itself: what is typed now goes to the editor again.
			h.screen.type("/exit");
			h.screen.type("\r");
			expect(await code).toBe(0);
		} finally {
			await auth.stop();
		}
	});
});

describe("paste question", () => {
	it("hides a bare code, with or without =, and the code of a URL", async () => {
		const { withoutCode } = await import("../src/tui/dialog.ts");
		expect(withoutCode("YmFyZS1jb2Rl==")).toBe("[hidden code, 14 characters]");
		expect(withoutCode("bare-code")).toBe("[hidden code, 9 characters]");
		expect(withoutCode("http://localhost:1455/auth/callback?code=abc&state=s")).toBe(
			"http://localhost:1455/auth/callback?code=[hidden]&state=s",
		);
	});
});
