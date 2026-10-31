import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readGitChanges } from "../src/tui/git-branch.ts";

const swap = vi.hoisted(() => ({
	before: undefined as undefined | ((path: string) => Promise<void>),
	after: undefined as undefined | ((path: string) => Promise<void>),
	beforeRealpath: undefined as undefined | ((path: string) => Promise<void>),
	afterRealpath: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	return {
		...real,
		lstat: async (...args: Parameters<typeof real.lstat>) => {
			await swap.before?.(String(args[0]));
			const result = await real.lstat(...args);
			await swap.after?.(String(args[0]));
			return result;
		},
		realpath: async (...args: Parameters<typeof real.realpath>) => {
			await swap.beforeRealpath?.(String(args[0]));
			const result = await real.realpath(...args);
			await swap.afterRealpath?.(String(args[0]));
			return result;
		},
	};
});

let root: string;
let cwd: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
beforeEach(async () => {
	// Its real path, as the worktree's own (macOS's temporary folder is under a symlink).
	root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "git-header-security-")));
	cwd = join(root, "repo");
	await fs.mkdir(cwd);
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	await fs.writeFile(join(cwd, ".gitattributes"), "*.dat diff=odd\n");
	git("add", ".");
	git("commit", "-qm", "base");
});
afterEach(async () => {
	swap.before = undefined;
	swap.after = undefined;
	swap.beforeRealpath = undefined;
	swap.afterRealpath = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

// D-6: O_NOFOLLOW must protect ancestor components, not just the final file.
it("does not read outside the worktree through a replaced ancestor", async () => {
	const dir = join(cwd, "pending");
	const outside = join(root, "outside");
	await fs.mkdir(dir);
	await fs.mkdir(outside);
	await fs.writeFile(join(dir, "file"), "inside\n");
	await fs.writeFile(join(outside, "file"), "outside\n".repeat(23));
	let swapped = false;
	swap.after = async (path) => {
		if (path !== join(dir, "file")) return;
		swap.after = undefined;
		await fs.rename(dir, join(root, "parked"));
		await fs.symlink(outside, dir);
		swapped = true;
	};
	const changes = await readGitChanges(cwd);
	expect(swapped).toBe(true);
	expect(changes.lines?.added).not.toBe(23);
});

/** `pending`, a folder of the worktree, and a folder outside it with a 23-line `file` that a symlink can stand in for. */
async function ancestors() {
	const dir = join(cwd, "pending");
	const outside = join(root, "outside");
	await fs.mkdir(dir);
	await fs.mkdir(outside);
	await fs.writeFile(join(dir, "file"), "inside\n");
	await fs.writeFile(join(outside, "file"), "outside\n".repeat(23));
	const parked = join(root, "parked");
	return {
		file: join(dir, "file"),
		swapIn: async () => {
			await fs.rename(dir, parked);
			await fs.symlink(outside, dir);
		},
		swapBack: async () => {
			await fs.rm(dir);
			await fs.rename(parked, dir);
		},
	};
}

it("does not read outside the worktree through an ancestor replaced before the file's check", async () => {
	const { file, swapIn } = await ancestors();
	let swapped = false;
	swap.before = async (path) => {
		if (path !== file) return;
		swap.before = undefined;
		await swapIn();
		swapped = true;
	};
	const changes = await readGitChanges(cwd, undefined, { timeoutMs: 30_000 });
	expect(swapped).toBe(true);
	expect(changes.lines).toBeUndefined();
});

it("does not publish what it read outside the worktree when every check before the read passed", async () => {
	const { file, swapIn, swapBack } = await ancestors();
	const steps: string[] = [];
	const step = (name: string, action: () => Promise<void>) => async (path: string) => {
		if (path !== file || steps.includes(name)) return;
		steps.push(name);
		await action();
	};
	// The file's check and the open both go through the symlink, the path check between them does not; only the
	// checks after the read can tell.
	let lstats = 0;
	swap.before = async (path) => {
		if (path !== file) return;
		lstats++;
		if (lstats === 1) await step("in before lstat", swapIn)(path);
		if (lstats === 2) await step("back before the last lstat", swapBack)(path);
	};
	swap.beforeRealpath = step("back before realpath", swapBack);
	swap.afterRealpath = step("in before open", swapIn);
	const changes = await readGitChanges(cwd, undefined, { timeoutMs: 30_000 });
	expect(steps).toEqual(["in before lstat", "back before realpath", "in before open", "back before the last lstat"]);
	expect(changes.lines).toBeUndefined();
});

it("counts the file as usual when nothing is replaced", async () => {
	await ancestors();
	expect(await readGitChanges(cwd, undefined, { timeoutMs: 30_000 })).toEqual({ lines: { added: 1, removed: 0 } });
});

// D-2/D-5: preserve a bad setting or omit the counter; never silently ignore it.
it.each(["true\t", "true\nfalse", "false\r"])("does not ignore diff binary %j", async (value) => {
	git("config", "diff.odd.binary", value);
	await fs.writeFile(join(cwd, "file.dat"), "one\ntwo\n");
	const index = await fs.readFile(join(cwd, ".git", "index"));
	const changes = await readGitChanges(cwd);
	expect(await fs.readFile(join(cwd, ".git", "index"))).toEqual(index);
	git("add", "-N", "file.dat");
	expect(() => git("diff", "--numstat", "HEAD")).toThrow(/bad boolean config value/);
	expect(changes.lines).toBeUndefined();
});
