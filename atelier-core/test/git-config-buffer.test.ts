import type { SpawnSyncOptions } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createWriteTool } from "../src/tools/write.ts";
import { gitConfigFixture } from "./support/git-config-cases.ts";

const git = vi.hoisted(() => ({
	file: "",
	forceSuccessfulExit: false,
	runs: [] as {
		args: readonly string[];
		maxBuffer: number | undefined;
		bytes: number;
		code: string | undefined;
		status: number | null;
	}[],
}));
vi.mock("node:child_process", async (original) => {
	const cp = await original<typeof import("node:child_process")>();
	return {
		...cp,
		spawnSync(command: string, args: readonly string[], options: SpawnSyncOptions) {
			const run = cp.spawnSync(command, args, options);
			if (command !== "git" || args[0] !== "config" || args[2] !== git.file) return run;
			const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
			// Reproduce the exit/overflow race without depending on whether git exits before Node kills it.
			if (git.forceSuccessfulExit && code === "ENOBUFS") run.status = 0;
			git.runs.push({ args, maxBuffer: options.maxBuffer, bytes: run.stdout.length, code, status: run.status });
			return run;
		},
	};
});

it.each([false, true])(
	"bounds real Git output and preserves public write protection on overflow, successful exit=%s",
	async (forceSuccessfulExit) => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "git-config-buffer-")));
		try {
			const { cwd, home } = await gitConfigFixture(base, "combined output exceeds the finite buffer");
			git.file = join(cwd, ".git", "config");
			git.forceSuccessfulExit = forceSuccessfulExit;
			git.runs.length = 0;
			// This include is after the truncated output, and a simple parser mishandles its quoted '#'.
			const path = join(cwd, "team#cfg");
			const before = await readFile(path, "utf8");
			const tool = createWriteTool({ home });
			const input = { path, content: "[core]\nhooksPath = evil-hooks\n" };
			const message = `${path} is git state that runs code: the agent does not write it.`;
			expect(await tool.gate?.(input, { cwd })).toEqual({ refusal: { output: message, summary: message } });
			expect(await tool.execute(input, { cwd })).toMatchObject({ ok: false, output: message });
			expect(await readFile(path, "utf8")).toBe(before);
			expect(git.runs[0]?.maxBuffer).toBe(3 * 1024 * 1024 + 64 * 1024);
			expect(git.runs).toHaveLength(8);
			for (const offset of [0, 4]) {
				const combined = git.runs[offset];
				expect(combined?.code).toBe("ENOBUFS");
				// Node can read a final chunk past maxBuffer, but must not capture the full 4.5 MiB output.
				expect(combined?.bytes).toBeLessThan(4 * 1024 * 1024);
				if (forceSuccessfulExit) expect(combined?.status).toBe(0);
				const legacy = git.runs.slice(offset + 1, offset + 4);
				expect(legacy.map((run) => run.args)).toEqual([
					["config", "--file", git.file, "--no-includes", "-z", "--get-all", "include.path"],
					["config", "--file", git.file, "--no-includes", "-z", "--get-regexp", "^includeif\\..*\\.path$"],
					["config", "--file", git.file, "--no-includes", "-z", "--get", "core.hooksPath"],
				]);
				expect(legacy.map((run) => run.maxBuffer)).toEqual(Array(3).fill(1024 * 1024));
			}
		} finally {
			git.file = "";
			await rm(base, { recursive: true, force: true });
		}
	},
	30_000,
);
