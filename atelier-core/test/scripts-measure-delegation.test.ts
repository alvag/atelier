import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-measure-test-"));
});
afterEach(async () => {
	child?.kill("SIGKILL");
	child = undefined;
	await rm(root, { recursive: true, force: true });
});

/** Waits for a condition instead of a fixed delay. */
async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("measure-delegation", () => {
	it("ends on its own once its report is written, with a slow sweep of the temporary folder", async () => {
		// Stale-looking directories of a live owner, and a `ps` that answers only after its timeout: a sweep of minutes.
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "ps"), "#!/bin/sh\nsleep 30\n");
		await chmod(join(bin, "ps"), 0o755);
		const folder = join(root, "tmp");
		await mkdir(folder);
		for (const name of ["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee", "ffffff"]) {
			await mkdir(join(folder, `atelier-session-${name}`));
			const owner = { pid: process.pid, startedAt: Date.now() - 3_600_000 };
			await writeFile(join(folder, `atelier-session-${name}`, ".atelier-owner"), JSON.stringify(owner));
		}
		const script = new URL("../scripts/measure-delegation.ts", import.meta.url).pathname;
		const json = join(root, "run.json");
		const { ATELIER_SCRATCH_SWEEP: _off, ...env } = process.env;
		let stderr = "";
		let exited: number | null | undefined;
		child = spawn(process.execPath, [script, "--fake-backend", "--runs", "1", "--tasks", "narrow2", "--json", json], {
			env: { ...env, TMPDIR: folder, PATH: `${bin}:${env.PATH ?? ""}` },
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("exit", (code) => {
			exited = code;
		});

		await until(() => exited !== undefined, 15_000);

		expect(stderr).toContain("narrow2 #1");
		expect(exited).toBe(0);
		const written = JSON.parse(await readFile(json, "utf8")) as { results: { task: string; errors: string[] }[] };
		expect(written.results.map((run) => [run.task, run.errors])).toEqual([["narrow2", []]]);
	}, 30_000);
});
