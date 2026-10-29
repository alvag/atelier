import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { projectRoot } from "../src/index.ts";

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "atelier-project-root-")));
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

describe("projectRoot", () => {
	it("is the folder itself outside git", async () => {
		await mkdir(join(root, "notes"));
		expect(await projectRoot(join(root, "notes"))).toBe(join(root, "notes"));
	});

	it("is the checkout's root from a subfolder", async () => {
		await mkdir(join(root, "app", ".git"), { recursive: true });
		await mkdir(join(root, "app", "src", "lib"), { recursive: true });
		expect(await projectRoot(join(root, "app", "src", "lib"))).toBe(join(root, "app"));
	});

	it("is the real path, through a symbolic link", async () => {
		await mkdir(join(root, "app", ".git"), { recursive: true });
		await symlink(join(root, "app"), join(root, "link"));
		expect(await projectRoot(join(root, "link"))).toBe(join(root, "app"));
	});

	it("is the main checkout for a linked worktree", async () => {
		const main = join(root, "main");
		await mkdir(main);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "x");
		git(main, "worktree", "add", "-q", join(root, "wt"));
		await mkdir(join(root, "wt", "sub"));
		expect(await projectRoot(join(root, "wt", "sub"))).toBe(main);
	});

	it("is the folder itself when its .git file claims a worktree the main checkout does not know", async () => {
		const main = join(root, "main");
		await mkdir(main);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "x");
		const forged = join(root, "forged");
		await mkdir(join(forged, "metadata"), { recursive: true });
		await writeFile(join(forged, ".git"), "gitdir: metadata\n");
		await writeFile(join(forged, "metadata", "commondir"), `${join(main, ".git")}\n`);
		expect(await projectRoot(forged)).toBe(forged);
		// Under the main checkout's worktrees too, a git directory that points back at another folder is not this one's.
		git(main, "worktree", "add", "-q", join(root, "wt"));
		await mkdir(join(root, "other"));
		await writeFile(join(root, "other", ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
		expect(await projectRoot(join(root, "other"))).toBe(join(root, "other"));
		expect(await projectRoot(join(root, "wt"))).toBe(main);
		// A .git that is a link to a registered worktree's .git file is not that worktree.
		await mkdir(join(root, "linked"));
		await symlink(join(root, "wt", ".git"), join(root, "linked", ".git"));
		expect(await projectRoot(join(root, "linked"))).toBe(join(root, "linked"));
	});

	it("uses the bare repository's common directory from a subfolder", async () => {
		const bare = join(root, "bare.git");
		git(root, "init", "--bare", "-q", bare);
		await mkdir(join(bare, "objects", "probe"));
		expect(await projectRoot(join(bare, "objects", "probe"))).toBe(bare);
		expect(await projectRoot(bare)).toBe(bare);
	});

	it("is a submodule's own folder, and the folder holding a .git file it cannot follow", async () => {
		await mkdir(join(root, "app", ".git", "modules", "lib"), { recursive: true });
		await mkdir(join(root, "app", "lib"), { recursive: true });
		await writeFile(join(root, "app", "lib", ".git"), "gitdir: ../.git/modules/lib\n");
		expect(await projectRoot(join(root, "app", "lib"))).toBe(join(root, "app", "lib"));
		await mkdir(join(root, "odd"));
		await writeFile(join(root, "odd", ".git"), "nothing here");
		expect(await projectRoot(join(root, "odd"))).toBe(join(root, "odd"));
	});
});
