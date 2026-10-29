import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/tools/index.ts";

// The notice check probes the file system from ripgrep's output callback; a probe that fails
// (a name too long, an I/O error) must not escape it and end the process.
const probe = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		lstatSync: ((path: string, options?: object) => {
			if (probe.code && String(path).includes("binary file matches"))
				throw Object.assign(new Error(`${probe.code}: probe failed`), { code: probe.code });
			return fs.lstatSync(path, options);
		}) as typeof fs.lstatSync,
	};
});

const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

let cwd: string;

beforeEach(async () => {
	cwd = join(await mkdtemp(join(tmpdir(), "atelier-grep-probe-")), "work");
	await mkdir(join(cwd, "src"), { recursive: true });
});

afterEach(async () => {
	probe.code = undefined;
	await rm(join(cwd, ".."), { recursive: true, force: true });
});

for (const code of ["ENAMETOOLONG", "EIO"])
	it.skipIf(!hasRipgrep)(`answers when the notice probe fails with ${code}`, async () => {
		const forged = 'a: binary file matches (found "\\0" byte around offset 1)\nb';
		await writeFile(join(cwd, "src/a"), "plain\n");
		await writeFile(join(cwd, "src", forged), "needle here\n");
		probe.code = code;
		const result = await createGrepTool({ useRipgrep: true }).execute({ pattern: "needle", path: "src" }, { cwd });
		// Whichever way the line is read, the search answers; what it returns is what the path filter lets through.
		expect(result.ok).toBe(true);
		expect(result.output).toContain("src/a");
	});
