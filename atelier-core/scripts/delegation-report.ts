/** The pieces of measure-delegation's report that do not need the API. */
import { execFileSync } from "node:child_process";

export interface Commit {
	sha: string;
	/** The checkout had uncommitted changes. */
	dirty: boolean;
}

/** The commit `dir` is checked out at; undefined where git cannot tell, so a run never fails for its label. */
export function commitAt(dir: string): Commit | undefined {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
	} catch {
		return undefined;
	}
}

/** The mean of one number over the runs of a task; NaN when it has none, as a JSON from before the task. */
export function mean<T>(of: readonly T[], pick: (run: T) => number): number {
	return of.length === 0 ? Number.NaN : of.reduce((sum, run) => sum + pick(run), 0) / of.length;
}

/** A number not measured (no runs, or a column a JSON from before it lacks) is shown as n/a. */
export function fmt(n: number): string {
	if (Number.isNaN(n)) return "n/a";
	return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 3 : 0);
}

/** `grep ×2, task ×1`: which tool each run called first; n/a for a run from before the field, or no runs. */
export function firstTools(of: readonly { firstTool?: string }[]): string {
	if (of.length === 0) return "n/a";
	const counts = new Map<string, number>();
	for (const run of of) counts.set(run.firstTool ?? "n/a", (counts.get(run.firstTool ?? "n/a") ?? 0) + 1);
	return [...counts].map(([tool, n]) => `${tool} ×${n}`).join(", ");
}
