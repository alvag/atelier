import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitChanges } from "../src/tui/git-branch.ts";

/** Holds every read of an untracked file until released, and says when one started. */
const reads = vi.hoisted(() => {
	let release = () => {};
	let started = () => {};
	const state = {
		held: Promise.resolve(),
		started: Promise.resolve(),
		hold() {
			state.held = new Promise<void>((resolve) => {
				release = resolve;
			});
			state.started = new Promise<void>((resolve) => {
				started = resolve;
			});
		},
		release: () => release(),
		begin: () => started(),
	};
	return state;
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const open: typeof fs.open = async (...args) => {
		const file = await fs.open(...args);
		const read = file.read.bind(file) as (...rest: unknown[]) => Promise<unknown>;
		Object.assign(file, {
			read: async (...rest: unknown[]) => {
				reads.begin();
				await reads.held;
				return read(...rest);
			},
		});
		return file;
	};
	return { ...fs, default: { ...fs, open }, open };
});

let base: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: base });
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-git-reads-"));
	git("init", "-q", "-b", "main");
	await writeFile(join(base, "untracked"), "one\ntwo\n");
	reads.hold();
});
afterEach(async () => {
	reads.release();
	await rm(base, { recursive: true, force: true });
});

describe("reading untracked files", () => {
	it("counts them once their reads finish", async () => {
		const pending = readGitChanges(base, undefined, { timeoutMs: 30_000 });
		await reads.started;
		reads.release();
		expect(await pending).toEqual({ lines: { added: 2, removed: 0 } });
	});

	it("gives up a read held past an abort, without the lines", async () => {
		const controller = new AbortController();
		const pending = readGitChanges(base, controller.signal, { timeoutMs: 30_000 });
		await reads.started;
		controller.abort();
		// Still held: the call ends without it.
		expect(await pending).toEqual({});
	});

	it("gives up a read held past the deadline, without the lines", { timeout: 15_000 }, async () => {
		const started = Date.now();
		expect(await readGitChanges(base, undefined, { timeoutMs: 2000 })).toEqual({});
		expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
	});
});
