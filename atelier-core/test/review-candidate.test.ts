import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate, readTreeFile } from "../src/review/candidate.ts";

let root: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const write = async (path: string, text: string) => {
	await mkdir(join(repo, path, ".."), { recursive: true });
	await writeFile(join(repo, path), text);
};
const indexHash = async () =>
	createHash("sha256")
		.update(await readFile(join(repo, ".git", "index")))
		.digest("hex");

async function commitAll(message = "base") {
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-review-"));
	repo = join(root, "repo");
	await mkdir(repo);
	git("init", "-q");
	await write(".gitignore", "ignored.log\n");
	await write("src/a.ts", "export const a = 1;\n");
	await write("README.md", "# demo\n");
	await commitAll();
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("freezeCandidate", () => {
	it("freezes tracked and untracked changes, without ignored files, against HEAD", async () => {
		await write("src/a.ts", "export const a = 2;\nexport const b = 3;\n");
		await write("src/new.ts", "export const n = 1;\n");
		await write("ignored.log", "noise\n");
		await rm(join(repo, "README.md"));

		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		const { candidate } = result;

		expect(candidate.base).toBe(git("rev-parse", "HEAD^{tree}").trim());
		expect(candidate.tree).not.toBe(candidate.base);
		expect(candidate.files.map((file) => [file.path, file.status, file.added, file.deleted])).toEqual([
			["README.md", "D", 0, 1],
			["src/a.ts", "M", 2, 1],
			["src/new.ts", "A", 1, 0],
		]);
		expect(candidate.changedLines).toBe(5);
		expect(candidate.addedLines).toEqual([
			{ path: "src/a.ts", text: "export const a = 2;" },
			{ path: "src/a.ts", text: "export const b = 3;" },
			{ path: "src/new.ts", text: "export const n = 1;" },
		]);
		expect(candidate.scanTruncated).toBe(false);
		expect(await readTreeFile(candidate.root, candidate.tree, "src/new.ts")).toBe("export const n = 1;\n");
		expect(await readTreeFile(candidate.root, candidate.tree, "ignored.log")).toBeUndefined();
		expect(await readTreeFile(candidate.root, candidate.base, "README.md")).toBe("# demo\n");
	});

	it("leaves the user's index and worktree exactly as they were, staged changes included", async () => {
		await write("src/a.ts", "export const a = 2;\n");
		git("add", "src/a.ts");
		await write("src/a.ts", "export const a = 3;\n");
		await write("src/new.ts", "untracked\n");
		const statusBefore = git("status", "--porcelain");
		const indexBefore = await indexHash();

		const result = await freezeCandidate(repo);

		expect(result.ok).toBe(true);
		expect(git("status", "--porcelain")).toBe(statusBefore);
		expect(await indexHash()).toBe(indexBefore);
		expect(await readFile(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 3;\n");
		if (result.ok) expect(await readTreeFile(repo, result.candidate.tree, "src/a.ts")).toBe("export const a = 3;\n");
	});

	it("reports an empty candidate when nothing changed", async () => {
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.tree).toBe(result.candidate.base);
		expect(result.candidate.files).toEqual([]);
		expect(result.candidate.changedLines).toBe(0);
	});

	it("freezes the whole repository from a subdirectory, with root-relative paths", async () => {
		await write("README.md", "# changed\n");
		const result = await freezeCandidate(join(repo, "src"));
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.root).toBe(
			execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim(),
		);
		expect(result.candidate.files.map((file) => file.path)).toEqual(["README.md"]);
	});

	it("keeps the old and new text of changed package.json files for the risk check", async () => {
		await write("package.json", '{"dependencies":{"a":"1"}}\n');
		await commitAll("pkg");
		await write("package.json", '{"dependencies":{"a":"2"}}\n');
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.manifests).toEqual([
			{ path: "package.json", before: '{"dependencies":{"a":"1"}}\n', after: '{"dependencies":{"a":"2"}}\n' },
		]);
	});

	it("marks binary files and file modes", async () => {
		await writeFile(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
		await write("run.sh", "echo hi\n");
		execFileSync("chmod", ["+x", join(repo, "run.sh")]);
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.files).toEqual([
			{ path: "logo.bin", status: "A", added: 0, deleted: 0, binary: true, mode: "100644" },
			{ path: "run.sh", status: "A", added: 1, deleted: 0, binary: false, mode: "100755" },
		]);
	});

	it("is unavailable outside a git repository", async () => {
		const plain = join(root, "plain");
		await mkdir(plain);
		const result = await freezeCandidate(plain);
		expect(result).toEqual({ ok: false, reason: "The folder is not inside a git repository." });
	});

	it("is unavailable in a repository without commits", async () => {
		const fresh = join(root, "fresh");
		await mkdir(fresh);
		execFileSync("git", ["init", "-q"], { cwd: fresh });
		await writeFile(join(fresh, "a.txt"), "a\n");
		const result = await freezeCandidate(fresh);
		expect(result).toEqual({
			ok: false,
			reason: "The repository has no commits yet, so there is no HEAD to compare with.",
		});
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: fresh, encoding: "utf8" })).toBe("?? a.txt\n");
	});

	it("ignores GIT_INDEX_FILE and GIT_DIR from the environment", async () => {
		await write("src/a.ts", "export const a = 9;\n");
		const indexBefore = await indexHash();
		const saved = { index: process.env.GIT_INDEX_FILE, dir: process.env.GIT_DIR };
		process.env.GIT_INDEX_FILE = join(repo, ".git", "index");
		process.env.GIT_DIR = join(root, "nowhere");
		try {
			const result = await freezeCandidate(repo);
			expect(result.ok).toBe(true);
		} finally {
			if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
			else process.env.GIT_INDEX_FILE = saved.index;
			if (saved.dir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved.dir;
		}
		expect(await indexHash()).toBe(indexBefore);
	});

	it("stops scanning added lines past the scan limit and says so", async () => {
		await write("big.txt", `${"x".repeat(99)}\n`.repeat(200));
		const result = await freezeCandidate(repo, { scanLimitBytes: 4096 });
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.scanTruncated).toBe(true);
		expect(result.candidate.addedLines.length).toBeLessThan(200);
		expect(result.candidate.files[0]?.added).toBe(200);
	});
});
