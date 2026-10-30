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

	it("measures a background task in a git repository whose checks pass, with the counts of its background work", async () => {
		const script = new URL("../scripts/measure-delegation.ts", import.meta.url).pathname;
		const json = join(root, "run.json");
		const args = [script, "--fake-backend", "--background", "--runs", "1", "--tasks", "parallel", "--json", json];
		const run = spawnTracked(process.execPath, args, { ATELIER_SCRATCH_SWEEP: "off", TMPDIR: root });
		child = run;

		await until(() => run.exited !== undefined, 60_000);
		expect(run.stderr).toContain("parallel #1");
		expect(run.exited).toBe(0);
		const written = JSON.parse(await readFile(json, "utf8")) as {
			background?: boolean;
			results: { task: string; errors: string[]; background?: Record<string, number | boolean> }[];
		};
		expect(written.background).toBe(true);
		expect(written.results.map((result) => [result.task, result.errors])).toEqual([["parallel", []]]);
		// The scripted backend only answers: nothing launched or applied, and the repository's own checks pass.
		expect(written.results[0]?.background).toEqual({
			backgroundLaunches: 0,
			foregroundTasks: 0,
			launchResponses: 0,
			relaunches: 0,
			polls: 0,
			applies: 0,
			checkRuns: 0,
			checksAfterLastApply: 0,
			changesMade: 0,
			checksPass: true,
		});
		expect(run.stdout).toContain("| background launches | 0 |");
	}, 90_000);

	it("refuses a background task without --background", async () => {
		const script = new URL("../scripts/measure-delegation.ts", import.meta.url).pathname;
		const args = [script, "--fake-backend", "--runs", "1", "--tasks", "needed-first"];
		const run = spawnTracked(process.execPath, args, { ATELIER_SCRATCH_SWEEP: "off", TMPDIR: root });
		child = run;

		await until(() => run.exited !== undefined, 15_000);
		expect(run.exited).toBe(2);
		expect(run.stderr).toContain("needed-first runs only with --background");
	}, 30_000);

	it("records the explorer model and the variant of the background rules it measured, and refuses another", async () => {
		const script = new URL("../scripts/measure-delegation.ts", import.meta.url).pathname;
		const json = join(root, "run.json");
		const measured = (...more: string[]) => {
			const args = [script, "--fake-backend", "--runs", "1", "--tasks", "narrow2", "--json", json, ...more];
			const run = spawnTracked(process.execPath, args, { ATELIER_SCRATCH_SWEEP: "off", TMPDIR: root });
			child = run;
			return run;
		};
		const written = async () =>
			JSON.parse(await readFile(json, "utf8")) as { variant?: string; explorerModel?: string };

		const run = measured("--explorer-model", "claude-haiku-5-5");
		await until(() => run.exited !== undefined, 15_000);
		expect(run.exited).toBe(0);
		expect(await written()).toMatchObject({ variant: "baseline", explorerModel: "claude-haiku-5-5" });

		const rules = measured("--background", "--variant", "rules");
		await until(() => rules.exited !== undefined, 30_000);
		expect(rules.exited).toBe(0);
		expect(rules.stdout).toContain("Variant: rules");
		expect((await written()).variant).toBe("rules");

		// The rules speak of background subagents: a session without --background has none.
		const alone = measured("--variant", "rules");
		await until(() => alone.exited !== undefined, 15_000);
		expect(alone.exited).toBe(2);
		expect(alone.stderr).toContain("--variant rules needs --background");

		// #124's variants are gone.
		const wrong = measured("--variant", "rule");
		await until(() => wrong.exited !== undefined, 15_000);
		expect(wrong.exited).toBe(2);
		expect(wrong.stderr).toContain("Unknown variant rule; the variants are baseline, rules.");
	}, 60_000);
});
