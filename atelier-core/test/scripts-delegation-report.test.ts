import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAt, firstTools, fmt, mean } from "../scripts/delegation-report.ts";

describe("the delegation report", () => {
	it("shows n/a for a task with no runs, as a JSON from before the task has none", () => {
		expect(fmt(mean([], (run: { n: number }) => run.n))).toBe("n/a");
		expect(firstTools([])).toBe("n/a");
	});

	it("shows the mean of the runs a task has", () => {
		expect(fmt(mean([{ n: 1 }, { n: 2 }], (run) => run.n))).toBe("1.500");
		expect(fmt(mean([{ n: 46_521 }], (run) => run.n))).toBe("46521");
		expect(firstTools([{ firstTool: "grep" }, { firstTool: "grep" }, { firstTool: "task" }])).toBe("grep ×2, task ×1");
	});

	it("says a run from a JSON without the first tool as n/a", () => {
		expect(firstTools([{}])).toBe("n/a ×1");
	});

	it("knows no commit where git cannot tell one, instead of failing the run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "delegation-report-"));
		try {
			expect(commitAt(dir)).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("knows the commit of a checkout", () => {
		expect(commitAt(import.meta.dirname)?.sha).toMatch(/^[0-9a-f]{40}$/);
	});
});
