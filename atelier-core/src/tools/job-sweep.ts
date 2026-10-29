import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	marked: boolean;
}

/**
 * Signals every process of a job: those in its process group, those carrying its mark, and every descendant of either,
 * found in one listing so a parent that dies first does not hide its children. SIGKILL goes round after round until
 * none is left; another signal goes once. Never signals the process that runs it. Best effort: without a process
 * listing (a sandbox refuses `ps`) it finds nothing and the group's own signal is all there is.
 */
export async function sweepJob(pgid: number, mark: string, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
	const entry = `${JOB_MARK}=${mark}`;
	const rounds = signal === "SIGKILL" ? ROUNDS : 1;
	for (let round = 0; round < rounds; round++) {
		const pids = jobProcesses(await listProcesses(entry), pgid);
		if (pids.length === 0) return;
		for (const pid of pids)
			try {
				process.kill(pid, signal);
			} catch {}
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

async function listProcesses(entry: string): Promise<ProcessRow[]> {
	return process.platform === "linux" ? linuxProcesses(entry) : psProcesses(entry);
}

/** `ps -E` adds each process's environment, when it may be read, after its command line. */
async function psProcesses(entry: string): Promise<ProcessRow[]> {
	const listing = await new Promise<string>((resolve) => {
		try {
			execFile(
				"/bin/ps",
				["-A", "-E", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "command="],
				{ maxBuffer: 64 * 1024 * 1024 },
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

function linuxProcesses(entry: string): ProcessRow[] {
	let names: string[] = [];
	try {
		names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		try {
			// The fields after the command name, which may hold spaces and parentheses: state, ppid, pgrp.
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const [, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			let marked = false;
			try {
				marked = readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(entry);
			} catch {}
			return [{ pid: Number(name), ppid: Number(ppid), pgid: Number(pgid), marked }];
		} catch {
			return [];
		}
	});
}

/** The watcher of a job runs this file when Atelier is gone: `node job-sweep.ts <pgid> <mark>`. */
export const SWEEP_SCRIPT = fileURLToPath(import.meta.url);

if (process.argv[1] === SWEEP_SCRIPT) {
	const [pgid, mark] = process.argv.slice(2);
	if (pgid !== undefined && mark !== undefined && /^\d+$/.test(pgid)) await sweepJob(Number(pgid), mark);
}
