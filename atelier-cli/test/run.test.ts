import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type AtelierEventBody, FakeBackend, type FakeStep } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/run.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const started: AtelierEventBody = { type: "session_started", backend: "fake", model: "m", authSource: "subscription" };

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-cli-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function harness(turns: FakeStep[][], options: { isTTY?: boolean; input?: string[]; keepStdinOpen?: boolean } = {}) {
	const backend = new FakeBackend(turns);
	let interruptHandler: (() => void) | undefined;
	const exits: number[] = [];
	const stdin = new PassThrough();
	let stdout = "";
	let stderr = "";
	const io = {
		stdin,
		isTTY: options.isTTY ?? false,
		stdout: (s: string) => {
			stdout += s;
		},
		stderr: (s: string) => {
			stderr += s;
		},
		cwd,
		color: false,
		onInterrupt: (handler: () => void) => {
			interruptHandler = handler;
			return () => {
				interruptHandler = undefined;
			};
		},
		exit: (code: number) => {
			exits.push(code);
		},
	};
	for (const line of options.input ?? []) stdin.write(`${line}\n`);
	if (options.input && !options.keepStdinOpen) stdin.end();
	return {
		backend,
		io,
		exits,
		out: () => stdout,
		err: () => stderr,
		createBackend: () => backend,
		ctrlC: () => interruptHandler?.(),
	};
}

describe("run", () => {
	it("runs one prompt and exits 0", async () => {
		const h = harness([[{ event: started }, { event: { type: "text_delta", text: "hello" } }, { event: finished }]]);
		const code = await run(["say hi"], h.io, h.createBackend);
		expect(code).toBe(0);
		expect(h.backend.prompts).toEqual(["say hi"]);
		expect(h.out()).toContain("hello\ntokens: input 1 · output 2 · cache read 3 · cache write 4\n");
		expect(h.backend.startOptions?.cwd).toBe(cwd);
		expect(h.backend.startOptions?.tools.map((t) => t.name)).toEqual(["read", "edit", "bash", "grep"]);
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

	it("denies commands without a terminal to ask, and runs them with --yes", async () => {
		await writeFile(join(cwd, "marker"), "");
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "rm marker" } } };

		const denied = harness([[step, { event: finished }]]);
		await run(["x"], denied.io, denied.createBackend);
		expect(denied.backend.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
		expect(denied.err()).toContain("needs approval; run with --yes to allow commands");

		const allowed = harness([[step, { event: finished }]]);
		await run(["--yes", "x"], allowed.io, allowed.createBackend);
		expect(allowed.backend.toolResults[0]?.ok).toBe(true);
	});

	it("asks on a terminal and runs the command only when the answer is yes", async () => {
		const step: FakeStep = { toolCall: { tool: "bash", input: { command: "echo hi" } } };

		const yes = harness([[step, { event: finished }]], { isTTY: true, input: ["y"] });
		await run(["x"], yes.io, yes.createBackend);
		expect(yes.out()).toContain("Run this command?\n  echo hi\n[y/N] ");
		expect(yes.backend.toolResults[0]?.ok).toBe(true);

		const no = harness([[step, { event: finished }]], { isTTY: true, input: [""] });
		await run(["x"], no.io, no.createBackend);
		expect(no.backend.toolResults[0]?.ok).toBe(false);
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
		const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

		it("interrupts the turn and exits 130", async () => {
			const h = harness([[{ event: { type: "text_delta", text: "a" } }, { waitForInterrupt: true }]]);
			const pending = run(["x"], h.io, h.createBackend);
			await tick();
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
			});
			const pending = run(["x"], h.io, h.createBackend);
			await tick();
			expect(h.out()).toContain("[y/N] ");
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
				{ isTTY: true, input: [], keepStdinOpen: true },
			);
			const stdin = h.io.stdin as PassThrough;
			const pending = run([], h.io, h.createBackend);
			stdin.write("first\n");
			await tick();
			expect(h.out()).toContain("[y/N] ");
			h.ctrlC();
			await tick();
			stdin.write("next prompt\n");
			stdin.end();
			expect(await pending).toBe(0);
			expect(h.backend.prompts).toEqual(["first", "next prompt"]);
			expect(h.out()).toContain("second turn");
		});

		it("closes the session on a second Ctrl+C when the turn does not stop", async () => {
			const h = harness([[{ hang: true }]]);
			const pending = run(["x"], h.io, h.createBackend);
			await tick();
			h.ctrlC();
			await tick();
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
			await tick();
			h.ctrlC();
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(h.exits).toEqual([130]);
		});

		it("leaves an idle interactive session cleanly", async () => {
			const h = harness([], { input: [], keepStdinOpen: true });
			const pending = run([], h.io, h.createBackend);
			await tick();
			h.ctrlC();
			expect(await pending).toBe(130);
			expect(h.backend.closed).toBe(true);
			expect(h.exits).toEqual([]);
		});
	});

	it("prints help and the version", async () => {
		const help = harness([]);
		expect(await run(["--help"], help.io, help.createBackend)).toBe(0);
		expect(help.out()).toContain("Usage: atelier [options] [prompt]");
		expect(help.backend.startOptions).toBeUndefined();

		const version = harness([]);
		expect(await run(["--version"], version.io, version.createBackend)).toBe(0);
		expect(version.out()).toBe("atelier 0.0.0\n");
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
