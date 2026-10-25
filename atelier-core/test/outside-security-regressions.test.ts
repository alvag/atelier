import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/tools/index.ts";

let root: string;
let cwd: string;
let home: string;
let outside: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "atelier-secret-regression-")));
	cwd = join(root, "project");
	home = join(root, "home");
	outside = join(root, "outside");
	for (const dir of [cwd, outside, join(home, ".ssh"), join(cwd, ".atelier")]) await mkdir(dir, { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe.each([true, false])("S2 secret-safe grep, ripgrep=%s", (useRipgrep) => {
	const search = (path: string, glob: string) =>
		createGrepTool({ outside: true, home, useRipgrep }).execute({ pattern: "MARKER", path, glob }, { cwd });

	it("never returns secret text from a newline-containing filename in .ssh", async () => {
		const path = join(home, ".ssh", "line\nbreak.txt");
		await writeFile(path, "SECRET_MARKER\n");
		const result = await search(home, "*");
		expect(result.output).not.toContain("SECRET_MARKER");
		expect(await readFile(path, "utf8")).toBe("SECRET_MARKER\n");
	});

	it("never returns text from a secret file whose name looks like a match line", async () => {
		await writeFile(join(home, ".ssh", "x:1:y.txt"), "SECRET_MARKER\n");
		await writeFile(join(home, ".ssh", "id"), "SECRET_MARKER\n");
		const result = await search(home, "*");
		expect(result.output).not.toContain("SECRET_MARKER");
	});

	it("never returns text through a symlink to a secret file", async () => {
		await writeFile(join(home, ".ssh", "id"), "SECRET_MARKER\n");
		await symlink(join(home, ".ssh", "id"), join(outside, "link.txt"));
		const result = await search(outside, "*");
		expect(result.output).not.toContain("SECRET_MARKER");
	});

	it.each(["backup-2026-04-20T10:30:12.txt", "line\nbreak.txt", "x:1:y.txt"])(
		"never returns a denyRead file named %j through an include glob",
		async (name) => {
			const path = join(home, name);
			await writeFile(path, "SECRET_MARKER\n");
			await writeFile(join(cwd, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: [path] }));
			const result = await search(home, "*.txt");
			expect(result.output).not.toContain("SECRET_MARKER");
			expect(await readFile(path, "utf8")).toBe("SECRET_MARKER\n");
		},
	);

	it("keeps public matches under an outside search root with **/*.txt", async () => {
		await writeFile(join(outside, "note.txt"), "PUBLIC_MARKER\n");
		const result = await search(outside, "**/*.txt");
		expect(result.ok).toBe(true);
		expect(result.output).toContain("note.txt:1:PUBLIC_MARKER");
	});

	it("still returns public files whose names have colons or newlines", async () => {
		await writeFile(join(outside, "a:1:b.txt"), "PUBLIC_MARKER\n");
		const result = await search(outside, "*.txt");
		expect(result.output).toContain("a:1:b.txt:1:PUBLIC_MARKER");
	});
});

describe.each([true, false])("S2 exclusion globs, ripgrep=%s", (useRipgrep) => {
	it.each([true, false])("keep working inside the working directory, outside=%s", async (open) => {
		await mkdir(join(cwd, "src", "private"), { recursive: true });
		await writeFile(join(cwd, "src", "visible.txt"), "PUBLIC_MARKER\n");
		await writeFile(join(cwd, "src", "private", "hidden.txt"), "PRIVATE_MARKER\n");
		const result = await createGrepTool({ outside: open, home, useRipgrep }).execute(
			{ pattern: "MARKER", path: ".", glob: "!src/private/**" },
			{ cwd },
		);
		expect(result.ok).toBe(true);
		expect(result.output).toBe("src/visible.txt:1:PUBLIC_MARKER");
	});
});

describe.each([true, false])("grep output for ordinary files, ripgrep=%s", (useRipgrep) => {
	it.each([true, false])("keeps the path:line:text format, outside=%s", async (open) => {
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "src", "a.ts"), "x\nconst MARKER = 1;\n");
		await writeFile(join(cwd, "b.md"), "MARKER: docs\n");
		const result = await createGrepTool({ outside: open, home, useRipgrep }).execute({ pattern: "MARKER" }, { cwd });
		expect(result.output.split("\n").sort()).toEqual(["b.md:1:MARKER: docs", "src/a.ts:2:const MARKER = 1;"]);
		expect(result.summary).toBe("MARKER: 2 matches");
		expect(result.truncated).toBe(false);
	});
});
