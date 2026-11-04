import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type AtelierEventBody, FakeBackend, type FakeStep, Session } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

type Idle = (event: AtelierEventBody) => void;
type Server = { name: string; transport: "stdio"; state: "connected" | "failed"; tools: string[]; error?: string };
const connected: Server = { name: "docs", transport: "stdio", state: "connected", tools: ["t"] };
const failed: Server = { name: "docs", transport: "stdio", state: "failed", tools: [], error: "boom" };
const snapshot = (...servers: Server[]): AtelierEventBody => ({ type: "mcp_status", servers, problems: [] });

let cwd: string;
let home: string;
let idle: Idle | undefined;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-cli-mcp-"));
	home = await mkdtemp(join(tmpdir(), "atelier-cli-mcp-home-"));
	vi.stubEnv("HOME", home);
	idle = undefined;
	// The real session runs; the test takes the callback the CLI gave it, to say what the servers would.
	const start = Session.start.bind(Session);
	vi.spyOn(Session, "start").mockImplementation((options) => {
		idle ??= options.idleEvent;
		return start(options);
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

function harness(turns: FakeStep[][], options: { input?: boolean; raw?: boolean } = {}) {
	const backend = new FakeBackend(turns);
	const stdin = new PassThrough();
	let stdout = "";
	let stderr = "";
	const io = {
		stdin,
		isTTY: options.raw === true,
		...(options.raw ? { setRawMode: () => {} } : {}),
		stdout: (s: string) => {
			stdout += s;
		},
		stderr: (s: string) => {
			stderr += s;
		},
		cwd,
		claudeCode: join(cwd, "no-claude-in-tests"),
		runSecurity: async () => ({ code: 44, stdout: "", stderr: "" }),
		color: false,
		env: {},
	};
	if (!options.input) stdin.end();
	const say = (event: AtelierEventBody) => {
		if (idle === undefined) throw new Error("the session has not started");
		idle(event);
	};
	return { io, stdin, say, out: () => stdout, err: () => stderr, createBackend: () => backend };
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("MCP status in atelier run", () => {
	it("says nothing before the first turn, then the latest summary once, and a failure once", async () => {
		const h = harness([[{ event: { type: "text_delta", text: "one" } }, finished], [finished]], { input: true });
		const exited = run(["--no-session"], h.io, h.createBackend);
		await until(() => idle !== undefined);
		const before = { out: h.out(), err: h.err() };
		h.say(snapshot({ ...connected, state: "connected", tools: [] }));
		h.say(snapshot(connected));
		expect({ out: h.out(), err: h.err() }).toEqual(before);

		h.stdin.write("first\n");
		await until(() => h.out().includes("one"));
		expect(h.out()).toContain("mcp: docs (1 tool)");
		expect(count(h.out(), "mcp:")).toBe(1);

		h.say(snapshot(connected));
		h.say(snapshot(failed));
		h.say(snapshot(failed));
		expect(count(h.out() + h.err(), "mcp: docs failed: boom")).toBe(1);
		expect(count(h.out(), "mcp: docs (1 tool)")).toBe(1);
		h.stdin.end();
		expect(await exited).toBe(0);
	});

	it("leaves the prompt alone for routine snapshots and before the first turn", async () => {
		const h = harness([[finished]], { input: true, raw: true });
		const exited = run(["--no-session"], h.io, h.createBackend);
		await until(() => idle !== undefined && h.out().includes("> "));
		const before = h.out();
		h.say(snapshot(connected));
		expect(h.out()).toBe(before);
		h.stdin.write("go\r");
		await until(() => h.out().includes("mcp: docs (1 tool)"));
		await until(() => h.out().endsWith("> "));
		const settled = h.out();
		h.say(snapshot(connected));
		expect(h.out()).toBe(settled);
		h.say(snapshot(failed));
		expect(h.out().length + h.err().length).toBeGreaterThan(settled.length);
		h.stdin.write("\x04");
		h.stdin.end();
		await exited;
	});

	it("prints the one-shot summary of a snapshot that came before its turn", async () => {
		const h = harness([[{ event: { type: "text_delta", text: "done" } }, finished]]);
		const exited = run(["--no-session", "hi"], h.io, h.createBackend);
		await until(() => idle !== undefined);
		h.say(snapshot(connected));
		expect(await exited).toBe(0);
		expect(count(h.out(), "mcp: docs (1 tool)")).toBe(1);
	});
});
