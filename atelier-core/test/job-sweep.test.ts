import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
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
	mkdirSync(join(root, "4242"));
	writeFileSync(join(root, "4242", "stat"), "4242 (sleep a) S 1 4242 4242 0 -1");
	const environPath = join(root, "4242", "environ");
	if (environ === "never") {
		execFileSync("mkfifo", [environPath]);
		fifos.push(environPath);
	} else writeFileSync(environPath, environ);
	return root;
}

describe("the /proc listing", () => {
	it("reads the processes, their parents and groups, and which carry the job's mark", async () => {
		const root = fakeProc("HOME=/h\0ATELIER_JOB=abc\0");
		expect(await procProcesses("ATELIER_JOB=abc", root)).toEqual([{ pid: 4242, ppid: 1, pgid: 4242, marked: true }]);
		expect(await procProcesses("ATELIER_JOB=other", root)).toEqual([{ pid: 4242, ppid: 1, pgid: 4242, marked: false }]);
	});

	it("does not hold the sweep past its timeout when a read of /proc does not answer", { timeout: 10_000 }, async () => {
		const root = fakeProc("never");
		const started = Date.now();
		const swept = await sweepJob(999_999, "abc", "SIGKILL", (entry) => procProcesses(entry, root));
		expect(swept).toEqual({ signaled: [], listed: false });
		expect(Date.now() - started).toBeLessThan(LIST_TIMEOUT_MS + 1500);
	});
});
