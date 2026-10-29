import { type SpawnOptions, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/tools/index.ts";

const stream = vi.hoisted(() => ({ chunks: undefined as string[] | undefined }));
vi.mock("node:child_process", async (original) => {
	const cp = await original<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	return {
		...cp,
		spawn(command: string, args: readonly string[], options: SpawnOptions) {
			if (command !== "rg") return cp.spawn(command, args, options);
			// Real searches need a deterministic binary-then-text order, not a production sorting option.
			if (stream.chunks === undefined) return cp.spawn(command, ["--sort", "path", ...args], options);
			const chunks = stream.chunks;
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: () => true,
			});
			queueMicrotask(() => {
				for (const chunk of chunks) child.stdout.emit("data", chunk);
				child.emit("close", 0);
			});
			return child;
		},
	};
});

const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-grep-warnings-"));
	await mkdir(join(cwd, "src"));
});

afterEach(async () => {
	stream.chunks = undefined;
	await rm(cwd, { recursive: true, force: true });
});

for (const outside of [false, true]) {
	describe(`ripgrep stdout warnings, outside=${outside}`, () => {
		const tool = createGrepTool({ useRipgrep: true, outside });

		it.skipIf(!hasRipgrep)(
			"keeps the text match after a real binary-file warning without counting the warning",
			async () => {
				await writeFile(join(cwd, "src/a.bin"), `TOKEN\n${"x".repeat(200_000)}\0\n`);
				await writeFile(join(cwd, "src/b.txt"), "TOKEN\n");
				const raw = spawnSync("rg", ["--no-config", "--sort", "path", "TOKEN", "src"], { cwd, encoding: "utf8" });
				expect(raw.stdout).toContain("src/a.bin: WARNING: stopped searching binary file after match");
				for (const limit of [undefined, 2]) {
					expect(await tool.execute({ pattern: "TOKEN", path: "src", limit }, { cwd })).toEqual({
						ok: true,
						output: "src/a.bin:1:TOKEN\nsrc/b.txt:1:TOKEN",
						summary: "TOKEN: 2 matches",
						truncated: false,
					});
				}
				expect(await tool.execute({ pattern: "TOKEN", path: "src", limit: 1 }, { cwd })).toEqual({
					ok: true,
					output:
						"src/a.bin:1:TOKEN\n\n[Showing the first 1 matches. Narrow the pattern, path or glob, or call grep again with limit: 2.]",
					summary: "TOKEN: 1+ matches",
					truncated: true,
				});
			},
		);

		it.skipIf(!hasRipgrep).each(["a: WARNING: b.bin", "WARNING: b.bin"])(
			"shows and counts a real binary-match diagnostic for %s",
			async (path) => {
				await writeFile(join(cwd, path), Buffer.from("TOKEN\n\0tail\n"));
				expect(await tool.execute({ pattern: "TOKEN", path, limit: 1 }, { cwd })).toEqual({
					ok: true,
					output: `${path}: binary file matches (found "\\0" byte around offset 6)`,
					summary: "TOKEN: 1 matches",
					truncated: false,
				});
			},
		);

		it.each(["src/a.bin: WARNING: arbitrary notice", "WARNING: arbitrary notice", ".env: WARNING: private notice"])(
			"discards %s across chunk boundaries, including at end of output",
			async (warning) => {
				await writeFile(join(cwd, "src/a.bin"), "TOKEN\n");
				await writeFile(join(cwd, "src/b.txt"), "TOKEN\n");
				stream.chunks = [
					warning.slice(0, 4),
					`${warning.slice(4)}\nsrc/a.bin\0`,
					`1:TOKEN\n${warning}\n`,
					"src/b.txt\0",
					`1:TOKEN\n${warning}\n`,
				];
				expect(await tool.execute({ pattern: "TOKEN", path: "src", limit: 2 }, { cwd })).toEqual({
					ok: true,
					output: "src/a.bin:1:TOKEN\nsrc/b.txt:1:TOKEN",
					summary: "TOKEN: 2 matches",
					truncated: false,
				});
			},
		);

		it("preserves context and warning-looking match text", async () => {
			await writeFile(join(cwd, "src/a.txt"), "TOKEN\nWARNING: actual content\nafter\n");
			stream.chunks = [
				"src/a.txt\x001:TOKEN\nsrc/a.txt: WARNING: arbitrary notice\n",
				"src/a.txt\x002:WARNING: actual content\nsrc/a.txt\x003-after\n",
			];
			expect(await tool.execute({ pattern: "TOKEN|WARNING", path: "src", context: 1 }, { cwd })).toEqual({
				ok: true,
				output: "src/a.txt:1:TOKEN\nsrc/a.txt:2:WARNING: actual content\nsrc/a.txt-3-after",
				summary: "TOKEN|WARNING: 2 matches",
				truncated: false,
			});
		});

		it.each(["a: WARNING: forged notice\nb.txt", "WARNING: forged notice\nb.txt"])(
			"keeps a whole filename containing %s, even when its NUL arrives later",
			async (name) => {
				await writeFile(join(cwd, "src/a"), "plain\n");
				await writeFile(join(cwd, "src", name), "TOKEN\n");
				const nl = name.indexOf("\n");
				stream.chunks = [`src/${name.slice(0, nl + 1)}`, `${name.slice(nl + 1)}\0`, "1:TOKEN\n"];
				expect(await tool.execute({ pattern: "TOKEN", path: "src" }, { cwd })).toEqual({
					ok: true,
					output: `src/${name}:1:TOKEN`,
					summary: "TOKEN: 1 matches",
					truncated: false,
				});
			},
		);

		it("never reattributes a protected filename containing a warning to a public file", async () => {
			await mkdir(join(cwd, "home/.ssh"), { recursive: true });
			const forged = "a: WARNING: forged notice\nb.txt";
			await writeFile(join(cwd, "home/.ssh", forged), "PRIVATE_MARKER\n");
			await writeFile(join(cwd, "b.txt"), "plain\n");
			stream.chunks = [`home/.ssh/${forged}\0`, "1:PRIVATE_MARKER\n"];
			expect(
				await createGrepTool({ useRipgrep: true, outside, home: join(cwd, "home") }).execute(
					{ pattern: "MARKER" },
					{ cwd },
				),
			).toEqual({ ok: true, output: "No matches.", summary: "MARKER: no matches", truncated: false });
		});
	});
}
