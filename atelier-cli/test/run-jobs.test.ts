import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	type AtelierEventBody,
	coreTools,
	createBackgroundTools,
	FakeBackend,
	type FakeStep,
	Sandbox,
	type SandboxManagerLike,
} from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

let cwd: string;
let home: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-cli-jobs-"));
	home = await mkdtemp(join(tmpdir(), "atelier-cli-jobs-home-"));
	vi.stubEnv("HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(cwd, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

/** The core's tools with background tools whose sandbox is there and wraps nothing. */
function tools() {
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	const background = createBackgroundTools({ sandbox: new Sandbox({ platform: "darwin", manager }) });
	return coreTools.map((tool) => background.find((own) => own.name === tool.name) ?? tool);
}

function harness(turns: FakeStep[][], options: { input?: boolean } = {}) {
	const backend = new FakeBackend(turns);
	const stdin = new PassThrough();
	let stdout = "";
	let stderr = "";
	let interrupt: (() => void) | undefined;
	const io = {
		stdin,
		isTTY: false,
		stdout: (s: string) => {
			stdout += s;
		},
		stderr: (s: string) => {
			stderr += s;
		},
		cwd,
		claudeCode: join(cwd, "no-claude-in-tests"),
		runSecurity: async () => ({ code: 44, stdout: "", stderr: "" }),
		tools: tools(),
		color: false,
		env: {},
		onInterrupt: (handler: () => void) => {
			interrupt = handler;
			return () => {
				interrupt = undefined;
			};
		},
	};
	if (!options.input) stdin.end();
	return {
		backend,
		io,
		stdin,
		out: () => stdout,
		err: () => stderr,
		ctrlC: () => interrupt?.(),
		createBackend: () => backend,
	};
}

/** A job that ends once the test creates the file `go`, saying `done`. */
const waitsForGo = () => `while [ ! -f ${join(cwd, "go")} ]; do sleep 0.02; done; echo done`;
const go = () => writeFile(join(cwd, "go"), "");
const startJob = (command: string): FakeStep => ({
	toolCall: { tool: "bash_background", input: { command, label: "wait" }, callId: "c1" },
});

describe("background jobs in atelier run", () => {
	it("waits for a running job and the turn its notice wakes before exiting", async () => {
		const h = harness([[startJob(waitsForGo()), { event: finished }], [{ event: finished }]]);
		const exited = run(["--no-session", "start it"], h.io, h.createBackend);
		await until(() => h.err().includes("waiting for 1 background job (Ctrl+C stops them)\n"));
		await go();
		expect(await exited).toBe(0);
		expect(h.backend.prompts[1]).toMatch(/^Background job 1 \("wait"\) ended: exit code 0/);
		expect(h.out()).toContain("⧗ job 1 started · wait · 1 running\n");
		expect(h.out()).toMatch(/■ job 1 ended · exit 0 · \d+s · wait · 1 notice waiting\n/);
	});

	it("stops the jobs it waits for on Ctrl+C", async () => {
		const pidFile = join(cwd, "pid");
		const h = harness([[startJob(`echo $$ > ${pidFile}; exec sleep 300`), { event: finished }]]);
		const exited = run(["--no-session", "start it"], h.io, h.createBackend);
		await until(() => h.err().includes("waiting for 1 background job"));
		await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		h.ctrlC();
		expect(await exited).toBe(130);
		expect(() => process.kill(pid, 0)).toThrow();
		expect(h.backend.prompts).toHaveLength(1);
	});

	it("runs the turn a notice wakes while the line CLI waits for input", async () => {
		const h = harness([[startJob(waitsForGo()), { event: finished }], [{ event: finished }]], { input: true });
		h.stdin.write("start it\n");
		const exited = run(["--no-session"], h.io, h.createBackend);
		await until(() => h.backend.prompts.length === 1 && h.out().includes("⧗ job 1 started"));
		await go();
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toMatch(/^Background job 1 /);
		h.stdin.end();
		expect(await exited).toBe(0);
	});

	it("says the notices an interrupted turn leaves, and gives them with the next prompt", async () => {
		const h = harness(
			[
				[
					startJob(waitsForGo()),
					{ run: go },
					{ run: () => until(() => h.out().includes("■ job 1")) },
					{ waitForInterrupt: true },
				],
				[{ event: finished }],
			],
			{ input: true },
		);
		h.stdin.write("start it\n");
		const exited = run(["--no-session"], h.io, h.createBackend);
		await until(() => h.out().includes("■ job 1 ended"));
		h.ctrlC();
		await until(() => h.out().includes("jobs: 1 notice waits for your next prompt\n"));
		h.stdin.write("go on\n");
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toMatch(/^Background job 1 [\s\S]*\n\ngo on$/);
		h.stdin.end();
		expect(await exited).toBe(0);
	});
});
