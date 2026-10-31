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
		/** A file whose `open` fails with this code, as if it changed after git listed it. */
		failOpen: undefined as { name: string; code: string } | undefined,
		/** Runs as an untracked file's `lstat` starts. */
		onLstat: undefined as (() => void) | undefined,
	};
	return state;
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const open: typeof fs.open = async (...args) => {
		const failure = reads.failOpen;
		if (failure !== undefined && String(args[0]).endsWith(`/${failure.name}`))
			throw Object.assign(new Error(failure.code), { code: failure.code });
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
	const lstat = ((...args: Parameters<typeof fs.lstat>) => {
		reads.onLstat?.();
		return fs.lstat(...args);
	}) as typeof fs.lstat;
	return { ...fs, default: { ...fs, open, lstat }, open, lstat };
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
	reads.failOpen = undefined;
	reads.onLstat = undefined;
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

	it("skips a file gone before it opens, and omits the lines for any other failure", async () => {
		reads.release();
		await writeFile(join(base, "other"), "three\n");
		reads.failOpen = { name: "untracked", code: "ENOENT" };
		expect(await readGitChanges(base, undefined, { timeoutMs: 30_000 })).toEqual({ lines: { added: 1, removed: 0 } });
		for (const code of ["ELOOP", "EACCES"]) {
			reads.failOpen = { name: "untracked", code };
			expect(await readGitChanges(base, undefined, { timeoutMs: 30_000 })).toEqual({});
		}
	});

	it("leaves no unhandled rejection when the call is cancelled as a file check starts", async () => {
		const unhandled: unknown[] = [];
		const onRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const controller = new AbortController();
			// Gone by then: the check itself fails, after the call has given up on it.
			reads.onLstat = () => {
				controller.abort();
				reads.onLstat = undefined;
				execFileSync("rm", [join(base, "untracked")]);
			};
			expect(await readGitChanges(base, controller.signal, { timeoutMs: 30_000 })).toEqual({});
			// Let a rejection left without a handler surface.
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});
