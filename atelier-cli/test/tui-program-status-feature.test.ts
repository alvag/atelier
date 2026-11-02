import { EventEmitter } from "node:events";
import type { FeatureTask } from "@atelier/core";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramStatusReporter } from "../src/tui/program-status.ts";
import { observeProgramStatus } from "../src/tui/program-status-terminal.ts";

const REPLY = "\x1b]7501;?\x07";
const osc = (body: string) => `\x1b]7501;${body}\x1b\\`;
const plain = (state: string) => `plain:${state}`;
const CLEAR = plain("clear");
const task = (status: FeatureTask["status"]) => ({ status }) as FeatureTask;
const tasks = (done: number, open: number, dropped = 0) => [
	...Array.from({ length: done }, () => task("done")),
	...Array.from({ length: open }, () => task("pending")),
	...Array.from({ length: dropped }, () => task("dropped")),
];

/** A terminal that caches its last root and tells it again after a reply or on start, like ProcessTerminal. */
function setup(env = "") {
	process.env.PI_PROGRAM_STATUS = env;
	if (env === "") delete process.env.PI_PROGRAM_STATUS;
	const input = Object.assign(new EventEmitter(), { setEncoding() {}, resume() {}, pause() {} });
	const out: string[] = [];
	let cache: ProgramStatus | undefined;
	let supported = false;
	let queryPending = false;
	const tell = (status: ProgramStatus) => out.push(plain(status.state));
	const fake = {
		start() {
			supported = process.env.PI_PROGRAM_STATUS === "1";
			queryPending = !supported && process.env.PI_PROGRAM_STATUS !== "0";
			input.on("data", onData);
			if (supported && cache) tell(cache);
		},
		stop() {
			input.removeListener("data", onData);
			if (supported && cache) tell({ state: "clear" });
			supported = false;
		},
		write: (data: string) => out.push(data),
		setProgramStatus(status: ProgramStatus) {
			cache = status.state === "clear" ? undefined : status;
			if (supported) tell(status);
		},
	};
	const onData = (data: string) => {
		if (!queryPending || data !== REPLY) return;
		queryPending = false;
		supported = true;
		if (cache) tell(cache);
	};
	const terminal = observeProgramStatus(fake as unknown as Terminal, input as unknown as NodeJS.ReadStream);
	const reporter = new ProgramStatusReporter(terminal, 500);
	const reply = () => input.emit("data", REPLY);
	terminal.start(
		() => {},
		() => {},
	);
	return { out, reporter, reply, terminal };
}

describe("ProgramStatusReporter feature progress", () => {
	const env = process.env.PI_PROGRAM_STATUS;
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		if (env === undefined) delete process.env.PI_PROGRAM_STATUS;
		else process.env.PI_PROGRAM_STATUS = env;
	});

	it("tells the floor of done over counted tasks as one root record", () => {
		const { out, reporter, reply } = setup();
		reply();
		reporter.feature(tasks(3, 5));
		reporter.report("working", { message: "x" });
		vi.advanceTimersByTime(500);
		reporter.feature(tasks(4, 4));
		reporter.report("working", { message: "x" });
		vi.advanceTimersByTime(500);
		reporter.feature(tasks(4, 3, 1));
		reporter.report("working", { message: "x" });
		vi.advanceTimersByTime(500);
		reporter.feature(tasks(0, 2));
		reporter.report("blocked", { kind: "question", message: "x" });
		expect(out).toEqual([
			osc("state=working:app=atelier:progress=37:msg=eA=="),
			osc("state=working:app=atelier:progress=50:msg=eA=="),
			osc("state=working:app=atelier:progress=57:msg=eA=="),
			osc(`state=blocked:app=atelier:kind=question:progress=0:msg=eA==`),
		]);
	});

	it("tells no progress for no feature, only dropped tasks, or settled states", () => {
		const { out, reporter, reply } = setup();
		reply();
		reporter.report("working");
		reporter.feature(tasks(0, 0, 2));
		reporter.report("working", { message: "a" });
		vi.advanceTimersByTime(500);
		reporter.feature(tasks(1, 1));
		reporter.report("done");
		reporter.report("error");
		reporter.report("idle");
		reporter.clear();
		expect(out).toEqual([plain("working"), plain("working"), plain("done"), plain("error"), plain("idle"), CLEAR]);
	});

	it("does not tell by itself and keeps the legacy root when the terminal never answered", () => {
		const { out, reporter } = setup();
		reporter.feature(tasks(1, 1));
		reporter.report("working", { message: "a" });
		reporter.feature(tasks(2, 1));
		reporter.report("working", { message: "a" });
		vi.advanceTimersByTime(1000);
		reporter.feature(tasks(3, 1));
		expect(out).toEqual([]);
	});

	it("sends the legacy root once for progress-only changes with a forced terminal", () => {
		const { out, reporter } = setup("1");
		const statuses: ProgramStatus[] = [];
		const base = { setProgramStatus: (s: ProgramStatus) => statuses.push(s) } as unknown as Terminal;
		const bare = new ProgramStatusReporter(base, 500);
		reporter.feature(tasks(1, 3));
		reporter.report("working", { message: "a" });
		reporter.feature(tasks(2, 2));
		reporter.report("working", { message: "a" });
		vi.advanceTimersByTime(1000);
		bare.feature(tasks(1, 3));
		bare.report("working", { message: "a" });
		bare.feature(tasks(2, 2));
		bare.report("working", { message: "a" });
		vi.advanceTimersByTime(1000);
		expect(out).toEqual([plain("working")]);
		expect(statuses).toEqual([{ state: "working", app: "atelier", message: "a" }]);
	});

	it("holds a progress-only change to the working interval, and drops it after a change of state", () => {
		const { out, reporter, reply } = setup();
		reply();
		reporter.feature(tasks(1, 3));
		reporter.report("working");
		reporter.feature(tasks(2, 2));
		reporter.report("working");
		expect(out).toEqual([osc("state=working:app=atelier:progress=25")]);
		vi.advanceTimersByTime(500);
		expect(out).toEqual([osc("state=working:app=atelier:progress=25"), osc("state=working:app=atelier:progress=50")]);
		reporter.feature(tasks(3, 1));
		reporter.report("working");
		reporter.report("done");
		vi.advanceTimersByTime(5000);
		expect(out.slice(2)).toEqual([plain("done")]);
	});

	it("falls back to a plain root when a held progress report is told after the answer is lost", () => {
		const { out, reporter, reply, terminal } = setup();
		reply();
		reporter.feature(tasks(1, 3));
		reporter.report("working");
		reporter.report("working", { message: "b" });
		terminal.stop();
		vi.advanceTimersByTime(500);
		expect(out).toEqual([osc("state=working:app=atelier:progress=25"), CLEAR]);
		terminal.start(
			() => {},
			() => {},
		);
		reply();
		expect(out.slice(2)).toEqual([plain("working")]);
	});

	it("counts every non-dropped status and reaches 100 when all tasks are done", () => {
		const { out, reporter, reply } = setup();
		reply();
		reporter.feature(["done", undefined, "unknown", "pending", "blocked", "in_progress", "dropped"].map(task));
		reporter.report("working");
		vi.advanceTimersByTime(500);
		reporter.feature(tasks(2, 0));
		reporter.report("working");
		expect(out).toEqual([osc("state=working:app=atelier:progress=16"), osc("state=working:app=atelier:progress=100")]);
	});
});
