import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	BUILTIN_AGENTS,
	FakeBackend,
	type FakeStep,
	Session,
	SessionStore,
} from "../src/index.ts";
import { createBackgroundTools } from "../src/tools/background.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const call = (tool: string, input: Record<string, string>, callId: string): FakeStep => ({
	toolCall: { tool, input, callId },
});

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

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

let cwd: string;
let sessions: Session[] = [];
beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-jobs-")));
});
afterEach(async () => {
	await Promise.all(sessions.map((session) => session.close()));
	sessions = [];
	await rm(cwd, { recursive: true, force: true });
});

/** A job that ends once the test creates the file `go`, saying `done`. */
const waitsForGo = () => `while [ ! -f ${join(cwd, "go")} ]; do sleep 0.1; done; echo done`;
const go = () => writeFile(join(cwd, "go"), "");

/** A session with the background tools whose scripted turns can wait for what its events say. */
async function started(script: (seen: (type: string) => Promise<void>) => FakeStep[][]) {
	const events: AtelierEvent[] = [];
	const waiters: { type: string; resolve: () => void }[] = [];
	const seen = (type: string) =>
		new Promise<void>((resolve) => {
			if (events.some((event) => event.type === type)) resolve();
			else waiters.push({ type, resolve });
		});
	const backend = new FakeBackend(script(seen));
	let woke = 0;
	const session = await Session.start({
		backend,
		cwd,
		tools: createBackgroundTools({ sandbox: sandbox() }),
		wake: () => woke++,
	});
	sessions.push(session);
	/** Plays a turn, keeping its events where the script's `seen` finds them. */
	const play = async (turn: AsyncIterable<AtelierEvent>) => {
		const mine: AtelierEvent[] = [];
		for await (const event of turn) {
			events.push(event);
			mine.push(event);
			for (const waiter of waiters.filter((w) => w.type === event.type)) waiter.resolve();
		}
		return mine;
	};
	return { backend, session, play, woke: () => woke };
}

const ofType = <T extends AtelierEvent["type"]>(events: AtelierEvent[], type: T) =>
	events.filter((event): event is Extract<AtelierEvent, { type: T }> => event.type === type);

describe("background jobs in a session", () => {
	it("gives the notice of a job that ends during a turn with the next tool result", async () => {
		const { backend, session, play } = await started((seen) => [
			[
				call("bash_background", { command: waitsForGo(), label: "wait" }, "c1"),
				{ run: go },
				{ run: () => seen("job_finished") },
				call("job_list", {}, "c2"),
				{ event: finished },
			],
		]);
		const events = await play(session.send("start it"));
		expect(backend.toolResults[0]?.output).toMatch(/^Started background job 1 \("wait"\)/);
		expect(backend.toolResults[0]?.steering).toBeUndefined();
		expect(backend.toolResults[1]?.steering).toMatch(
			/^Background job 1 \("wait"\) ended: exit code 0 after \d+s\.\n[\s\S]*<job_output>\ndone\n<\/job_output>$/,
		);
		expect(ofType(events, "job_started")).toEqual([
			expect.objectContaining({
				jobId: "1",
				label: "wait",
				running: 1,
				outputPath: expect.stringMatching(/\/job-1\.log$/),
			}),
		]);
		expect(ofType(events, "job_finished")).toEqual([
			expect.objectContaining({ jobId: "1", status: "exited", exitCode: 0, notified: true, running: 0, waiting: 1 }),
		]);
		expect(ofType(events, "jobs_status")).toEqual([expect.objectContaining({ running: 0, waiting: 0 })]);
		expect(session.nextQueued()).toBeUndefined();
	});

	it("wakes a turn when a job ends with no turn running; the notice is its prompt and its first event", async () => {
		const { backend, session, play, woke } = await started(() => [
			[call("bash_background", { command: waitsForGo(), label: "wait" }, "c1"), { event: finished }],
			[{ event: finished }],
		]);
		await play(session.send("start it"));
		expect(woke()).toBe(0);
		await go();
		await until(() => woke() === 1);
		const next = session.nextQueued();
		expect(next).toBeDefined();
		const events = await play(next as AsyncIterable<AtelierEvent>);
		expect(events[0]).toMatchObject({ type: "job_finished", seq: 1, jobId: "1", notified: true, waiting: 1 });
		expect(backend.prompts[1]).toMatch(/^Background job 1 \("wait"\) ended: exit code 0/);
		expect(ofType(events, "jobs_status")).toEqual([expect.objectContaining({ running: 0, waiting: 0 })]);
		expect(session.nextQueued()).toBeUndefined();
	});

	it("starts a turn after one that ended before a later notice could go with a tool result", async () => {
		const { backend, session, play, woke } = await started((seen) => [
			[
				call("bash_background", { command: waitsForGo() }, "c1"),
				{ run: go },
				{ run: () => seen("job_finished") },
				{ event: finished },
			],
			[{ event: finished }],
		]);
		await play(session.send("start it"));
		// A turn was running: the client runs what waits once it ends, as it does for a follow-up.
		expect(woke()).toBe(0);
		const next = session.nextQueued();
		expect(next).toBeDefined();
		await play(next as AsyncIterable<AtelierEvent>);
		expect(backend.prompts[1]).toMatch(/^Background job 1 /);
	});

	it("keeps the notice of an interrupted turn for the next prompt, without waking a turn", async () => {
		const { backend, session, play, woke } = await started((seen) => [
			[
				call("bash_background", { command: waitsForGo() }, "c1"),
				{ run: go },
				{ run: () => seen("job_finished") },
				{ run: () => void session.interrupt() },
				{ waitForInterrupt: true },
			],
			[{ event: finished }],
		]);
		const interrupted = await play(session.send("start it"));
		expect(ofType(interrupted, "job_finished")).toEqual([expect.objectContaining({ waiting: 1 })]);
		expect(session.nextQueued()).toBeUndefined();
		expect(woke()).toBe(0);
		const events = await play(session.send("go on"));
		expect(backend.prompts[1]).toMatch(/^Background job 1 [\s\S]*\n\ngo on$/);
		expect(ofType(events, "jobs_status")).toEqual([expect.objectContaining({ running: 0, waiting: 0 })]);
	});

	it("ends a woken turn interrupted while it gathers notices, before the backend, and keeps them waiting", async () => {
		const { backend, session, play, woke } = await started(() => [
			[call("bash_background", { command: waitsForGo() }, "c1"), { event: finished }],
			[{ waitForInterrupt: true }],
		]);
		await play(session.send("start it"));
		await go();
		await until(() => woke() === 1);
		const turn = session.nextQueued() as AsyncGenerator<AtelierEvent>;
		const first = await turn.next();
		expect(first.value).toMatchObject({ type: "job_finished" });
		await session.interrupt();
		const rest: AtelierEvent[] = [];
		for (let next = await turn.next(); !next.done; next = await turn.next()) rest.push(next.value);
		expect(rest.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "interrupted" });
		expect(backend.prompts).toHaveLength(1);
		expect(session.jobs.waiting).toBe(1);
	});

	it.each(["interrupted", "error"])(
		"keeps the notice of a job that ends after a turn that ended %s for the next prompt, without waking a turn",
		async (how) => {
			const { backend, session, play, woke } = await started(() => [
				[
					call("bash_background", { command: waitsForGo() }, "c1"),
					...(how === "interrupted"
						? [{ run: () => void session.interrupt() }, { waitForInterrupt: true as const }]
						: [{ throw: "backend failed" }]),
				],
				[{ event: finished }],
			]);
			await play(session.send("start it"));
			await go();
			await until(() => session.jobs.waiting === 1);
			expect(woke()).toBe(0);
			expect(session.nextQueued()).toBeUndefined();
			await play(session.send("continue"));
			expect(backend.prompts[1]).toMatch(/^Background job 1 [\s\S]*\n\ncontinue$/);
		},
	);

	it("sends no notice of a stopped job, and stops every job when the session closes", async () => {
		const pidFile = join(cwd, "pid");
		const { backend, session, play } = await started(() => [
			[
				call("bash_background", { command: "sleep 300" }, "c1"),
				call("job_stop", { id: "1" }, "c2"),
				call("bash_background", { command: `echo $$ > ${pidFile}; exec sleep 300` }, "c3"),
				{ event: finished },
			],
		]);
		const events = await play(session.send("start them"));
		expect(backend.toolResults[1]?.output).toMatch(/^Stopped job 1 /);
		expect(backend.toolResults.every((result) => result.steering === undefined)).toBe(true);
		expect(ofType(events, "job_finished")).toEqual([
			expect.objectContaining({ jobId: "1", status: "stopped", notified: false, waiting: 0 }),
		]);
		let pid = 0;
		await until(() => {
			pid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, "utf8"), 10) || 0 : 0;
			return pid > 0;
		});
		await session.close();
		expect(() => process.kill(pid, 0)).toThrow();
		expect(session.nextQueued()).toBeUndefined();
	});
});

describe("closing a session with background jobs", () => {
	it("stops every job even when another part of the close fails, and still says that failure", async () => {
		const pidFile = join(cwd, "pid");
		const child = new FakeBackend([[{ hang: true }]]);
		child.closeError = "child close failed";
		const backend = new FakeBackend([
			[
				call("bash_background", { command: `echo $$ > ${pidFile}; exec sleep 300` }, "c1"),
				call("task", { agent: "worker", prompt: "work" }, "c2"),
				{ event: finished },
			],
		]);
		const session = await Session.start({
			backend,
			cwd,
			tools: createBackgroundTools({ sandbox: sandbox() }),
			subagents: { agents: BUILTIN_AGENTS, createBackend: async () => child },
		});
		const turn = (async () => {
			for await (const _event of session.send("start")) {
			}
		})();
		let pid = 0;
		await until(() => {
			pid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, "utf8"), 10) || 0 : 0;
			return pid > 0 && child.startOptions !== undefined;
		});
		await expect(session.close()).rejects.toThrow("child close failed");
		expect(session.jobs).toEqual({ running: 0, waiting: 0 });
		expect(() => process.kill(pid, 0)).toThrow();
		await turn;
	});
});

describe("a job's end outside any turn", () => {
	it("is saved with the session, so it is there when the session is resumed", async () => {
		const home = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-jobs-home-")));
		const record = new SessionStore(home).create(cwd);
		const heard: AtelierEventBody[] = [];
		const backend = new FakeBackend(
			[[call("bash_background", { command: waitsForGo() }, "c1"), { throw: "backend failed" }]],
			"anthropic-api",
		);
		const session = await Session.start({
			backend,
			cwd,
			tools: createBackgroundTools({ sandbox: sandbox() }),
			record,
			idleEvent: (event) => heard.push(event),
		});
		for await (const _event of session.send("start it")) {
		}
		await go();
		await until(() => heard.length === 1);
		await session.close();
		const loaded = await new SessionStore(home).load(cwd, record.id);
		expect(loaded.entries).toContainEqual({
			type: "event",
			event: expect.objectContaining({ type: "job_finished", jobId: "1", notified: true, waiting: 1 }),
		});
		await rm(home, { recursive: true, force: true });
	});

	it("is said when the job ends after the turn's last event and before the turn is over", async () => {
		const heard: AtelierEventBody[] = [];
		const backend = new FakeBackend([
			[call("bash_background", { command: waitsForGo() }, "c1"), { throw: "backend failed" }],
		]);
		const session = await Session.start({
			backend,
			cwd,
			tools: createBackgroundTools({ sandbox: sandbox() }),
			idleEvent: (event) => heard.push(event),
		});
		sessions.push(session);
		// The client holds the turn after its turn_finished: the turn's events are closed, the turn is not over yet.
		const turn = session.send("start it");
		for (let next = await turn.next(); !next.done && next.value.type !== "turn_finished"; next = await turn.next()) {}
		await go();
		await until(() => heard.length === 1);
		expect(heard[0]).toMatchObject({ type: "job_finished", jobId: "1", waiting: 1 });
		expect((await turn.next()).done).toBe(true);
	});
});
