import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canFakePs, slowSweep, spawnTracked, type TrackedChild } from "./support/sweeping-child.ts";

let root: string;
let child: TrackedChild | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-measure-test-"));
});
afterEach(async () => {
	child?.stop();
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
	it.skipIf(!canFakePs)(
		"ends on its own once its report is written, with a slow sweep of the temporary folder",
		async () => {
			const sweep = await slowSweep(root);
			const script = new URL("../scripts/measure-delegation.ts", import.meta.url).pathname;
			const json = join(root, "run.json");
			const args = [script, "--fake-backend", "--runs", "1", "--tasks", "narrow2", "--json", json];
			const run = spawnTracked(process.execPath, args, { ...sweep.env, TMPDIR: sweep.folder });
			child = run;

			await until(() => run.exited !== undefined, 15_000);

			expect(run.stderr).toContain("narrow2 #1");
			expect(run.exited).toBe(0);
			const written = JSON.parse(await readFile(json, "utf8")) as { results: { task: string; errors: string[] }[] };
			expect(written.results.map((result) => [result.task, result.errors])).toEqual([["narrow2", []]]);
		},
		30_000,
	);
});
