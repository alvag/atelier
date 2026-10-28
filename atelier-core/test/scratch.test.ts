import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createScratchDir,
	createScratchDirSync,
	OWNERLESS_AGE_MS,
	type ProcessReader,
	REUSED_PID_MARGIN_MS,
	sweepStaleScratch,
} from "../src/scratch.ts";

let root: string;
const children: ChildProcess[] = [];

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** A directory named as Atelier names them, with an owner file holding `owner`, or none. */
async function fakeScratch(name: string, owner?: unknown): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, "work"), { recursive: true });
	await writeFile(join(dir, "work", "output.log"), "kept until the owner dies\n");
	if (owner !== undefined)
		await writeFile(join(dir, ".atelier-owner"), typeof owner === "string" ? owner : JSON.stringify(owner));
	return dir;
}

/** Processes that are alive, by pid, with when they started; any other pid is dead. */
function processes(live: Record<number, number | undefined>): ProcessReader {
	return {
		isAlive: (pid) => pid in live,
		startedAt: async (pid) => live[pid],
	};
}

/** Waits for a condition instead of a fixed delay. */
async function until(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A sweep that was started has had this long to delete an old directory, which takes milliseconds. */
const NO_SWEEP_WINDOW_MS = 200;
const settle = () => new Promise((resolve) => setTimeout(resolve, NO_SWEEP_WINDOW_MS));

/** An old directory without an owner file: what any sweep deletes, whatever the system's processes are. */
async function abandoned(name: string): Promise<string> {
	const dir = await fakeScratch(name);
	const then = new Date(Date.now() - OWNERLESS_AGE_MS - 60_000);
	await utimes(join(dir, "work", "output.log"), then, then);
	await utimes(join(dir, "work"), then, then);
	await utimes(dir, then, then);
	return dir;
}

const LIVE = 4242;
const DEAD = 4343;
const T = 1_700_000_000_000;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-scratch-test-"));
});
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
});

describe("createScratchDir", () => {
	it("gives an empty directory that the owner file is not part of, and removes it all", async () => {
		const scratch = await createScratchDir("session", { tmpRoot: root });
		expect(await readdir(scratch.path)).toEqual([]);
		const [name] = await readdir(root);
		expect(name).toMatch(/^atelier-session-[A-Za-z0-9]{6}$/);
		expect((await readdir(join(root, name as string))).sort()).toEqual([".atelier-owner", "work"]);

		await scratch.remove();
		await scratch.remove();
		expect(await readdir(root)).toEqual([]);
	});

	it("has a synchronous form, owned by this process", async () => {
		const scratch = createScratchDirSync("bash", { tmpRoot: root });
		expect(await readdir(scratch.path)).toEqual([]);
		const removed = await sweepStaleScratch({ tmpRoot: root, processes: processes({ [process.pid]: undefined }) });
		expect(removed).toEqual([]);
		expect(await exists(scratch.path)).toBe(true);
	});
});

describe("the sweep that the first directory starts", () => {
	const SWITCH = "ATELIER_SCRATCH_SWEEP";
	let previous: string | undefined;
	beforeEach(() => {
		previous = process.env[SWITCH];
		vi.resetModules();
	});
	afterEach(() => {
		if (previous === undefined) delete process.env[SWITCH];
		else process.env[SWITCH] = previous;
	});

	it("runs once per process, in the background, on the folder the directory went in", async () => {
		delete process.env[SWITCH];
		const scratch = await import("../src/scratch.ts");
		const first = await abandoned("atelier-session-aaaaaa");
		const created = await scratch.createScratchDir("session", { tmpRoot: root });
		await until(async () => !(await exists(first)));
		expect(await exists(created.path)).toBe(true);

		const second = await abandoned("atelier-session-bbbbbb");
		scratch.createScratchDirSync("bash", { tmpRoot: root });
		await settle();
		expect(await exists(second)).toBe(true);
	});

	it("does not run while ATELIER_SCRATCH_SWEEP is off", async () => {
		process.env[SWITCH] = "off";
		const scratch = await import("../src/scratch.ts");
		const old = await abandoned("atelier-verify-cccccc");
		await scratch.createScratchDir("verify", { tmpRoot: root });
		scratch.createScratchDirSync("bash", { tmpRoot: root });
		await settle();
		expect(await exists(old)).toBe(true);

		delete process.env[SWITCH];
		await scratch.createScratchDir("freeze", { tmpRoot: root });
		await until(async () => !(await exists(old)));
	});
});

describe("sweepStaleScratch", () => {
	it("deletes the directories of a dead owner and keeps those of a live one", async () => {
		const alive = await fakeScratch("atelier-session-aaaaaa", { pid: LIVE, startedAt: T });
		const gone = await fakeScratch("atelier-verify-bbbbbb", { pid: DEAD, startedAt: T });
		const goneFreeze = await fakeScratch("atelier-freeze-cccccc", { pid: DEAD, startedAt: T });
		const goneBash = await fakeScratch("atelier-bash-cccccc", { pid: DEAD, startedAt: T });

		const removed = await sweepStaleScratch({ tmpRoot: root, processes: processes({ [LIVE]: T }) });

		expect(removed.sort()).toEqual([goneBash, goneFreeze, gone].sort());
		for (const dir of [gone, goneFreeze, goneBash]) expect(await exists(dir)).toBe(false);
		expect(await exists(join(alive, "work", "output.log"))).toBe(true);
	});

	it("takes a pid as reused only when its process started more than the margin after the owner", async () => {
		const atMargin = await fakeScratch("atelier-session-eeeeee", { pid: LIVE, startedAt: T });
		const pastMargin = await fakeScratch("atelier-session-ffffff", { pid: LIVE, startedAt: T - 1 });

		const removed = await sweepStaleScratch({
			tmpRoot: root,
			processes: processes({ [LIVE]: T + REUSED_PID_MARGIN_MS }),
		});

		expect(removed).toEqual([pastMargin]);
		expect(await exists(atMargin)).toBe(true);
	});

	it("keeps this process's own directories, without asking ps", async () => {
		const mine = await createScratchDir("verify", { tmpRoot: root });
		const before = await fakeScratch("atelier-session-tttttt", {
			pid: process.pid,
			startedAt: Date.now() - process.uptime() * 1000 - REUSED_PID_MARGIN_MS - 60_000,
		});
		const removed = await sweepStaleScratch({ tmpRoot: root });
		expect(removed).toEqual([before]);
		expect(await exists(mine.path)).toBe(true);
	});

	it("keeps the owner file of a deletion that fails part-way, so the next sweep deletes the rest", async () => {
		const dir = await fakeScratch("atelier-verify-rrrrrr", { pid: DEAD, startedAt: T });
		const locked = join(dir, "work", "locked");
		await mkdir(locked);
		await writeFile(join(locked, "file"), "x\n");
		await chmod(locked, 0o500);
		try {
			expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({}) })).toEqual([]);
			expect(await exists(join(dir, ".atelier-owner"))).toBe(true);
		} finally {
			await chmod(locked, 0o700);
		}
		expect(await readdir(root)).toEqual(["atelier-verify-rrrrrr"]);
		expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({}) })).toEqual([dir]);
		expect(await readdir(root)).toEqual([]);
	});

	it("lets two sweeps run at once over the same folder, each directory deleted by one of them", async () => {
		const dirs: string[] = [];
		for (const letter of "abcdefgh")
			dirs.push(await fakeScratch(`atelier-session-${letter.repeat(6)}`, { pid: DEAD, startedAt: T }));
		const live = await fakeScratch("atelier-session-zzzzzz", { pid: LIVE, startedAt: T });

		const [first, second] = await Promise.all([
			sweepStaleScratch({ tmpRoot: root, processes: processes({ [LIVE]: T }) }),
			sweepStaleScratch({ tmpRoot: root, processes: processes({ [LIVE]: T }) }),
		]);

		expect([...first, ...second].sort()).toEqual(dirs.sort());
		expect(await readdir(root)).toEqual(["atelier-session-zzzzzz"]);
		expect(await exists(join(live, "work", "output.log"))).toBe(true);
	});

	it("deletes a directory moved aside by a sweep that could not finish", async () => {
		const trash = await fakeScratch("atelier-trash-uuuuuu", { pid: DEAD, startedAt: T });
		expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({}) })).toEqual([trash]);
		expect(await readdir(root)).toEqual([]);
	});

	it("keeps a directory without an owner while a file in it is recent, even if the directory is old", async () => {
		const dir = join(root, "atelier-session-ssssss");
		await mkdir(dir);
		await writeFile(join(dir, "bash-1.log"), "written today\n");
		const then = new Date(Date.now() - OWNERLESS_AGE_MS - 60_000);
		await utimes(dir, then, then);

		expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({}) })).toEqual([]);
		expect(await exists(join(dir, "bash-1.log"))).toBe(true);
	});

	it("keeps a live owner whose start time cannot be read", async () => {
		const dir = await fakeScratch("atelier-session-gggggg", { pid: LIVE, startedAt: 0 });
		expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({ [LIVE]: undefined }) })).toEqual([]);
		expect(await exists(dir)).toBe(true);
	});

	it("deletes a directory without an owner only once it is old", async () => {
		const fresh = await fakeScratch("atelier-session-hhhhhh");
		const old = await abandoned("atelier-verify-iiiiii");

		expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({}) })).toEqual([old]);
		expect(await exists(fresh)).toBe(true);
	});

	it("touches nothing that is not an Atelier directory with a dead owner", async () => {
		const owner = { pid: DEAD, startedAt: 0 };
		const then = new Date(Date.now() - OWNERLESS_AGE_MS - 60_000);
		const others = [
			await fakeScratch("atelier-session-profile-jjjjjj", owner),
			await fakeScratch("atelier-other-kkkkkk", owner),
			await fakeScratch("atelier-session-llllllx", owner),
			await fakeScratch("atelier-session-mmmmmm", "not json"),
			await fakeScratch("atelier-session-nnnnnn", { pid: 0, startedAt: 0 }),
			await fakeScratch("atelier-session-oooooo", { pid: -1, startedAt: 0 }),
		];
		for (const dir of others) await utimes(dir, then, then);
		const target = await fakeScratch("elsewhere", owner);
		await symlink(target, join(root, "atelier-session-pppppp"));
		await writeFile(join(root, "atelier-bash-qqqqqq"), "a file\n");

		expect(await sweepStaleScratch({ tmpRoot: root, processes: processes({}) })).toEqual([]);
		for (const dir of others) expect(await exists(join(dir, "work", "output.log"))).toBe(true);
		expect(await exists(join(target, "work", "output.log"))).toBe(true);
		expect(await exists(join(root, "atelier-bash-qqqqqq"))).toBe(true);
	});

	it("finds nothing in a folder that does not exist", async () => {
		expect(await sweepStaleScratch({ tmpRoot: join(root, "missing") })).toEqual([]);
	});
});

/** The sandbox Atelier's own bash runs in does not let `ps` run; outside it these run too. */
const psRuns = spawnSync("ps", ["-o", "etime=", "-p", String(process.pid)]).status === 0;

describe.skipIf(!psRuns)("sweepStaleScratch with the system's processes", () => {
	/** A process that is alive until the test ends. */
	async function liveProcess(): Promise<number> {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		children.push(child);
		await new Promise((resolve) => child.once("spawn", resolve));
		return child.pid as number;
	}

	/** The pid of a process that has exited. */
	async function deadProcess(): Promise<number> {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await new Promise((resolve) => child.once("exit", resolve));
		return child.pid as number;
	}

	it("deletes what a dead process left and what a reused pid's owner left, and keeps a live owner's", async () => {
		const live = await liveProcess();
		const dead = await deadProcess();
		const mine = await createScratchDir("verify", { tmpRoot: root });
		const alive = await fakeScratch("atelier-session-aaaaaa", { pid: live, startedAt: Date.now() });
		const gone = await fakeScratch("atelier-verify-bbbbbb", { pid: dead, startedAt: Date.now() - 60_000 });
		const reused = await fakeScratch("atelier-session-dddddd", { pid: live, startedAt: Date.now() - 3_600_000 });

		const removed = await sweepStaleScratch({ tmpRoot: root });

		expect(removed.sort()).toEqual([reused, gone].sort());
		expect(await exists(join(alive, "work", "output.log"))).toBe(true);
		expect(await exists(mine.path)).toBe(true);
	});
});
