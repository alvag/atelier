import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../src/review/candidate.ts";
import { createWorkspace, type Workspace } from "../src/review/workspace.ts";
import { sweepStaleScratch } from "../src/scratch.ts";
import { createBashTool } from "../src/tools/index.ts";

let root: string;
let repo: string;
const workspaces: Workspace[] = [];

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const write = async (path: string, text: string) => {
	await mkdir(join(repo, path, ".."), { recursive: true });
	await writeFile(join(repo, path), text);
};
const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

async function commitAll() {
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
}

async function workspaceOf(feature?: string): Promise<Workspace> {
	const frozen = await freezeCandidate(repo);
	if (!frozen.ok) throw new Error(frozen.reason);
	const workspace = await createWorkspace({
		root: frozen.candidate.root,
		base: frozen.candidate.base,
		tree: frozen.candidate.tree,
		...(feature === undefined ? {} : { feature }),
	});
	workspaces.push(workspace);
	return workspace;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-workspace-"));
	repo = join(root, "repo");
	await mkdir(repo);
	git("init", "-q");
	await write(".gitignore", "node_modules\nignored.log\n");
	await write("src/a.ts", "export const a = 1;\n");
	await write("run.sh", "#!/bin/sh\n");
	await chmod(join(repo, "run.sh"), 0o755);
	await commitAll();
});
afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.remove();
	await rm(root, { recursive: true, force: true });
});

describe("createWorkspace", () => {
	it("writes the candidate and the base side by side, from the frozen trees", async () => {
		await write("src/a.ts", "export const a = 2;\n");
		await write("src/new.ts", "export const n = 1;\n");
		await write("ignored.log", "noise\n");
		await symlink("a.ts", join(repo, "src/link.ts"));
		const workspace = await workspaceOf();

		expect(await readFile(join(workspace.dir, "candidate/src/a.ts"), "utf8")).toBe("export const a = 2;\n");
		expect(await readFile(join(workspace.dir, "candidate/src/new.ts"), "utf8")).toBe("export const n = 1;\n");
		expect(await readlink(join(workspace.dir, "candidate/src/link.ts"))).toBe("a.ts");
		expect(await exists(join(workspace.dir, "candidate/ignored.log"))).toBe(false);
		expect(await readFile(join(workspace.dir, "base/src/a.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(await exists(join(workspace.dir, "base/src/new.ts"))).toBe(false);
		expect((await stat(join(workspace.dir, "candidate/run.sh"))).mode & 0o111).not.toBe(0);
		expect((await stat(join(workspace.dir, "candidate/src/a.ts"))).mode & 0o111).toBe(0);
		expect(await exists(join(workspace.dir, "candidate/.git"))).toBe(false);
	});

	it("shows the verifier only its copies, and a sweep deletes them once its process is dead", async () => {
		const previous = process.env.TMPDIR;
		const tmp = join(root, "tmp");
		await mkdir(tmp);
		process.env.TMPDIR = tmp;
		try {
			await write("src/a.ts", "export const a = 2;\n");
			const frozen = await freezeCandidate(repo);
			if (!frozen.ok) throw new Error(frozen.reason);
			expect(git("ls-tree", "-r", "--name-only", frozen.candidate.tree).split("\n").filter(Boolean).sort()).toEqual([
				".gitignore",
				"run.sh",
				"src/a.ts",
			]);
			const workspace = await workspaceOf();
			expect((await readdir(workspace.dir)).sort()).toEqual(["base", "candidate"]);
			const diff = spawnSync("git", ["diff", "--no-index", "--name-only", "base", "candidate"], {
				cwd: workspace.dir,
				encoding: "utf8",
			});
			expect(diff.stdout).toBe("candidate/src/a.ts\n");

			const dead = { isAlive: () => false, startedAt: async () => undefined };
			expect(await sweepStaleScratch({ tmpRoot: tmp, processes: dead })).toHaveLength(1);
			expect(await readdir(tmp)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
		}
	});

	it("leaves the user's worktree, index and refs untouched", async () => {
		await write("src/a.ts", "export const a = 2;\n");
		await write("staged.ts", "x\n");
		git("add", "staged.ts");
		const snapshot = async () => ({
			status: git("status", "--porcelain=v2", "--untracked-files=all"),
			index: (await readFile(join(repo, ".git", "index"))).toString("base64"),
			refs: git("for-each-ref") + git("rev-parse", "HEAD"),
			a: await readFile(join(repo, "src/a.ts"), "utf8"),
		});
		const before = await snapshot();
		const workspace = await workspaceOf();
		await workspace.remove();
		expect(await snapshot()).toEqual(before);
		expect(await exists(workspace.dir)).toBe(false);
	});

	it("links the installed dependencies, pointing workspace packages at the copy's own code", async () => {
		await write("node_modules/dep/index.js", "module.exports = 'dep';\n");
		await write("node_modules/@scope/pkg/index.js", "module.exports = 'scoped';\n");
		await write("pkgs/lib/index.js", "module.exports = 'base lib';\n");
		await write("pkgs/app/package.json", "{}\n");
		await mkdir(join(repo, "pkgs/app/node_modules"), { recursive: true });
		await symlink("../../lib", join(repo, "pkgs/app/node_modules/lib"));
		await commitAll();
		await write("pkgs/lib/index.js", "module.exports = 'candidate lib';\n");
		const workspace = await workspaceOf();

		expect(await readFile(join(workspace.dir, "candidate/node_modules/dep/index.js"), "utf8")).toContain("dep");
		expect(await readFile(join(workspace.dir, "candidate/node_modules/@scope/pkg/index.js"), "utf8")).toContain(
			"scoped",
		);
		expect(await readFile(join(workspace.dir, "candidate/pkgs/app/node_modules/lib/index.js"), "utf8")).toContain(
			"candidate lib",
		);
		expect(await readFile(join(workspace.dir, "base/pkgs/app/node_modules/lib/index.js"), "utf8")).toContain(
			"base lib",
		);
		expect(workspace.dependencies).toContain("node_modules");
		expect(workspace.dependencies).toContain("pkgs/app/node_modules");
		expect(workspace.dependencies).toContain("Installing is not possible");
	});

	it("gives the copies their own files: writing in them leaves the user's dependencies and a hard-linked store alone", async () => {
		await write("node_modules/dep/index.js", "original\n");
		await mkdir(join(root, "store"));
		await writeFile(join(root, "store/file.js"), "store\n");
		await link(join(root, "store/file.js"), join(repo, "node_modules/dep/linked.js"));
		await symlink("dep/index.js", join(repo, "node_modules/alias.js"));
		const workspace = await workspaceOf();
		const copy = join(workspace.dir, "candidate/node_modules");

		expect(await readlink(join(copy, "alias.js"))).toBe("dep/index.js");
		await writeFile(join(copy, "dep/index.js"), "changed\n");
		await writeFile(join(copy, "dep/linked.js"), "changed\n");
		await writeFile(join(copy, "alias.js"), "changed\n");
		expect(await readFile(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("original\n");
		expect(await readFile(join(root, "store/file.js"), "utf8")).toBe("store\n");
		expect(workspace.dependencies).toContain("copied");
	});

	it("leaves no link that leads outside the directory: the project's are re-pointed at the copy, the others removed", async () => {
		await write("node_modules/dep/index.js", "dep\n");
		await write("lib/index.js", "base lib\n");
		await mkdir(join(root, "outside"));
		await writeFile(join(root, "outside/secret"), "secret\n");
		await symlink(join(repo, "lib"), join(repo, "node_modules/abs-lib"));
		await symlink(join(root, "outside/secret"), join(repo, "node_modules/abs-outside"));
		await symlink("../../../outside/secret", join(repo, "node_modules/rel-outside"));
		await commitAll();
		const workspace = await workspaceOf();
		const copy = join(workspace.dir, "candidate/node_modules");

		expect(await readFile(join(copy, "abs-lib/index.js"), "utf8")).toBe("base lib\n");
		expect(await realpath(join(copy, "abs-lib"))).toBe(await realpath(join(workspace.dir, "candidate/lib")));
		expect(await lstat(join(copy, "abs-outside")).catch(() => undefined)).toBeUndefined();
		expect(await lstat(join(copy, "rel-outside")).catch(() => undefined)).toBeUndefined();
		expect(workspace.dependencies).toContain("2 symbolic links that pointed outside the project were left out.");
	});

	it("also drops a symbolic link of the tracked files that leaves the directory", async () => {
		await mkdir(join(root, "outside"));
		await symlink("../../outside", join(repo, "escape"));
		await commitAll();
		const workspace = await workspaceOf();
		expect(await lstat(join(workspace.dir, "candidate/escape")).catch(() => undefined)).toBeUndefined();
		expect(workspace.dependencies).toContain("1 symbolic link that pointed outside the project was left out.");
	});

	it("never deletes the user's dependencies when the copy is removed", async () => {
		await write("node_modules/dep/index.js", "kept\n");
		const workspace = await workspaceOf();
		await workspace.remove();
		expect(await readFile(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("kept\n");
	});

	it("says what is missing when the project has no installed dependencies", async () => {
		const workspace = await workspaceOf();
		expect(await lstat(join(workspace.dir, "candidate/node_modules")).catch(() => undefined)).toBeUndefined();
		expect(workspace.dependencies).toContain("no node_modules directory was found");
		expect(workspace.dependencies).toContain("unverified");
	});

	it("copies the feature document inside the directory", async () => {
		const doc = join(root, "feature.md");
		await writeFile(doc, "# feature\n");
		const workspace = await workspaceOf(doc);
		expect(workspace.feature).toBe("feature/feature.md");
		expect(await readFile(join(workspace.dir, "feature/feature.md"), "utf8")).toBe("# feature\n");
		expect((await workspaceOf(join(root, "missing.md"))).feature).toBeUndefined();
	});

	it("rejects when a tree cannot be read", async () => {
		await expect(createWorkspace({ root: repo, base: "0".repeat(40), tree: "1".repeat(40) })).rejects.toThrow();
	});
});

describe("createBashTool", () => {
	const ctx = { cwd: tmpdir() };

	it("keeps asking for approval by default, as the main agent's bash does", () => {
		expect(createBashTool().approvalCommand({ command: "ls" })).toBe("ls");
	});

	it("runs without approval when told, with the extra variables and without the credentials", async () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-secret";
		try {
			const tool = createBashTool({ withoutApproval: true, env: { npm_config_offline: "true" } });
			expect(tool.approvalCommand({ command: "ls" })).toBeUndefined();
			const result = await tool.execute({ command: 'echo "[$npm_config_offline][$ANTHROPIC_API_KEY]"' }, ctx);
			expect(result.output).toContain("[true][]");
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});
});
