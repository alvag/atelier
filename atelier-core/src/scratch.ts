import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Atelier's temporary directories. Each one is `atelier-<kind>-XXXXXX/` in the
 * system's temporary folder, holding an owner file with the pid and start time
 * of the process that made it, and `work/`, the only part its user sees. A
 * process that dies leaves them behind; the first one a process creates starts
 * a sweep, in the background, of those whose owner is gone.
 */
export type ScratchKind = "session" | "verify" | "freeze" | "bash" | "mcp";

/** `trash` is a stale directory moved aside to be deleted, left there only when its deletion failed. */
const NAME = /^atelier-(session|verify|freeze|bash|mcp|trash)-[A-Za-z0-9]{6}$/;
const OWNER_FILE = ".atelier-owner";
const WORK = "work";
/** `ps` counts whole seconds, and Node starts a little after its process: a later start within this is the same process. */
export const REUSED_PID_MARGIN_MS = 5000;
/** A directory without an owner file is from an older Atelier, or one being created: it waits this long. */
export const OWNERLESS_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PS_TIMEOUT_MS = 5000;

export interface ScratchDir {
	/** The directory to work in; empty when created. */
	path: string;
	/** Deletes the whole directory, owner file included; safe to call twice. */
	remove(): Promise<void>;
}

export interface ScratchOptions {
	/** The folder it is created in; the system's temporary folder by default. */
	tmpRoot?: string;
}

interface Owner {
	pid: number;
	/** Milliseconds since the epoch. */
	startedAt: number;
}

const self: Owner = { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000 };

/** The system's temporary folder as the user set it, also while `borrowTmpdir` points `tmpdir()` elsewhere. */
export function systemTmpdir(): string {
	return borrowed?.original ?? tmpdir();
}

/** The borrowing in progress, and what `tmpdir()` said before it. */
let borrowed: { original: string; done: Promise<void> } | undefined;
/** Directories being made and sweeps running in the system's temporary folder; a borrowing waits for them. */
let users = 0;
let idle: (() => void) | undefined;

/**
 * Runs `use` with the system's temporary folder, never while TMPDIR is borrowed:
 * it waits for a borrowing to end, and one that starts meanwhile waits for it.
 */
async function inSystemTmpdir<T>(use: (root: string) => Promise<T>): Promise<T> {
	while (borrowed !== undefined) await borrowed.done;
	users++;
	try {
		return await use(tmpdir());
	} finally {
		users--;
		if (users === 0) idle?.();
	}
}

export interface BorrowLimits {
	/** How long `run` may take; past it the folder is given back and the borrowing fails, while `run` goes on alone. */
	timeoutMs?: number;
	/** Gives the folder back at once and fails the borrowing, with the signal's reason. */
	signal?: AbortSignal;
}

/** `run` took longer than `BorrowLimits.timeoutMs`. */
export class BorrowTimeoutError extends Error {}

/**
 * Makes `tmpdir()` answer `dir` while `run` runs, and what it answered before
 * after it, even when it fails, times out or is aborted: for a library that puts
 * what it makes in the temporary folder, with no option for another place. Only
 * the function changes, never `process.env.TMPDIR`, so no child process started
 * meanwhile inherits `dir`. It starts once no directory is being made and no
 * sweep is running there, and those asked for meanwhile wait for it to end, so
 * none lands in `dir`, where the sweep of a later process would never look. A
 * synchronous one cannot wait: it goes in the folder `tmpdir()` answered before.
 */
export async function borrowTmpdir<T>(dir: string, run: () => Promise<T>, limits: BorrowLimits = {}): Promise<T> {
	while (borrowed !== undefined) await borrowed.done;
	limits.signal?.throwIfAborted();
	let end!: () => void;
	const current = {
		original: tmpdir(),
		done: new Promise<void>((resolve) => {
			end = resolve;
		}),
	};
	borrowed = current;
	const real = os.tmpdir;
	try {
		if (users > 0)
			await unlessAborted(
				new Promise<void>((resolve) => {
					idle = resolve;
				}),
				limits.signal,
			);
		idle = undefined;
		setTmpdir(() => dir);
		return await unlessAborted(withinTime(run(), limits.timeoutMs), limits.signal);
	} finally {
		idle = undefined;
		setTmpdir(real);
		borrowed = undefined;
		end();
	}
}

/** Replaces `os.tmpdir`, for the modules that imported it by name too. */
function setTmpdir(answer: () => string): void {
	os.tmpdir = answer;
	syncBuiltinESMExports();
}

function withinTime<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
	if (timeoutMs === undefined) return work;
	// What it does after the time is up is no longer anyone's to handle.
	work.catch(() => {});
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new BorrowTimeoutError(`did not finish within ${timeoutMs} ms`)), timeoutMs);
	});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	work.catch(() => {});
	let stop: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		stop = () => reject(signal.reason);
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => {
		if (stop) signal.removeEventListener("abort", stop);
	});
}

export async function createScratchDir(kind: ScratchKind, options: ScratchOptions = {}): Promise<ScratchDir> {
	const make = async (base: string) => {
		const root = await mkdtemp(join(base, `atelier-${kind}-`));
		try {
			await writeFile(join(root, OWNER_FILE), JSON.stringify(self));
			await mkdir(join(root, WORK));
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
		sweepOnce(base);
		return scratchAt(root);
	};
	return options.tmpRoot === undefined ? inSystemTmpdir(make) : make(options.tmpRoot);
}

/** The same, for callers that cannot wait. */
export function createScratchDirSync(kind: ScratchKind, options: ScratchOptions = {}): ScratchDir {
	const base = options.tmpRoot ?? systemTmpdir();
	const root = mkdtempSync(join(base, `atelier-${kind}-`));
	try {
		writeFileSync(join(root, OWNER_FILE), JSON.stringify(self));
		mkdirSync(join(root, WORK));
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	sweepOnce(base);
	return scratchAt(root);
}

function scratchAt(root: string): ScratchDir {
	return { path: join(root, WORK), remove: () => rm(root, { recursive: true, force: true }) };
}

let swept = false;

/**
 * Once per process, in the folder the first directory went in, after the
 * caller goes on: the sweep never delays it, and its failures are left for the
 * next process. `ATELIER_SCRATCH_SWEEP=off` stops it.
 */
function sweepOnce(tmpRoot: string): void {
	if (swept || process.env.ATELIER_SCRATCH_SWEEP === "off") return;
	swept = true;
	setImmediate(() => {
		sweepStaleScratch({ tmpRoot }).catch(() => {});
	}).unref();
}

/** What the sweep asks about the owners' processes. */
export interface ProcessReader {
	/** Undefined when it cannot be told: the directory is kept. */
	isAlive(pid: number): boolean | undefined;
	/** When a live process started, in milliseconds since the epoch; undefined when it cannot be told. */
	startedAt(pid: number): Promise<number | undefined>;
}

export interface SweepOptions extends ScratchOptions {
	/** The system's processes by default. */
	processes?: ProcessReader;
}

/** This process's own start is known exactly, so its directories never depend on `ps`. */
const systemProcesses: ProcessReader = {
	isAlive,
	startedAt: (pid) => (pid === self.pid ? Promise.resolve(self.startedAt) : processStart(pid)),
};

/**
 * Deletes the directories in the folder whose owner is dead, and returns them.
 * Only Atelier's names are looked at, and only real directories of this user;
 * whatever cannot be told for sure is kept, and a failed deletion is left for
 * the next sweep, with its owner file.
 */
export async function sweepStaleScratch(options: SweepOptions = {}): Promise<string[]> {
	return inSystemTmpdir((root) => sweepIn(options.tmpRoot ?? root, options));
}

async function sweepIn(root: string, options: SweepOptions): Promise<string[]> {
	const names = await readdir(root).catch(() => []);
	const removed: string[] = [];
	for (const name of names) {
		if (!NAME.test(name)) continue;
		const dir = join(root, name);
		try {
			const checked = await staleEvidence(dir, options.processes ?? systemProcesses);
			if (checked !== undefined && (await removeChecked(root, dir, checked))) removed.push(dir);
		} catch {
			// Kept for the next sweep.
		}
	}
	return removed;
}

/** What a directory was when it was found stale: the deletion goes ahead only on that same directory. */
interface Checked {
	info: Stats;
	/** The owner file's text; undefined when it had none. */
	owner: string | undefined;
}

/** The directory and its owner file as they are now, when it is stale; undefined when it is to be kept. */
async function staleEvidence(dir: string, processes: ProcessReader): Promise<Checked | undefined> {
	const info = await lstat(dir);
	if (!info.isDirectory()) return undefined;
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) return undefined;
	const text = await ownerText(dir);
	if (text === null) return undefined;
	if (text === undefined)
		return Date.now() - (await lastChange(dir, info.mtimeMs)) > OWNERLESS_AGE_MS
			? { info, owner: undefined }
			: undefined;
	const owner = parseOwner(text);
	if (owner === undefined) return undefined;
	const alive = processes.isAlive(owner.pid);
	if (alive === undefined) return undefined;
	if (!alive) return { info, owner: text };
	const started = await processes.startedAt(owner.pid);
	// A process that started after the directory was made reuses the pid of its dead owner.
	return started !== undefined && started > owner.startedAt + REUSED_PID_MARGIN_MS ? { info, owner: text } : undefined;
}

/** The owner file's text; undefined when there is none, null when it cannot be read. */
async function ownerText(dir: string): Promise<string | undefined | null> {
	try {
		return await readFile(join(dir, OWNER_FILE), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
	}
}

/**
 * Moves the directory aside with one rename, so that what is deleted cannot be
 * swapped in after the check, makes sure what moved is the real directory that
 * was checked, with the same owner file, and only then deletes it, the owner
 * file last. Anything else goes back where it was. A deletion that fails
 * part-way goes back too, owner file included, for the next sweep to judge again.
 */
async function removeChecked(root: string, dir: string, checked: Checked): Promise<boolean> {
	// An empty directory of its own, which the rename replaces: no other directory can be taken for it.
	const trash = await mkdtemp(join(root, "atelier-trash-"));
	try {
		await rename(dir, trash);
	} catch {
		await rmdir(trash).catch(() => {});
		return false;
	}
	if (!(await isChecked(trash, checked))) {
		await putBack(trash, dir);
		return false;
	}
	try {
		for (const name of await readdir(trash))
			if (name !== OWNER_FILE) await rm(join(trash, name), { recursive: true, force: true });
		await rm(join(trash, OWNER_FILE), { force: true });
		await rmdir(trash);
		return true;
	} catch {
		// A process left inside can write again between the owner file and rmdir: the owner file comes back first.
		if (checked.owner !== undefined)
			await writeFile(join(trash, OWNER_FILE), checked.owner, { flag: "wx" }).catch(() => {});
		await putBack(trash, dir);
		return false;
	}
}

async function isChecked(path: string, checked: Checked): Promise<boolean> {
	const info = await lstat(path).catch(() => undefined);
	if (info === undefined || !info.isDirectory()) return false;
	if (info.dev !== checked.info.dev || info.ino !== checked.info.ino || info.uid !== checked.info.uid) return false;
	return (await ownerText(path)) === checked.owner;
}

/** Back to its name unless something took it; otherwise it stays as trash, which the next sweep judges by its owner file. */
async function putBack(trash: string, dir: string): Promise<void> {
	const taken = await lstat(dir).then(
		() => true,
		(error: NodeJS.ErrnoException) => error.code !== "ENOENT",
	);
	if (!taken) await rename(trash, dir).catch(() => {});
}

/** The newest change of the directory or of what is right inside it: a file written into keeps the directory's own time. */
async function lastChange(dir: string, dirMtimeMs: number): Promise<number> {
	let newest = dirMtimeMs;
	for (const name of await readdir(dir)) {
		const info = await lstat(join(dir, name)).catch(() => undefined);
		if (info !== undefined) newest = Math.max(newest, info.mtimeMs);
	}
	return newest;
}

function parseOwner(text: string): Owner | undefined {
	try {
		const value = JSON.parse(text) as Partial<Owner>;
		if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
		if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return undefined;
		return { pid: value.pid, startedAt: value.startedAt };
	} catch {
		return undefined;
	}
}

/**
 * Signal 0 only asks. Only ESRCH means the process is gone; EPERM (a process
 * of another user) and any other answer cannot be told, nor can anything on
 * Windows, where the pid cannot be checked against a start time.
 */
function isAlive(pid: number): boolean | undefined {
	if (process.platform === "win32") return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined;
	}
}

/**
 * From the time `ps` says the process has run, `[[dd-]hh:]mm:ss`; undefined
 * where there is no `ps`. The clock is read before `ps` runs, so a slow `ps` or
 * a busy event loop make the start look earlier, never later: the errors keep a
 * directory, and only the whole second `ps` cuts off makes it up to 1 s later.
 */
function processStart(pid: number): Promise<number | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	const asked = Date.now();
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-o", "etime=", "-p", String(pid)],
			{ env: { ...process.env, LC_ALL: "C" }, timeout: PS_TIMEOUT_MS },
			(error, stdout) => {
				const seconds = error ? undefined : elapsedSeconds(stdout.trim());
				resolve(seconds === undefined ? undefined : asked - seconds * 1000);
			},
		);
	});
}

function elapsedSeconds(text: string): number | undefined {
	const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
	if (!match) return undefined;
	const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
	return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}
