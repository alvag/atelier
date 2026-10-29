import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIST_TIMEOUT_MS, procProcesses, sweepJob } from "../src/tools/job-sweep.ts";

let dirs: string[] = [];
let fifos: string[] = [];

afterEach(() => {
	// A writer that opens and closes each FIFO ends the read still waiting on it.
	for (const fifo of fifos)
		try {
			closeSync(openSync(fifo, "w"));
		} catch {}
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
	fifos = [];
});

/** A tree laid out like Linux's /proc with one process, whose environment is given or never answers (a FIFO). */
function fakeProc(environ: string | "never"): string {
	const root = mkdtempSync(join(tmpdir(), "atelier-proc-"));
	dirs.push(root);
	mkdirSync(join(root, "9999998"));
	writeFileSync(join(root, "9999998", "stat"), "9999998 (sleep a) S 1 9999998 9999998 0 -1");
	const environPath = join(root, "9999998", "environ");
	if (environ === "never") {
		execFileSync("mkfifo", [environPath]);
		fifos.push(environPath);
	} else writeFileSync(environPath, environ);
	return root;
}

describe("the /proc listing", () => {
	it("reads the processes, their parents and groups, and which carry the job's mark", async () => {
		const root = fakeProc("HOME=/h\0ATELIER_JOB=abc\0");
		expect(await procProcesses("ATELIER_JOB=abc", root)).toEqual([
			{ pid: 9999998, ppid: 1, pgid: 9999998, marked: true },
		]);
		expect(await procProcesses("ATELIER_JOB=other", root)).toEqual([
			{ pid: 9999998, ppid: 1, pgid: 9999998, marked: false },
		]);
	});

	it("does not hold the sweep past its timeout when a read of /proc does not answer", { timeout: 10_000 }, async () => {
		const root = fakeProc("never");
		const started = Date.now();
		const swept = await sweepJob(999_999, "abc", "SIGKILL", (entry) => procProcesses(entry, root));
		expect(swept).toEqual({ signaled: [], listed: false });
		expect(Date.now() - started).toBeLessThan(LIST_TIMEOUT_MS + 1500);
	});

	it("reads at most 32 files at once, however many processes there are", async () => {
		const root = mkdtempSync(join(tmpdir(), "atelier-proc-many-"));
		dirs.push(root);
		for (let pid = 9_000_000; pid < 9_000_200; pid++) {
			mkdirSync(join(root, String(pid)));
			writeFileSync(join(root, String(pid), "stat"), `${pid} (sh) S 1 ${pid} ${pid}`);
			writeFileSync(join(root, String(pid), "environ"), "HOME=/h\0");
		}
		let reading = 0;
		let most = 0;
		const read = async (path: string, encoding: BufferEncoding) => {
			reading++;
			most = Math.max(most, reading);
			try {
				await new Promise((resolve) => setImmediate(resolve));
				return await readFile(path, encoding);
			} finally {
				reading--;
			}
		};
		const rows = await procProcesses("ATELIER_JOB=abc", root, read);
		expect(rows).toHaveLength(200);
		expect(most).toBeGreaterThan(1);
		expect(most).toBeLessThanOrEqual(32);
	});

	it("does not take a listing that a read failed in as complete, but takes a process that is gone or not ours", async () => {
		const root = fakeProc("ATELIER_JOB=abc\0");
		const failing = (code: string) => async (path: string, encoding: BufferEncoding) => {
			if (path.endsWith("environ")) throw Object.assign(new Error(code), { code });
			return readFile(path, encoding);
		};
		const sweep = (code: string) =>
			sweepJob(999_999, "abc", "SIGTERM", (entry) => procProcesses(entry, root, failing(code)));
		expect(await sweep("EMFILE")).toEqual({ signaled: [], listed: false });
		expect(await sweep("EIO")).toEqual({ signaled: [], listed: false });
		// A process that ended during the listing, or whose environment belongs to another user, is the usual /proc.
		expect(await procProcesses("ATELIER_JOB=abc", root, failing("EACCES"))).toEqual([
			{ pid: 9999998, ppid: 1, pgid: 9999998, marked: false },
		]);
		expect((await sweep("ENOENT")).listed).toBe(true);
	});
});
