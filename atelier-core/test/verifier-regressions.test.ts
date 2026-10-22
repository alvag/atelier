import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Session } from "../src/session.ts";
import { createGrepTool, readTool } from "../src/tools/index.ts";

// Regressions found by the independent verification of the U3b hardening (S5, L4).

let cwd: string;
let previous: string | undefined;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "u3b-regression-"));
	previous = process.env.TMPDIR;
	process.env.TMPDIR = cwd;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previous;
	await rm(cwd, { recursive: true, force: true });
});

it("rejects a NUL byte after the first block", async () => {
	await writeFile(join(cwd, "f"), Buffer.concat([Buffer.alloc(65536, 65), Buffer.from([0])]));
	expect(await readTool.execute({ path: "f" }, { cwd })).toMatchObject({ ok: false, output: "Binary file: f" });
});

it.each([true, false])("cancels a search aborted during path validation (ripgrep: %s)", async (useRipgrep) => {
	await writeFile(join(cwd, "f"), "hit");
	const controller = new AbortController();
	const pending = createGrepTool({ useRipgrep }).execute({ pattern: "hit" }, { cwd, signal: controller.signal });
	controller.abort();
	expect(await pending).toMatchObject({ ok: false, output: "Search aborted." });
});

it.each([true, false])("supports globs with a directory (ripgrep: %s)", async (useRipgrep) => {
	await mkdir(join(cwd, "src"));
	await mkdir(join(cwd, "lib"));
	await writeFile(join(cwd, "src/a.ts"), "hit\n");
	await writeFile(join(cwd, "lib/b.ts"), "hit\n");
	expect((await createGrepTool({ useRipgrep }).execute({ pattern: "hit", glob: "src/*.ts" }, { cwd })).output).toBe(
		"src/a.ts:1:hit",
	);
});

it.each([true, false])("keeps grep output within 50 KB (ripgrep: %s)", async (useRipgrep) => {
	await writeFile(join(cwd, "wide.txt"), Array.from({ length: 100 }, () => "é".repeat(700)).join("\n"));
	const result = await createGrepTool({ useRipgrep }).execute({ pattern: "é" }, { cwd });
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(51_200);
});

it("removes the scratch directory when the backend fails to start", async () => {
	await expect(
		Session.start({
			cwd,
			tools: [],
			backend: {
				id: "bad",
				start: async () => {
					throw Error("start failed");
				},
			},
		}),
	).rejects.toThrow("start failed");
	expect(await readdir(cwd)).toEqual([]);
});

it("removes the scratch directory when the backend close throws synchronously", async () => {
	const session = await Session.start({
		cwd,
		tools: [],
		backend: {
			id: "bad",
			start: async () => ({
				async *send() {},
				interrupt: async () => {},
				close: () => {
					throw Error("close failed");
				},
			}),
		},
	});
	await Promise.resolve()
		.then(() => session.close())
		.catch(() => {});
	expect(await readdir(cwd)).toEqual([]);
});
