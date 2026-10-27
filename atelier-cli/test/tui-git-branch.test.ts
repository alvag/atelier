import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitBranch } from "../src/tui/git-branch.ts";

let base: string;
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-branch-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

/** A repository at `dir` whose HEAD says `head`, without running git. */
const repo = async (dir: string, head: string) => {
	await mkdir(join(dir, ".git"), { recursive: true });
	await writeFile(join(dir, ".git", "HEAD"), `${head}\n`);
};

describe("git branch", () => {
	it("is the branch HEAD names, from the working directory or a folder inside it", async () => {
		await repo(base, "ref: refs/heads/feat/status-line");
		await mkdir(join(base, "src", "tui"), { recursive: true });
		expect(await readGitBranch(base)).toBe("feat/status-line");
		expect(await readGitBranch(join(base, "src", "tui"))).toBe("feat/status-line");
	});

	it("is the short commit of a detached HEAD", async () => {
		await repo(base, "0123456789abcdef0123456789abcdef01234567");
		expect(await readGitBranch(base)).toBe("0123456");
	});

	it("follows the .git file of a linked worktree to its own HEAD", async () => {
		const main = join(base, "main");
		await repo(main, "ref: refs/heads/main");
		const gitDir = join(main, ".git", "worktrees", "wt");
		await mkdir(gitDir, { recursive: true });
		await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/feat/wt\n");
		const worktree = join(base, "wt");
		await mkdir(worktree);
		await writeFile(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
		expect(await readGitBranch(worktree)).toBe("feat/wt");
	});

	it("is nothing outside a repository or with a HEAD it cannot read", async () => {
		// The checkout around `outside` stands for one the temporary directory may be in; the ceiling keeps it out of reach.
		await repo(base, "ref: refs/heads/main");
		const outside = join(base, "outside");
		await mkdir(outside);
		vi.stubEnv("GIT_CEILING_DIRECTORIES", base);
		expect(await readGitBranch(outside)).toBeUndefined();
		await writeFile(join(outside, ".git"), "not a gitdir line\n");
		expect(await readGitBranch(outside)).toBeUndefined();
	});

	it("walks up past folders that are not ceilings", async () => {
		await repo(base, "ref: refs/heads/main");
		const deep = join(base, "inner", "deep");
		await mkdir(deep, { recursive: true });
		vi.stubEnv("GIT_CEILING_DIRECTORIES", `relative:${deep}`);
		expect(await readGitBranch(deep)).toBe("main");
	});
});
