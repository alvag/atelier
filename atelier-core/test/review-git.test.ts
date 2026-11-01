import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitText } from "../src/review/git.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repo() {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-review-git-"));
	dirs.push(cwd);
	execFileSync("git", ["init", "-q"], { cwd });
	return cwd;
}

const config = (...pairs: [string, string][]): Record<string, string> => ({
	GIT_CONFIG_COUNT: String(pairs.length),
	...Object.fromEntries(
		pairs.flatMap(([key, value], i) => [
			[`GIT_CONFIG_KEY_${i}`, key],
			[`GIT_CONFIG_VALUE_${i}`, value],
		]),
	),
});

describe("the git environment's commit-graph setting", () => {
	const get = (cwd: string, key: string, env?: Record<string, string>) =>
		gitText(["config", "--get", key], { cwd, ...(env ? { env } : {}) }).then((text) => text.trim());

	it("is off by default", async () => {
		expect(await get(await repo(), "core.commitGraph")).toBe("false");
	});

	it("stays off beside other config the caller supplies, which stays available", async () => {
		const cwd = await repo();
		const env = {
			...config(["test.one", "1"], ["test.two", "2"], ["core.commitGraph", "true"], ["test.three", "3"]),
			GIT_INDEX_FILE: join(cwd, ".git", "other-index"),
		};
		expect(await get(cwd, "core.commitGraph", env)).toBe("false");
		for (const [key, value] of [
			["test.one", "1"],
			["test.two", "2"],
			["test.three", "3"],
		]) {
			expect(await get(cwd, key as string, env)).toBe(value);
		}
		expect(await gitText(["rev-parse", "--git-path", "index"], { cwd, env })).toContain("other-index");
	});

	it("stays off when the only supplied config turns it on", async () => {
		const cwd = await repo();
		expect(await get(cwd, "core.commitGraph", config(["core.commitGraph", "true"]))).toBe("false");
	});
});
