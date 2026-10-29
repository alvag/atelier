import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The variable every process of a job inherits, with a value of its own: a descendant that left the job's process
 * group (`setsid`, `spawn(..., { detached: true })`) and whose parent is gone is still found by it. macOS does not show
 * the environment of its own signed programs (`/bin/sleep`), and a process may clear it: such a one is found only
 * while a process of the job is still its ancestor.
 */
export const JOB_MARK = "ATELIER_JOB";

/** Rounds of looking and killing: a process may start another while the last round kills. */
const ROUNDS = 5;

/** One process of a listing: its id, its parent, its group, and whether it carries the job's mark. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	marked: boolean;
}

/** How long a listing may take; after it the sweep goes on as without one, so a stop is not held by a slow `ps`. */
export const LIST_TIMEOUT_MS = 2000;

/** What a sweep did: the pids it signaled, and whether every listing it asked for answered in time. */
export interface Swept {
	signaled: number[];
	listed: boolean;
}

/**
 * Signals every process of a job: those in its process group, those carrying its mark, and every descendant of either,
 * found in one listing so a parent that dies first does not hide its children. SIGKILL goes round after round until
 * none is left; another signal goes once. Never signals the process that runs it. Answers every pid it signaled, for
 * a caller that must escalate later, when a parent that died may no longer lead to them. Best effort: without a process
 * listing (a sandbox refuses `ps`, or it does not answer within LIST_TIMEOUT_MS) it finds nothing and the group's own
 * signal is all there is.
 */
export async function sweepJob(
	pgid: number,
	mark: string,
	signal: NodeJS.Signals = "SIGKILL",
	list: ProcessList = listProcesses,
): Promise<Swept> {
	const entry = `${JOB_MARK}=${mark}`;
	const rounds = signal === "SIGKILL" ? ROUNDS : 1;
	const signaled = new Set<number>();
	for (let round = 0; round < rounds; round++) {
		const rows = await within(list(entry), LIST_TIMEOUT_MS);
		if (rows === undefined) return { signaled: [...signaled], listed: false };
		const pids = jobProcesses(rows, pgid);
		if (pids.length === 0) break;
		for (const pid of pids) {
			signaled.add(pid);
			try {
				process.kill(pid, signal);
			} catch {}
		}
	}
	return { signaled: [...signaled], listed: true };
}

/** What `work` answers within `ms`, or undefined; a failure counts as no answer. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([work.catch(() => undefined), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** The job's processes in one listing: the group and the marked ones, then their descendants by parent. */
function jobProcesses(rows: readonly ProcessRow[], pgid: number): number[] {
	const found = new Set(rows.filter((row) => row.pgid === pgid || row.marked).map((row) => row.pid));
	for (let grew = true; grew; ) {
		grew = false;
		for (const row of rows)
			if (!found.has(row.pid) && found.has(row.ppid)) {
				found.add(row.pid);
				grew = true;
			}
	}
	found.delete(process.pid);
	return [...found];
}

/** Lists the processes, telling those whose environment holds `entry`: the system's listing, or a test's. */
export type ProcessList = (entry: string) => Promise<ProcessRow[]>;

async function listProcesses(entry: string): Promise<ProcessRow[]> {
	return process.platform === "linux" ? procProcesses(entry) : psProcesses(entry);
}

/** `ps -E` adds each process's environment, when it may be read, after its command line. */
async function psProcesses(entry: string): Promise<ProcessRow[]> {
	const listing = await new Promise<string>((resolve) => {
		try {
			execFile(
				"/bin/ps",
				["-A", "-E", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "command="],
				{ maxBuffer: 64 * 1024 * 1024, timeout: LIST_TIMEOUT_MS },
				(_error, stdout) => resolve(stdout ?? ""),
			);
		} catch {
			// A sandbox that refuses to run `ps` makes the spawn throw at once.
			resolve("");
		}
	});
	const rows: ProcessRow[] = [];
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			pgid: Number(match[3]),
			marked: ` ${match[4]} `.includes(` ${entry} `),
		});
	}
	return rows;
}

/** Files of /proc read at once: enough to list fast, few enough never to run out of descriptors. */
const PROC_READS = 32;

/** Reads a text file; tests pass a slow or failing one. */
export type ReadText = (path: string, encoding: BufferEncoding) => Promise<string>;

/** A read of /proc that failed because the process ended meanwhile, or because its environment is another user's. */
const USUAL_PROC_ERRORS = new Set(["ENOENT", "ESRCH", "EACCES", "EPERM"]);

/**
 * The processes as Linux's `/proc` (or a tree laid out like it, under `root`) says them, read without blocking and at
 * most PROC_READS files at once, so a read that does not answer leaves the sweep's timeout to run. A process that ended
 * during the listing is left out, and one whose environment cannot be read is taken as unmarked; any other failure
 * (out of descriptors, say) rejects, since the listing would miss what it could not read.
 */
export async function procProcesses(entry: string, root = "/proc", read: ReadText = readFile): Promise<ProcessRow[]> {
	let names: string[] = [];
	try {
		names = (await readdir(root)).filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
	const usual = (error: unknown) => USUAL_PROC_ERRORS.has((error as NodeJS.ErrnoException)?.code ?? "");
	const rows: ProcessRow[] = [];
	let next = 0;
	const reader = async () => {
		for (let name = names[next++]; name !== undefined; name = names[next++]) {
			let stat: string;
			try {
				stat = await read(`${root}/${name}/stat`, "utf8");
			} catch (error) {
				if (usual(error)) continue;
				throw error;
			}
			let environ = "";
			try {
				environ = await read(`${root}/${name}/environ`, "latin1");
			} catch (error) {
				if (!usual(error)) throw error;
			}
			// The fields after the command name, which may hold spaces and parentheses: state, ppid, pgrp.
			const [, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			rows.push({
				pid: Number(name),
				ppid: Number(ppid),
				pgid: Number(pgid),
				marked: environ.split("\0").includes(entry),
			});
		}
	};
	// Two reads of one process come one after the other: PROC_READS readers, PROC_READS files at once.
	await Promise.all(Array.from({ length: Math.min(PROC_READS, names.length) }, reader));
	return rows.sort((a, b) => a.pid - b.pid);
}

/** The watcher of a job runs this file when Atelier is gone: `node job-sweep.ts <pgid> <mark>`. */
export const SWEEP_SCRIPT = fileURLToPath(import.meta.url);

if (process.argv[1] === SWEEP_SCRIPT) {
	const [pgid, mark] = process.argv.slice(2);
	if (pgid !== undefined && mark !== undefined && /^\d+$/.test(pgid)) await sweepJob(Number(pgid), mark);
}
