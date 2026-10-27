import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitBranch } from "../src/tui/git-branch.ts";

let base: string;
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-branch-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.doUnmock("node:path");
	vi.resetModules();
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
		vi.stubEnv("GIT_CEILING_DIRECTORIES", ["relative", deep].join(delimiter));
		expect(await readGitBranch(deep)).toBe("main");
	});

	it("stops below a ceiling named through a symlink, and ignores one that does not exist", async () => {
		await repo(base, "ref: refs/heads/main");
		const real = join(base, "real");
		await mkdir(join(real, "outside"), { recursive: true });
		await symlink(real, join(base, "link"));
		vi.stubEnv("GIT_CEILING_DIRECTORIES", [join(base, "gone"), join(base, "link")].join(delimiter));
		expect(await readGitBranch(join(real, "outside"))).toBeUndefined();
		vi.stubEnv("GIT_CEILING_DIRECTORIES", join(base, "gone"));
		expect(await readGitBranch(join(real, "outside"))).toBe("main");
	});

	it("splits the ceilings on the platform's path list separator", async () => {
		// Windows separates them with ";", which never splits a drive letter's colon.
		vi.doMock("node:path", async (original) => ({ ...(await original<typeof import("node:path")>()), delimiter: ";" }));
		vi.resetModules();
		const { readGitBranch: read } = await import("../src/tui/git-branch.ts");
		await repo(base, "ref: refs/heads/main");
		const outside = join(base, "outside");
		await mkdir(outside);
		vi.stubEnv("GIT_CEILING_DIRECTORIES", `${join(base, "gone")};${base}`);
		expect(await read(outside)).toBeUndefined();
	});
});
