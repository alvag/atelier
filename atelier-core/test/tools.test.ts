import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool, createGrepTool, editTool, grepTool, readTool, resolveInside } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";

let cwd: string;
let outside: string;
let ctx: ToolContext;

beforeEach(async () => {
	const base = await mkdtemp(join(tmpdir(), "atelier-tools-"));
	cwd = join(base, "work");
	outside = join(base, "outside");
	await mkdir(cwd);
	await mkdir(outside);
	await writeFile(join(outside, "secret.txt"), "top secret\n");
	ctx = { cwd };
});

afterEach(async () => {
	await rm(join(cwd, ".."), { recursive: true, force: true });
});

describe("resolveInside", () => {
	it("resolves relative and absolute paths inside cwd to their real path", async () => {
		const real = await realpath(cwd);
		await writeFile(join(cwd, "a.txt"), "");
		expect(await resolveInside(cwd, "a.txt")).toBe(join(real, "a.txt"));
		expect(await resolveInside(cwd, join(cwd, "a.txt"))).toBe(join(real, "a.txt"));
		expect(await resolveInside(cwd, "new/dir/file.txt")).toBe(join(real, "new/dir/file.txt"));
		expect(await resolveInside(cwd, ".")).toBe(real);
	});

	it("returns the symlink target, so later file access does not follow the link again", async () => {
		const real = await realpath(cwd);
		await mkdir(join(cwd, "inner"));
		await symlink(join(cwd, "inner"), join(cwd, "alias"));
		expect(await resolveInside(cwd, "alias/x.txt")).toBe(join(real, "inner/x.txt"));
	});

	it("rejects paths that leave cwd", async () => {
		await expect(resolveInside(cwd, "../outside/secret.txt")).rejects.toThrow(/outside the working directory/);
		await expect(resolveInside(cwd, join(outside, "secret.txt"))).rejects.toThrow(/outside the working directory/);
		await expect(resolveInside(cwd, "a/../../outside")).rejects.toThrow(/outside the working directory/);
	});

	it("rejects a sibling directory that only shares the prefix", async () => {
		const sibling = `${cwd}-evil`;
		await mkdir(sibling);
		await expect(resolveInside(cwd, sibling)).rejects.toThrow(/outside the working directory/);
		await rm(sibling, { recursive: true });
	});

	it("rejects symlinks that point outside cwd", async () => {
		await symlink(outside, join(cwd, "link"));
		await expect(resolveInside(cwd, "link/secret.txt")).rejects.toThrow(/outside the working directory/);
		await expect(resolveInside(cwd, "link/new.txt")).rejects.toThrow(/outside the working directory/);
	});
});

describe("read", () => {
	it("returns numbered lines", async () => {
		await writeFile(join(cwd, "f.txt"), "alpha\nbeta\ngamma\n");
		const result = await readTool.execute({ path: "f.txt" }, ctx);
		expect(result).toMatchObject({ ok: true, truncated: false, summary: "f.txt (3 lines)" });
		expect(result.output).toBe("1\talpha\n2\tbeta\n3\tgamma");
	});

	it("honors offset and limit and says how to continue", async () => {
		await writeFile(join(cwd, "f.txt"), "l1\nl2\nl3\nl4\nl5\n");
		const result = await readTool.execute({ path: "f.txt", offset: 2, limit: 2 }, ctx);
		expect(result.output).toBe("2\tl2\n3\tl3\n\n[Showing lines 2-3 of 5. Use offset=4 to continue.]");
		expect(result.truncated).toBe(true);
	});

	it("truncates long files", async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
		await writeFile(join(cwd, "big.txt"), lines);
		const result = await readTool.execute({ path: "big.txt" }, ctx);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("2000\tline 2000");
		expect(result.output).not.toContain("2001\tline 2001");
		expect(result.output).toContain("Use offset=2001 to continue.");
	});

	it("truncates by bytes too", async () => {
		await writeFile(join(cwd, "wide.txt"), Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
		const result = await readTool.execute({ path: "wide.txt" }, ctx);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(51_200 + 200);
	});

	it("truncates a single huge multibyte line by bytes and says so", async () => {
		await writeFile(join(cwd, "one.txt"), "é".repeat(60_000));
		const result = await readTool.execute({ path: "one.txt" }, ctx);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(51_200 + 200);
	});

	it("refuses binary files", async () => {
		await writeFile(join(cwd, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x0a]));
		expect(await readTool.execute({ path: "image.bin" }, ctx)).toMatchObject({
			ok: false,
			output: "Binary file: image.bin",
		});
	});

	it("reads an empty file", async () => {
		await writeFile(join(cwd, "empty.txt"), "");
		expect(await readTool.execute({ path: "empty.txt" }, ctx)).toMatchObject({
			ok: true,
			output: "",
			truncated: false,
		});
	});

	it("handles a huge single line without newlines", async () => {
		await writeFile(join(cwd, "huge.txt"), "x".repeat(8 * 1024 * 1024));
		const result = await readTool.execute({ path: "huge.txt" }, ctx);
		expect(result).toMatchObject({ ok: true, truncated: true, summary: "huge.txt (1 lines)" });
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(51_200);
	});

	it("counts every line of a long file while showing a page", async () => {
		await writeFile(join(cwd, "long.txt"), `${Array.from({ length: 50_000 }, (_, i) => `row ${i + 1}`).join("\n")}\n`);
		const result = await readTool.execute({ path: "long.txt", offset: 49_999 }, ctx);
		expect(result.output).toBe("49999\trow 49999\n50000\trow 50000");
		expect(result.summary).toBe("long.txt (50000 lines)");
	});

	it("reads the scratch directory but nothing else outside cwd", async () => {
		const scratchDir = await mkdtemp(join(tmpdir(), "atelier-scratch-"));
		try {
			await writeFile(join(scratchDir, "out.log"), "spilled\n");
			expect((await readTool.execute({ path: join(scratchDir, "out.log") }, { cwd, scratchDir })).output).toBe(
				"1\tspilled",
			);
			const escaped = await readTool.execute({ path: join(outside, "secret.txt") }, { cwd, scratchDir });
			expect(escaped.ok).toBe(false);
			expect((await readTool.execute({ path: join(scratchDir, "out.log") }, ctx)).ok).toBe(false);
		} finally {
			await rm(scratchDir, { recursive: true, force: true });
		}
	});

	it("fails for missing files, directories and paths outside cwd", async () => {
		expect(await readTool.execute({ path: "missing.txt" }, ctx)).toMatchObject({ ok: false });
		expect(await readTool.execute({ path: "." }, ctx)).toMatchObject({ ok: false });
		const escaped = await readTool.execute({ path: "../outside/secret.txt" }, ctx);
		expect(escaped.ok).toBe(false);
		expect(escaped.output).not.toContain("top secret");
	});
});

describe("edit", () => {
	it("replaces each exact match and writes the file", async () => {
		await writeFile(join(cwd, "f.ts"), "const a = 1;\nconst b = 2;\n");
		const result = await editTool.execute(
			{
				path: "f.ts",
				edits: [
					{ oldText: "a = 1", newText: "a = 10" },
					{ oldText: "b = 2", newText: "b = 20" },
				],
			},
			ctx,
		);
		expect(result).toMatchObject({ ok: true, summary: "f.ts (2 edits)" });
		expect(await readFile(join(cwd, "f.ts"), "utf8")).toBe("const a = 10;\nconst b = 20;\n");
	});

	it("treats replacement text literally", async () => {
		await writeFile(join(cwd, "f.txt"), "price\n");
		await editTool.execute({ path: "f.txt", edits: [{ oldText: "price", newText: "$& $1 $$" }] }, ctx);
		expect(await readFile(join(cwd, "f.txt"), "utf8")).toBe("$& $1 $$\n");
	});

	it.each([
		["not found", [{ oldText: "zzz", newText: "y" }], /not found/],
		["ambiguous", [{ oldText: "x", newText: "y" }], /2 times/],
		["empty", [{ oldText: "", newText: "y" }], /empty/],
		[
			"overlapping",
			[
				{ oldText: "x x", newText: "a" },
				{ oldText: "x y", newText: "b" },
			],
			/overlap/,
		],
		[
			"one bad edit among good ones",
			[
				{ oldText: "y", newText: "ok" },
				{ oldText: "zzz", newText: "no" },
			],
			/not found/,
		],
	])("fails without touching the file when %s", async (_name, edits, message) => {
		const original = "x x y\n";
		await writeFile(join(cwd, "f.txt"), original);
		const before = await stat(join(cwd, "f.txt"));
		const result = await editTool.execute({ path: "f.txt", edits }, ctx);
		expect(result.ok).toBe(false);
		expect(result.output).toMatch(message);
		expect(await readFile(join(cwd, "f.txt"), "utf8")).toBe(original);
		expect((await stat(join(cwd, "f.txt"))).mtimeMs).toBe(before.mtimeMs);
	});

	it("leaves no temporary files behind and keeps the file mode", async () => {
		await writeFile(join(cwd, "run.sh"), "echo a\n", { mode: 0o755 });
		await editTool.execute({ path: "run.sh", edits: [{ oldText: "a", newText: "b" }] }, ctx);
		expect(await readdir(cwd)).toEqual(["run.sh"]);
		expect((await stat(join(cwd, "run.sh"))).mode & 0o777).toBe(0o755);
	});

	it("refuses files outside cwd and missing files", async () => {
		const escaped = await editTool.execute(
			{ path: "../outside/secret.txt", edits: [{ oldText: "top", newText: "no" }] },
			ctx,
		);
		expect(escaped.ok).toBe(false);
		expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("top secret\n");
		expect((await editTool.execute({ path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, ctx)).ok).toBe(false);
	});

	it("rejects an empty edit list", async () => {
		await expect(editTool.execute({ path: "f.txt", edits: [] }, ctx)).rejects.toThrow();
	});
});

describe("bash", () => {
	it("asks for approval with the exact command", () => {
		expect(bashTool.approvalCommand({ command: "ls -la" })).toBe("ls -la");
	});

	it("runs in cwd and returns output and exit code", async () => {
		const result = await bashTool.execute({ command: "pwd; echo out; echo err >&2" }, ctx);
		expect(result.ok).toBe(true);
		expect(result.output).toContain(cwd.replace(/^\/private/, ""));
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
		expect(result.output).toContain("[exit code 0]");
	});

	it("reports a non-zero exit as a failure", async () => {
		const result = await bashTool.execute({ command: "exit 3" }, ctx);
		expect(result).toMatchObject({ ok: false, summary: "exit 3 (exit 3)" });
		expect(result.output).toContain("[exit code 3]");
	});

	it("kills the command and its children on timeout", async () => {
		const marker = join(cwd, "late.txt");
		const started = Date.now();
		const result = await bashTool.execute({ command: `(sleep 2; touch ${marker}) & sleep 30`, timeoutSec: 1 }, ctx);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("timed out after 1s");
		await new Promise((resolve) => setTimeout(resolve, 2500));
		await expect(stat(marker)).rejects.toThrow();
	});

	it("stops when the signal aborts", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const result = await bashTool.execute({ command: "sleep 30" }, { cwd, signal: controller.signal });
		expect(result.ok).toBe(false);
		expect(result.output).toContain("aborted");
	});

	it("keeps the tail of a large burst of output", async () => {
		const result = await bashTool.execute({ command: "seq 1 100000; echo LAST-LINE" }, ctx);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("99999\n100000\nLAST-LINE");
		const full = await readFile(result.fullOutputPath as string, "utf8");
		expect(full.startsWith("1\n2\n")).toBe(true);
		expect(full.trimEnd().endsWith("LAST-LINE")).toBe(true);
	});

	it("still returns the tail when the full output cannot be saved", async () => {
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = join(cwd, "does-not-exist");
		try {
			for (const command of ["seq 1 100000; echo LAST-LINE", "seq 1 5000; echo LAST-LINE"]) {
				const result = await bashTool.execute({ command }, ctx);
				expect(result.ok).toBe(true);
				expect(result.truncated).toBe(true);
				expect(result.fullOutputPath).toBeUndefined();
				expect(result.output).toContain("LAST-LINE");
			}
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
		}
	});

	it("keeps the end of a single line longer than the output limit", async () => {
		const result = await bashTool.execute({ command: "printf 'a%.0s' $(seq 1 60000); echo END" }, ctx);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("aaaEND");
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(51_200 + 400);
	});

	it("saves the full output inside the session scratch directory when there is one", async () => {
		const scratchDir = await mkdtemp(join(tmpdir(), "atelier-scratch-"));
		try {
			const result = await bashTool.execute({ command: "seq 1 5000" }, { cwd, scratchDir });
			expect(result.fullOutputPath?.startsWith(`${scratchDir}/`)).toBe(true);
			const read = await readTool.execute({ path: result.fullOutputPath as string, offset: 4999 }, { cwd, scratchDir });
			expect(read).toMatchObject({ ok: true });
			expect(read.output).toBe("4999\t4999\n5000\t5000");
		} finally {
			await rm(scratchDir, { recursive: true, force: true });
		}
	});

	it("stops saving the full output at 50 MB but still returns the tail", async () => {
		const scratchDir = await mkdtemp(join(tmpdir(), "atelier-scratch-"));
		try {
			const result = await bashTool.execute(
				{ command: "yes 0123456789abcdef | head -c 60000000; echo; echo LAST-LINE" },
				{ cwd, scratchDir },
			);
			expect(result.ok).toBe(true);
			expect(result.output).toContain("LAST-LINE");
			expect(result.output).toContain("Full output (first 50 MB):");
			expect((await stat(result.fullOutputPath as string)).size).toBe(50 * 1024 * 1024);
		} finally {
			await rm(scratchDir, { recursive: true, force: true });
		}
	}, 20_000);

	it("keeps the tail of long output and saves the full text to a file", async () => {
		const result = await bashTool.execute({ command: "seq 1 5000" }, ctx);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("5000");
		expect(result.output).not.toMatch(/^1\n/);
		expect(result.fullOutputPath).toBeDefined();
		const full = await readFile(result.fullOutputPath as string, "utf8");
		expect(full.startsWith("1\n2\n")).toBe(true);
		expect(full).toContain("5000");
		expect(result.output).toContain(result.fullOutputPath as string);
	});
});

describe("grep", () => {
	beforeEach(async () => {
		await mkdir(join(cwd, "src"));
		await mkdir(join(cwd, "node_modules"));
		await writeFile(join(cwd, "src/a.ts"), "const email = 1;\nconst other = 2;\n");
		await writeFile(join(cwd, "src/b.md"), "email docs\n");
		await writeFile(join(cwd, "node_modules/dep.ts"), "email in deps\n");
	});

	for (const [name, tool] of [
		["ripgrep or fallback", grepTool],
		["fallback", createGrepTool({ useRipgrep: false })],
	] as const) {
		describe(name, () => {
			it("finds matches with relative paths and line numbers", async () => {
				const result = await tool.execute({ pattern: "email" }, ctx);
				expect(result.ok).toBe(true);
				const lines = result.output.split("\n").sort();
				expect(lines).toEqual(["src/a.ts:1:const email = 1;", "src/b.md:1:email docs"]);
			});

			it("filters by glob and path", async () => {
				expect((await tool.execute({ pattern: "email", glob: "*.ts" }, ctx)).output).toBe(
					"src/a.ts:1:const email = 1;",
				);
				expect((await tool.execute({ pattern: "other", path: "src" }, ctx)).output).toBe("src/a.ts:2:const other = 2;");
			});

			it("reports no matches as success", async () => {
				expect(await tool.execute({ pattern: "nothing-here" }, ctx)).toMatchObject({
					ok: true,
					output: "No matches.",
				});
			});

			it("refuses paths outside cwd", async () => {
				const result = await tool.execute({ pattern: "secret", path: "../outside" }, ctx);
				expect(result.ok).toBe(false);
				expect(result.output).not.toContain("top secret");
			});

			it("caps the number of matches", async () => {
				await writeFile(join(cwd, "many.txt"), Array.from({ length: 500 }, () => "hit").join("\n"));
				const result = await tool.execute({ pattern: "hit" }, ctx);
				expect(result.truncated).toBe(true);
				expect(result.output.split("\n").filter((l) => l.startsWith("many.txt:"))).toHaveLength(100);
			});
		});
	}
});
