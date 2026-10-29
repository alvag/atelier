import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BACKGROUND_TASKS } from "../src/subagents/definitions.ts";
import { BackgroundTasks, type EndedTask, type TaskInfo } from "../src/subagents/tasks.ts";
import { createBackgroundTools } from "../src/tools/background.ts";

let dir: string;
let ended: EndedTask[];
let started: TaskInfo[];
let tasks: BackgroundTasks;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "atelier-tasks-"));
	ended = [];
	started = [];
	tasks = new BackgroundTasks({
		scratchDir: dir,
		onStarted: (task) => started.push(task),
		onEnded: (end) => ended.push(end),
	});
});
afterEach(async () => {
	await tasks.stopAll();
	await rm(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

/** A run that waits until it is stopped. */
const untilStopped = (signal: AbortSignal) =>
	new Promise<{ ok: false; error: string }>((resolve) =>
		signal.addEventListener("abort", () => resolve({ ok: false, error: "interrupted" }), { once: true }),
	);

const [jobList, jobStop] = createBackgroundTools().slice(1);

describe("background tasks", () => {
	it("tells the end of a task with its report quoted, and keeps the report in its file", async () => {
		const task = tasks.reserve().start({
			agent: "explorer",
			prompt: "Find the code\nwith details",
			run: async (_signal, log) => {
				log("- read src/a.ts");
				return { ok: true, report: "Found it at a.ts:3", costUsd: 0.25 };
			},
		});
		expect(task).toMatchObject({ id: "task-1", agent: "explorer", label: "Find the code", status: "running" });
		expect(started).toEqual([expect.objectContaining({ id: "task-1" })]);
		await until(() => ended.length === 1);
		expect(ended[0]?.task).toMatchObject({ status: "finished", costUsd: 0.25 });
		expect(ended[0]?.notice?.text).toMatch(
			/^Background task task-1 \(explorer, "Find the code"\) finished after \d+s \(cost \$0\.25\)\.\nIts whole report: \S+task-1\.md\n[^\n]+\n<subagent_report>\nFound it at a\.ts:3\n<\/subagent_report>$/,
		);
		expect(ended[0]?.notice?.short).toMatch(/did not fit with the other notices: read it at \S+task-1\.md$/);
		const file = readFileSync(task.outputPath, "utf8");
		expect(file).toContain("- read src/a.ts");
		expect(file).toContain("## Report\n\nFound it at a.ts:3");
	});

	it("refuses a task past the cap until a place is given back", () => {
		const places = Array.from({ length: MAX_BACKGROUND_TASKS }, () => tasks.reserve());
		expect(() => tasks.reserve()).toThrow(
			`Refused: ${MAX_BACKGROUND_TASKS} background tasks are running; stop one with job_stop or wait for one to end.`,
		);
		places[0]?.release();
		expect(() => tasks.reserve().release()).not.toThrow();
		for (const place of places) place.release();
	});

	it("waits for a task being started before the close goes on, and refuses to start it once the close began", async () => {
		const place = tasks.reserve();
		let closed = false;
		const closing = tasks.stopAll().then(() => (closed = true));
		await new Promise((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		expect(() => place.start({ agent: "explorer", prompt: "p", run: untilStopped })).toThrow(
			"Refused: the session is closing.",
		);
		expect(closed).toBe(false);
		place.release();
		await closing;
		expect(started).toEqual([]);
	});

	it("lists tasks with job_list and stops one with job_stop, which sends no notice", async () => {
		tasks.reserve().start({ agent: "worker", label: "fix", prompt: "p", run: untilStopped });
		const listed = await jobList?.execute({}, { cwd: dir, tasks });
		expect(listed?.output).toMatch(/^task-1\s+running\s+\d+s\s+worker: fix\s+\S+task-1\.md$/);
		const stopped = await jobStop?.execute({ id: "task-1" }, { cwd: dir, tasks });
		expect(stopped?.output).toMatch(/^Stopped task task-1 \("fix"\) after \d+s; no notice follows\.$/);
		expect(ended).toEqual([{ task: expect.objectContaining({ id: "task-1", status: "stopped" }) }]);
		const again = await jobStop?.execute({ id: "task-1" }, { cwd: dir, tasks });
		expect(again?.output).toBe("Task task-1 already ended (stopped).");
		const unknown = await jobStop?.execute({ id: "task-9" }, { cwd: dir, tasks });
		expect(unknown).toMatchObject({ ok: false, output: "No job or task task-9." });
	});

	it("says why a task failed, and refuses new ones once every task was stopped for the close", async () => {
		tasks.reserve().start({ agent: "explorer", prompt: "p", run: async () => ({ ok: false, error: "no report" }) });
		await until(() => ended.length === 1);
		expect(ended[0]?.notice?.text).toMatch(/^Background task task-1 \(explorer, "p"\) failed after \d+s: no report\n/);
		await tasks.stopAll();
		expect(() => tasks.reserve()).toThrow("Refused: the session is closing.");
	});
});
