import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	BUILTIN_AGENTS,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { createBackgroundTools } from "../src/tools/background.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { grepTool } from "../src/tools/grep.ts";
import { readTool } from "../src/tools/read.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const MCP_FIXTURE = fileURLToPath(new URL("fixtures/mcp/server.ts", import.meta.url));
const ASK =
	"Declare the risk of this change now: call the risk tool with the high-risk items that apply and a reason, or with none and a reason.";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });
const call = (tool: string, input: Record<string, unknown>, callId = `c-${tool}`): FakeStep => ({
	toolCall: { tool, input: input as never, callId },
});
/** The agent's answer to the request to declare the risk, when the core makes one. */
const DECLARING: FakeStep[] = [call("risk", { none: true, reason: "test" }, "c-declare"), { event: finished }];

const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()));
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A sandbox that is there and wraps nothing. */
function sandbox(): Sandbox {
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return new Sandbox({ platform: "darwin", manager });
}

/** A git repo with one commit, and `a.ts` changed since: what another session left uncommitted. */
async function dirtyRepo(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "atelier-own-changes-")));
	dirs.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(root, "a.ts"), "base\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	await writeFile(join(root, "a.ts"), "base\nfrom another session\n");
	return root;
}

async function start(turns: FakeStep[][], extra: Partial<SessionOptions> = {}, cwd?: string) {
	const root = cwd ?? (await dirtyRepo());
	const main = new FakeBackend(turns);
	const events: AtelierEvent[] = [];
	const session = await Session.start({
		backend: main,
		cwd: root,
		tools: [readTool, grepTool, createBashTool({ sandbox: sandbox() })],
		review: { createBackend: () => new FakeBackend([]) },
		...extra,
	});
	sessions.push(session);
	const send = async (prompt: string) => {
		const mine: AtelierEvent[] = [];
		for await (const event of session.send(prompt)) mine.push(event);
		events.push(...mine);
		return mine;
	};
	return { session, main, cwd: root, send };
}

const assessed = (events: AtelierEvent[]) => events.filter((event) => event.type === "review_assessed");

describe("the end-of-turn review of a turn that changed nothing of its own", () => {
	it("does not assess a turn that only answers, with changes left in the worktree before it", async () => {
		const s = await start([[text("hola"), { event: finished }], DECLARING]);
		const events = await s.send("hola");
		expect(assessed(events)).toEqual([]);
		expect(s.main.prompts).toEqual(["hola"]);
	});

	it("does not assess a turn whose worktree another session changes while it runs", async () => {
		const cwd = await dirtyRepo();
		execFileSync("git", ["checkout", "-q", "--", "a.ts"], { cwd });
		const other = { run: () => writeFile(join(cwd, "a.ts"), "base\nwritten meanwhile\n") };
		const s = await start([[other, text("hola"), { event: finished }], DECLARING], {}, cwd);
		const events = await s.send("hola");
		expect(assessed(events)).toEqual([]);
		expect(s.main.prompts).toEqual(["hola"]);
	});

	it("does not assess a turn that only reads and searches", async () => {
		const turn = [call("read", { path: "a.ts" }), call("grep", { pattern: "base" }), text("read"), { event: finished }];
		const s = await start([turn, DECLARING]);
		const events = await s.send("look");
		const ran = events.flatMap((event) => (event.type === "tool_call_finished" ? [event.callId] : []));
		expect(ran).toEqual(["c-read", "c-grep"]);
		expect(assessed(events)).toEqual([]);
		expect(s.main.prompts).toEqual(["look"]);
	});

	it("does not assess a turn whose only command the user denied", async () => {
		const turn = [call("bash", { command: "echo x >> a.ts" }), text("denied"), { event: finished }];
		const s = await start([turn, DECLARING], { noSandbox: true, approve: async () => false });
		const events = await s.send("write");
		expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
		expect(assessed(events)).toEqual([]);
		expect(s.main.prompts).toEqual(["write"]);
	});

	it("does not assess a turn whose subagent only reads", async () => {
		const child = new FakeBackend([[text("report"), { event: finished }]]);
		const turn = [call("task", { agent: "explorer", prompt: "look" }), text("done"), { event: finished }];
		const s = await start([turn, DECLARING], {
			subagents: { agents: BUILTIN_AGENTS, createBackend: () => child },
		});
		const events = await s.send("look");
		expect(child.prompts).toHaveLength(1);
		expect(assessed(events)).toEqual([]);
	});
});

describe("the end-of-turn review of a turn that ran a tool that may change files", () => {
	it("assesses a command that wrote and failed, and asks its risk", async () => {
		const turn = [call("bash", { command: "echo x >> a.ts; exit 1" }), text("failed"), { event: finished }];
		const s = await start([turn, DECLARING]);
		const events = await s.send("write");
		expect(events.find((event) => event.type === "tool_call_finished")).toMatchObject({ ok: false });
		expect(assessed(events)).toHaveLength(1);
		expect(s.main.prompts).toEqual(["write", ASK]);
	});

	it("assesses an MCP call, even to a tool that only reads", async () => {
		const cwd = await dirtyRepo();
		const mcp = new McpManager({
			file: join(cwd, ".git", "mcp.json"),
			servers: [
				{
					name: "fixture",
					transport: "stdio",
					enabled: true,
					timeoutMs: 10_000,
					command: process.execPath,
					args: [MCP_FIXTURE],
					env: {},
					cwd,
				} as never,
			],
			problems: [],
			secrets: [],
		});
		mcp.start();
		const echo = call("mcp_call", { server: "fixture", tool: "echo", arguments: { text: "hola" } });
		const s = await start([[echo, text("echoed"), { event: finished }], DECLARING], { mcp }, cwd);
		const events = await s.send("echo");
		expect(events.find((event) => event.type === "tool_call_finished")).toMatchObject({ ok: true });
		expect(assessed(events)).toHaveLength(1);
		expect(s.main.prompts).toEqual(["echo", ASK]);
	});

	it("assesses a turn whose subagent wrote in the session's folder", async () => {
		const child = new FakeBackend([[text("report"), { event: finished }]]);
		const turn = [call("task", { agent: "worker", prompt: "change it" }), text("done"), { event: finished }];
		const s = await start([turn, DECLARING], {
			subagents: { agents: BUILTIN_AGENTS, createBackend: () => child },
		});
		const events = await s.send("change");
		expect(child.prompts).toHaveLength(1);
		expect(assessed(events)).toHaveLength(1);
	});

	it("assesses the turn that takes the end notice of the session's own job, which wrote after its turn", async () => {
		const cwd = await dirtyRepo();
		execFileSync("git", ["checkout", "-q", "--", "a.ts"], { cwd });
		const command = `while [ ! -f ${join(cwd, ".git", "go")} ]; do sleep 0.1; done; echo job >> a.ts`;
		let woke = 0;
		const s = await start(
			[
				[call("bash_background", { command, label: "late" }), text("started"), { event: finished }],
				[text("the job ended"), { event: finished }],
				DECLARING,
			],
			{ tools: createBackgroundTools({ sandbox: sandbox() }), wake: () => woke++ },
			cwd,
		);
		const first = await s.send("start it");
		expect(assessed(first)).toEqual([]);
		await writeFile(join(cwd, ".git", "go"), "");
		await until(() => woke === 1);
		const events = await s.send("hola");
		expect(s.main.prompts[1]).toContain('Background job 1 ("late") ended');
		expect(assessed(events)).toHaveLength(1);
		expect(s.main.prompts.at(-1)).toBe(ASK);
	});
});
