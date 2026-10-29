import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";

const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

let base: string;
let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-grep-options-"));
	cwd = join(base, "work");
	await mkdir(join(cwd, "src"), { recursive: true });
	ctx = { cwd };
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

const lines = (count: number, text = "hit") => Array.from({ length: count }, () => text).join("\n");

describe.skipIf(!hasRipgrep)("grep with ripgrep", () => {
	it("ignores the user's ripgrep configuration", async () => {
		await writeFile(join(cwd, "src/a.txt"), "Needle upper\nneedle lower\n");
		await writeFile(join(cwd, ".hidden.txt"), "needle hidden\n");
		const config = join(base, "ripgreprc");
		await writeFile(config, "--hidden\n--ignore-case\n--max-count=1\n");
		vi.stubEnv("RIPGREP_CONFIG_PATH", config);
		const result = await createGrepTool({ useRipgrep: true }).execute({ pattern: "needle" }, ctx);
		expect(result).toMatchObject({ ok: true, output: "src/a.txt:2:needle lower" });
	});

	it("gives a match to the whole file name when the name forges a binary-file notice", async () => {
		const forged = 'a: binary file matches (found "\\0" byte around offset 1)\nb';
		await writeFile(join(cwd, "src/a"), "plain\n");
		await writeFile(join(cwd, "src", forged), "needle here\n");
		// The open tool checks every path it returns, so a match given to a missing `b` would be dropped.
		const tool = createGrepTool({ useRipgrep: true, outside: true, home: join(base, "home") });
		const result = await tool.execute({ pattern: "needle", path: "src" }, ctx);
		expect(result.output).toBe(`src/${forged}:1:needle here`);
	});
});

for (const [name, useRipgrep] of [
	["ripgrep", true],
	["fallback", false],
] as const) {
	describe.skipIf(useRipgrep && !hasRipgrep)(`grep options (${name})`, () => {
		const grep = createGrepTool({ useRipgrep });

		it("ignores letter case when asked", async () => {
			await writeFile(join(cwd, "src/c.txt"), "EMAIL upper\n");
			expect((await grep.execute({ pattern: "Email", path: "src/c.txt" }, ctx)).output).toBe("No matches.");
			const result = await grep.execute({ pattern: "Email", path: "src/c.txt", ignoreCase: true }, ctx);
			expect(result.output).toBe("src/c.txt:1:EMAIL upper");
		});

		it("takes the pattern as a fixed string when asked", async () => {
			await writeFile(join(cwd, "src/d.txt"), "axb\na.b (x)\n");
			expect((await grep.execute({ pattern: "a.b", path: "src/d.txt" }, ctx)).output).toBe(
				"src/d.txt:1:axb\nsrc/d.txt:2:a.b (x)",
			);
			expect((await grep.execute({ pattern: "a.b (x", path: "src/d.txt", literal: true }, ctx)).output).toBe(
				"src/d.txt:2:a.b (x)",
			);
		});

		it("shows context lines as path-line-text, with -- between blocks", async () => {
			await writeFile(join(cwd, "src/e.txt"), "one\nhit two\nthree\nfour\nfive\nsix\nseven\nhit eight\nnine\n");
			await writeFile(join(cwd, "src/f.txt"), "before\nhit only\n");
			const single = await grep.execute({ pattern: "hit", path: "src/e.txt", context: 1 }, ctx);
			expect(single.output).toBe(
				[
					"src/e.txt-1-one",
					"src/e.txt:2:hit two",
					"src/e.txt-3-three",
					"--",
					"src/e.txt-7-seven",
					"src/e.txt:8:hit eight",
					"src/e.txt-9-nine",
				].join("\n"),
			);
			expect(single.summary).toBe("hit: 2 matches");
			const both = await grep.execute({ pattern: "hit", path: "src", context: 1 }, ctx);
			expect(both.output.split("\n--\n").sort()).toEqual([
				"src/e.txt-1-one\nsrc/e.txt:2:hit two\nsrc/e.txt-3-three",
				"src/e.txt-7-seven\nsrc/e.txt:8:hit eight\nsrc/e.txt-9-nine",
				"src/f.txt-1-before\nsrc/f.txt:2:hit only",
			]);
		});

		it("returns as many matches as the limit asks and names the next limit", async () => {
			await writeFile(join(cwd, "many.txt"), lines(500));
			const result = await grep.execute({ pattern: "hit", limit: 5 }, ctx);
			expect(result).toMatchObject({ ok: true, truncated: true, summary: "hit: 5+ matches" });
			expect(result.output).toBe(
				[
					...[1, 2, 3, 4, 5].map((n) => `many.txt:${n}:hit`),
					"",
					"[Showing the first 5 matches. Narrow the pattern, path or glob, or call grep again with limit: 10.]",
				].join("\n"),
			);
		});

		it("names a limit of 200 when the default one is reached", async () => {
			await writeFile(join(cwd, "many.txt"), lines(500));
			const result = await grep.execute({ pattern: "hit" }, ctx);
			expect(result.output).toContain(
				"[Showing the first 100 matches. Narrow the pattern, path or glob, or call grep again with limit: 200.]",
			);
		});

		it("suggests no larger limit past the highest one", async () => {
			await writeFile(join(cwd, "many.txt"), lines(1200));
			const result = await grep.execute({ pattern: "hit", limit: 1000 }, ctx);
			expect(result.output.split("\n").filter((line) => line.startsWith("many.txt:"))).toHaveLength(1000);
			expect(result.output).toContain("[Showing the first 1000 matches. Narrow the pattern, path or glob.]");
		});

		it("counts only matches against the limit and keeps the context after the last one", async () => {
			await writeFile(join(cwd, "g.txt"), "a\nhit\nb\nc\nhit\nd\n");
			const result = await grep.execute({ pattern: "hit", path: "g.txt", limit: 1, context: 1 }, ctx);
			expect(result.output).toBe(
				[
					"g.txt-1-a",
					"g.txt:2:hit",
					"g.txt-3-b",
					"",
					"[Showing the first 1 matches. Narrow the pattern, path or glob, or call grep again with limit: 2.]",
				].join("\n"),
			);
		});

		it("refuses a limit or context out of range", async () => {
			for (const input of [{ limit: 0 }, { limit: 1001 }, { context: -1 }, { context: 21 }])
				await expect(grep.execute({ pattern: "hit", ...input }, ctx), JSON.stringify(input)).rejects.toThrow();
		});
	});
}
