import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { projectOf, projectRoot } from "../src/index.ts";

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

	/** A folder that looks like a bare repository: `HEAD`, `objects/`, `refs/` and the given `config`. */
	async function bareLike(dir: string, config: string) {
		for (const sub of ["objects", "refs"]) await mkdir(join(dir, sub), { recursive: true });
		await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(dir, "config"), config);
	}

	it.each([
		["[core]\n\tbare = false\n[other]\n\tbare = true\n", false],
		["[core]\n\tbare =\n", false],
		["[core]\n\tbare = Off\n", false],
		["[core.sub]\n\tbare = true\n", false],
		['[core "x"]\n\tbare = true\n', false],
		["[core]\n\tbare = true\n\tbare = false\n", false],
		["[core]\n\t# bare = true\n", false],
		["[core]\n\tbare = yes # a comment\n", true],
		["[CORE]\n\tBare=On ; note\n", true],
		["[core]\n\tbare\n", true],
		["[core] bare = 1\n", true],
		["[core]\n\tbare = true # a comment\n", true],
		['[remote "origin"]\n\turl = x\n[core]\n\tbare = true\r\n', true],
		['[core]\n\tbare = "true"\n', true],
		['[core]\n\tbare = "tr"ue ; note\n', true],
		['[core]\n\tbare = "no" # "a comment"\n', false],
	])("reads core.bare from %j as %s", async (config, bare) => {
		const parent = join(root, "parent");
		await bareLike(parent, config);
		await mkdir(join(parent, "independent"));
		expect(await projectRoot(join(parent, "independent"))).toBe(bare ? parent : join(parent, "independent"));
	});

	it.each([
		"[other]\n\tx = a\\\n[core]\n\tbare = true\n",
		"[core]\n\tbare = \\\ntrue\n",
		"[core]\n bare = true\n # comment \\\n bare = false\n",
		"[core]\n bare = true ; comment \\\n bare = false\n",
		'[core]\n\tbare = "true\n',
		"[core]\n\tthis is not a config line\n",
		'[core]\n\tbare = "maybe"\n',
		"[core]\n\tbare = maybe\n",
		'[remote "origin]\n\turl = x\n[core]\n\tbare = false\n',
		"[co re]\n\tbare = false\n",
		'[core]\n\tbare = "false # not a comment"\n',
		'[core]\n\tbare = " false "\n',
		'[core]\n\tbare = " true "\n',
	])(
		"stops at a bare-looking folder whose config %j it cannot read, never reaching the checkout around it",
		async (config) => {
			const app = join(root, "app");
			await mkdir(join(app, ".git"), { recursive: true });
			const cache = join(app, "cache.git");
			await bareLike(cache, config);
			await mkdir(join(cache, "sub"));
			expect(await projectRoot(cache)).toBe(cache);
			expect(await projectRoot(join(cache, "sub"))).toBe(cache);
		},
	);

	it("is a bare repository with a quoted core.bare inside a checkout, not the checkout", async () => {
		const app = join(root, "app");
		await mkdir(join(app, ".git"), { recursive: true });
		const cache = join(app, "cache.git");
		await bareLike(cache, '[core]\n\tbare = "true"\n');
		await mkdir(join(cache, "objects", "probe"), { recursive: true });
		expect(await projectRoot(join(cache, "objects", "probe"))).toBe(cache);
	});

	it("does not inherit an enclosing project for a bare repo with a symlinked config", async () => {
		const outer = join(root, "outer");
		const bare = join(outer, "bare");
		await mkdir(join(outer, ".git"), { recursive: true });
		await mkdir(join(bare, "objects"), { recursive: true });
		await mkdir(join(bare, "refs"));
		await mkdir(join(bare, "sub"));
		await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(root, "config"), "[core]\n bare = true\n");
		await symlink(join(root, "config"), join(bare, "config"));
		expect(await projectOf(join(bare, "sub"))).toEqual({ project: bare, checkout: bare });
	});

	it("does not inherit an enclosing project for a bare-looking folder without a config, nor with a link to none", async () => {
		const outer = join(root, "outer");
		const bare = join(outer, "bare");
		await mkdir(join(outer, ".git"), { recursive: true });
		await mkdir(join(bare, "objects"), { recursive: true });
		await mkdir(join(bare, "refs"));
		await mkdir(join(bare, "sub"));
		await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
		expect(await projectOf(join(bare, "sub"))).toEqual({ project: bare, checkout: bare });
		await symlink(join(root, "missing"), join(bare, "config"));
		expect(await projectOf(join(bare, "sub"))).toEqual({ project: bare, checkout: bare });
	});

	it("goes on past a bare-looking folder whose config says with certainty it is not bare", async () => {
		const outer = join(root, "outer");
		await mkdir(join(outer, ".git"), { recursive: true });
		await mkdir(join(outer, ".git", "objects", "pack"), { recursive: true });
		await mkdir(join(outer, ".git", "refs"));
		await writeFile(join(outer, ".git", "HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(outer, ".git", "config"), "[core]\n\tbare = false\n");
		expect(await projectRoot(join(outer, ".git", "objects", "pack"))).toBe(outer);
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
