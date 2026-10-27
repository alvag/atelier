import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Atelier's temporary directories. Each one is `atelier-<kind>-XXXXXX/` in the
 * system's temporary folder, holding an owner file with the pid and start time
 * of the process that made it, and `work/`, the only part its user sees. A
 * process that dies leaves them behind; the first one a process creates starts
 * a sweep, in the background, of those whose owner is gone.
 */
export type ScratchKind = "session" | "verify" | "freeze" | "bash";

const NAME = /^atelier-(session|verify|freeze|bash)-[A-Za-z0-9]{6}$/;
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

export async function createScratchDir(kind: ScratchKind, options: ScratchOptions = {}): Promise<ScratchDir> {
	const root = await mkdtemp(join(options.tmpRoot ?? tmpdir(), `atelier-${kind}-`));
	try {
		await writeFile(join(root, OWNER_FILE), JSON.stringify(self));
		await mkdir(join(root, WORK));
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
	sweepOnce();
	return scratchAt(root);
}

/** The same, for callers that cannot wait. */
export function createScratchDirSync(kind: ScratchKind, options: ScratchOptions = {}): ScratchDir {
	const root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `atelier-${kind}-`));
	try {
		writeFileSync(join(root, OWNER_FILE), JSON.stringify(self));
		mkdirSync(join(root, WORK));
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	sweepOnce();
	return scratchAt(root);
}

function scratchAt(root: string): ScratchDir {
	return { path: join(root, WORK), remove: () => rm(root, { recursive: true, force: true }) };
}

let swept = false;

/** Once per process, after the caller goes on: the sweep never delays it, and its failures are left for the next process. */
function sweepOnce(): void {
	if (swept) return;
	swept = true;
	setImmediate(() => {
		sweepStaleScratch().catch(() => {});
	}).unref();
}

/** What the sweep asks about the owners' processes. */
export interface ProcessReader {
	isAlive(pid: number): boolean;
	/** When a live process started, in milliseconds since the epoch; undefined when it cannot be told. */
	startedAt(pid: number): Promise<number | undefined>;
}

export interface SweepOptions extends ScratchOptions {
	/** The system's processes by default. */
	processes?: ProcessReader;
}

const systemProcesses: ProcessReader = { isAlive, startedAt: processStart };

/**
 * Deletes the directories in the folder whose owner is dead, and returns them.
 * Only Atelier's names are looked at, and only real directories of this user;
 * whatever cannot be told for sure is kept, and a failed deletion is left for
 * the next sweep.
 */
export async function sweepStaleScratch(options: SweepOptions = {}): Promise<string[]> {
	const root = options.tmpRoot ?? tmpdir();
	const names = await readdir(root).catch(() => []);
	const removed: string[] = [];
	for (const name of names) {
		if (!NAME.test(name)) continue;
		const dir = join(root, name);
		try {
			if (!(await isStale(dir, options.processes ?? systemProcesses))) continue;
			await rm(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch {
			// Kept for the next sweep.
		}
	}
	return removed;
}

async function isStale(dir: string, processes: ProcessReader): Promise<boolean> {
	const info = await lstat(dir);
	if (!info.isDirectory()) return false;
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) return false;
	let text: string;
	try {
		text = await readFile(join(dir, OWNER_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		return Date.now() - info.mtimeMs > OWNERLESS_AGE_MS;
	}
	const owner = parseOwner(text);
	if (owner === undefined) return false;
	if (!processes.isAlive(owner.pid)) return true;
	const started = await processes.startedAt(owner.pid);
	// A process that started after the directory was made reuses the pid of its dead owner.
	return started !== undefined && started > owner.startedAt + REUSED_PID_MARGIN_MS;
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

/** Signal 0 only asks: a process of another user answers EPERM, and is alive. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** From the time `ps` says the process has run, `[[dd-]hh:]mm:ss`; undefined where there is no `ps`. */
function processStart(pid: number): Promise<number | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-o", "etime=", "-p", String(pid)],
			{ env: { ...process.env, LC_ALL: "C" }, timeout: PS_TIMEOUT_MS },
			(error, stdout) => {
				const seconds = error ? undefined : elapsedSeconds(stdout.trim());
				resolve(seconds === undefined ? undefined : Date.now() - seconds * 1000);
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
