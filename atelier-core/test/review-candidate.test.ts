import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate, readTreeFile } from "../src/review/candidate.ts";
import { assessRisk } from "../src/review/risk.ts";
import { createRiskTool, RiskRequests } from "../src/review/tool.ts";

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
		await write("src/a.ts", 'export const a = 2;\nexport const b = eval("3");\n');
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
		expect(candidate.signalLines).toEqual([{ path: "src/a.ts", text: 'export const b = eval("3");' }]);
		expect(candidate.fencedDocs).toEqual([]);
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
});

describe("independent verification regressions (U1)", () => {
	it("S3: write-back clean filters cannot change worktree bytes", async () => {
		await write(".gitattributes", "*.ts filter=normalize\n");
		git("config", "filter.normalize.clean", `sh -c 'printf "normalized\\n" > "$1"; cat' -- %f`);
		git("config", "filter.normalize.required", "true");
		await write("src/a.ts", "not normalized\n");
		const result = await freezeCandidate(repo);
		expect(result.ok).toBe(true);
		expect(await readFile(join(repo, "src/a.ts"), "utf8")).toBe("not normalized\n");
		if (result.ok) expect(await readTreeFile(repo, result.candidate.tree, "src/a.ts")).toBe("not normalized\n");
	});

	it("S3: the repository root may end with a space", async () => {
		const moved = `${repo} `;
		execFileSync("mv", [repo, moved]);
		repo = moved;
		await write("src/a.ts", "export const a = 5;\n");
		const result = await freezeCandidate(repo);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.candidate.root.endsWith(" ")).toBe(true);
	});

	it.each(["src/a space.ts", "src/é.ts", 'src/quote".ts'])("S4: patch paths are exact: %s", async (path) => {
		await write(path, "eval(source);\r\n");
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(result.candidate.signalLines).toContainEqual({ path, text: "eval(source);\r" });
	});

	it("S4: size alone never raises risk, and a signal past 8 MiB is still found", async () => {
		await write("src/comment.ts", `// ${"x".repeat(8 * 1024 * 1024)}\n`);
		let result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(assessRisk(result.candidate).level).toBe("medium");
		await write("src/late.ts", "eval(source);\n");
		result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(assessRisk(result.candidate).reasons).toContain("content: src/late.ts adds eval");
	});

	it("S4: specified signals also apply in tests", async () => {
		await write("test/auth.test.ts", "eval(source);\n");
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(assessRisk(result.candidate).level).toBe("high");
	});

	it.each([
		["docs/guide.md", "~~~sh\necho hi\n~~~\n"],
		["docs/config.xml", "<configuration/>\n"],
		["guide.rst", "Notes\n"],
	])("S4: %s is not passive", async (path, text) => {
		await write(path, text);
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(assessRisk(result.candidate).level).toBe("medium");
	});

	it("S4: edits inside an existing code fence are not passive", async () => {
		await write("README.md", "```sh\necho before\n```\n");
		await commitAll();
		await write("README.md", "```sh\necho after\n```\n");
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(assessRisk(result.candidate).level).toBe("medium");
	});

	it("S4: plain documentation changes stay passive", async () => {
		await write("README.md", "# demo\n\nMore words.\n");
		await write("docs/notes.txt", "notes\n");
		const result = await freezeCandidate(repo);
		if (!result.ok) throw new Error(result.reason);
		expect(assessRisk(result.candidate).level).toBe("passive");
	});

	it("S4: the documented lenses input selects the medium lens", async () => {
		const state = new RiskRequests();
		const result = await createRiskTool(state).execute({ lenses: ["resilience"] }, { cwd: repo });
		expect(result.ok).toBe(true);
		expect(state.lens).toBe("resilience");
	});

	it("S4: a reason given with a lens is kept and reported", async () => {
		const state = new RiskRequests();
		const result = await createRiskTool(state).execute(
			{ lenses: ["readability"], reason: "explain lens" },
			{ cwd: repo },
		);
		expect(result.output).toBe("Lens for a medium-risk review: readability (explain lens).");
		expect(state.lensReason).toBe("explain lens");
	});
});
