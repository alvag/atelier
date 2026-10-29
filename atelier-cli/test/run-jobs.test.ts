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

function harness(turns: FakeStep[][], options: { input?: boolean; raw?: boolean } = {}) {
	const backend = new FakeBackend(turns);
	const stdin = new PassThrough();
	let stdout = "";
	let stderr = "";
	let interrupt: (() => void) | undefined;
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
const waitsForGo = () => `while [ ! -f ${join(cwd, "go")} ]; do sleep 0.1; done; echo done`;
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

	it("exits 1 when the prompt's turn failed, with a job it started running", async () => {
		const h = harness([[startJob(waitsForGo()), { throw: "backend failed" }], [{ event: finished }]]);
		const exited = run(["--no-session", "start it"], h.io, h.createBackend);
		await until(() => h.out().includes("⧗ job 1 started"));
		await go();
		expect(await exited).toBe(1);
	});

	it("exits 1 when a turn a notice woke failed, though the prompt's turn went well", async () => {
		const h = harness([[startJob(waitsForGo()), { event: finished }], [{ throw: "backend failed" }]]);
		const exited = run(["--no-session", "start it"], h.io, h.createBackend);
		await until(() => h.err().includes("waiting for 1 background job"));
		await go();
		expect(await exited).toBe(1);
		expect(h.backend.prompts).toHaveLength(2);
	});

	it("gives the notices of jobs that end together to one woken turn", async () => {
		const second: FakeStep = {
			toolCall: { tool: "bash_background", input: { command: waitsForGo(), label: "other" }, callId: "c2" },
		};
		const h = harness([[startJob(waitsForGo()), second, { event: finished }], [{ event: finished }]]);
		const exited = run(["--no-session", "start them"], h.io, h.createBackend);
		await until(() => h.err().includes("waiting for 2 background jobs"));
		await go();
		expect(await exited).toBe(0);
		expect(h.backend.prompts).toHaveLength(2);
		expect(h.backend.prompts[1]?.match(/Background job /g)).toHaveLength(2);
	});

	it("gives one woken turn the notice a turn left and that of a job ending just after it", async () => {
		// The second job ends a moment after the first: after the turn that saw the first one end is over.
		const later: FakeStep = {
			toolCall: {
				tool: "bash_background",
				input: { command: `${waitsForGo()}; sleep 0.15`, label: "later" },
				callId: "c2",
			},
		};
		const h = harness([
			[
				startJob(waitsForGo()),
				later,
				{ run: go },
				{ run: () => until(() => h.out().includes("■ job 1 ended")) },
				{ event: finished },
			],
			[{ event: finished }],
		]);
		expect(await run(["--no-session", "start them"], h.io, h.createBackend)).toBe(0);
		expect(h.backend.prompts).toHaveLength(2);
		expect(h.backend.prompts[1]?.match(/Background job /g)).toHaveLength(2);
	});

	it("exits 130 on Ctrl+C while a woken turn gathers its notices, without calling the backend", async () => {
		const h = harness([[startJob(waitsForGo()), { event: finished }], [{ waitForInterrupt: true }]]);
		const exited = run(["--no-session", "start it"], h.io, h.createBackend);
		await until(() => h.err().includes("waiting for 1 background job"));
		await go();
		await until(() => h.out().includes("■ job 1 ended"));
		h.ctrlC();
		expect(await exited).toBe(130);
		expect(h.backend.prompts).toHaveLength(1);
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

	it.each(["interrupted", "error"])(
		"shows the end of a job that ends after a turn that ended %s, and its notice waiting, before the next prompt",
		async (how) => {
			const h = harness(
				[
					[
						startJob(waitsForGo()),
						...(how === "interrupted"
							? [{ run: () => h.ctrlC() }, { waitForInterrupt: true as const }]
							: [{ throw: "backend failed" }]),
					],
					[{ event: finished }],
				],
				{ input: true },
			);
			h.stdin.write("start it\n");
			const exited = run(["--no-session"], h.io, h.createBackend);
			await until(() => h.out().includes("⧗ job 1 started"));
			await until(() => h.backend.prompts.length === 1 && /tokens:|error/.test(h.out() + h.err()));
			await go();
			await until(() => /■ job 1 ended · exit 0 · \d+s · wait · 1 notice waiting\n/.test(h.out()));
			expect(h.backend.prompts).toHaveLength(1);
			h.stdin.write("continue\n");
			await until(() => h.backend.prompts.length === 2);
			expect(h.backend.prompts[1]).toMatch(/^Background job 1 /);
			h.stdin.end();
			expect(await exited).toBe(0);
			// Said once: the next turn does not say it again.
			expect(h.out().match(/■ job 1 ended/g)).toHaveLength(1);
		},
	);

	it("shows again what was typed after the end of a job outside any turn, and Enter sends it", async () => {
		const h = harness([[startJob(waitsForGo()), { throw: "backend failed" }], [{ event: finished }]], {
			input: true,
			raw: true,
		});
		const exited = run(["--no-session"], h.io, h.createBackend);
		h.stdin.write("start it\r");
		await until(() => h.err().includes("backend failed"));
		h.stdin.write("abc");
		await until(() => h.out().endsWith("> abc"));
		await go();
		await until(() => /■ job 1 ended[^\n]*\n> abc$/.test(h.out()));
		h.stdin.write("\r");
		await until(() => h.backend.prompts.length === 2);
		expect(h.backend.prompts[1]).toMatch(/^Background job 1 [\s\S]*\n\nabc$/);
		h.stdin.end();
		expect(await exited).toBe(0);
	});
});

describe("background tasks in atelier run", () => {
	it("waits for a background subagent and the turn its report wakes before exiting", async () => {
		let open = () => {};
		const opened = new Promise<void>((resolve) => (open = resolve));
		const child = new FakeBackend([
			[{ run: () => opened }, { event: { type: "text_delta", text: "REPORT" } }, { event: finished }],
		]);
		const h = harness([
			[
				{
					toolCall: {
						tool: "task",
						input: { agent: "explorer", prompt: "Find it.", background: true, label: "find" },
						callId: "c1",
					},
				},
				{ event: finished },
			],
			[{ event: finished }],
		]);
		const backends = [h.backend, child];
		const exited = run(["--no-session", "find it"], h.io, () => backends.shift() ?? child);
		await until(() => h.err().includes("waiting for 1 background job (Ctrl+C stops them)\n"));
		open();
		expect(await exited).toBe(0);
		expect(h.backend.prompts[1]).toMatch(/^Background task task-1 \(explorer, "find"\) finished after \d+s\.\n/);
		expect(h.out()).toContain("⧗ task task-1 started · explorer: find · 1 running\n");
		expect(h.out()).toMatch(/■ task task-1 finished · \d+s · explorer: find · 1 notice waiting\n/);
	});
});
