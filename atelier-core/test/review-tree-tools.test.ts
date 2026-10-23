import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Candidate, freezeCandidate } from "../src/review/candidate.ts";
import { createTreeTools } from "../src/review/tree-tools.ts";
import { MAX_GREP_MATCHES } from "../src/tools/limits.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

let root: string;
let repo: string;
let candidate: Candidate;
let read: ToolDefinition;
let grep: ToolDefinition;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const write = async (path: string, text: string) => {
	await mkdir(join(repo, path, ".."), { recursive: true });
	await writeFile(join(repo, path), text);
};
const run = (tool: ToolDefinition, input: unknown) => tool.execute(input, { cwd: "/nonexistent" });

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-tree-tools-"));
	repo = join(root, "repo");
	await mkdir(repo);
	git("init", "-q");
	await write(".gitignore", "ignored.log\n");
	await write("src/a.ts", "export const a = 1;\n");
	await write("README.md", "# demo\n");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");

	await write("src/a.ts", "line one\nline two\nline three\nneedle here\n");
	await write("src/new.ts", "export const needle = 1;\n");
	await write("docs/notes.md", "needle in docs\n");
	await write("ignored.log", "needle ignored\n");
	await writeFile(join(repo, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	const frozen = await freezeCandidate(repo);
	if (!frozen.ok) throw new Error(frozen.reason);
	candidate = frozen.candidate;
	[read, grep] = createTreeTools(candidate.root, candidate.tree) as [ToolDefinition, ToolDefinition];
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("createTreeTools", () => {
	it("offers read-only read and grep that never ask for approval", () => {
		expect([read.name, grep.name]).toEqual(["read", "grep"]);
		expect(Object.keys(read.inputShape)).toEqual(["path", "offset", "limit"]);
		expect(Object.keys(grep.inputShape)).toEqual(["pattern", "path", "glob"]);
		expect(read.approvalCommand({ path: "src/a.ts" })).toBeUndefined();
		expect(grep.approvalCommand({ pattern: "x" })).toBeUndefined();
	});

	it("reads the frozen bytes, not what is on disk now", async () => {
		await write("src/a.ts", "changed after freeze\n");
		await rm(join(repo, "src/new.ts"));
		const outcome = await run(read, { path: "src/a.ts" });
		expect(outcome.ok).toBe(true);
		expect(outcome.output).toBe("1\tline one\n2\tline two\n3\tline three\n4\tneedle here");
		expect((await run(read, { path: "src/new.ts" })).output).toBe("1\texport const needle = 1;");
	});

	it("pages with offset and limit and says how to continue", async () => {
		const outcome = await run(read, { path: "src/a.ts", offset: 2, limit: 2 });
		expect(outcome.output).toBe("2\tline two\n3\tline three\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]");
		expect(outcome.truncated).toBe(true);
		const beyond = await run(read, { path: "src/a.ts", offset: 9 });
		expect(beyond.ok).toBe(false);
		expect(beyond.output).toBe("Offset 9 is beyond the end of src/a.ts (4 lines).");
	});

	it("fails clearly for missing, ignored and binary files", async () => {
		const missing = await run(read, { path: "src/nope.ts" });
		expect(missing).toMatchObject({ ok: false, output: "Not found in the frozen change: src/nope.ts" });
		expect((await run(read, { path: "ignored.log" })).output).toBe("Not found in the frozen change: ignored.log");
		expect(await run(read, { path: "blob.bin" })).toMatchObject({ ok: false, output: "Binary file: blob.bin" });
	});

	it("lists a directory", async () => {
		const outcome = await run(read, { path: "src" });
		expect(outcome.ok).toBe(true);
		expect(outcome.output).toBe("a.ts\nnew.ts");
	});

	it("rejects absolute paths and escapes from the repository", async () => {
		for (const path of ["/etc/passwd", "../outside.txt", "src/../../outside.txt"]) {
			const outcome = await run(read, { path });
			expect(outcome.ok).toBe(false);
			expect(outcome.output).toBe(`Path is outside the repository: ${path}`);
		}
		const search = await run(grep, { pattern: "x", path: "../" });
		expect(search).toMatchObject({ ok: false, output: "Path is outside the repository: ../" });
	});

	it("greps the frozen tree, with path and glob filters", async () => {
		await write("src/a.ts", "nothing matches now\n");
		const all = await run(grep, { pattern: "needle" });
		expect(all.ok).toBe(true);
		expect(all.output.split("\n").sort()).toEqual([
			"docs/notes.md:1:needle in docs",
			"src/a.ts:4:needle here",
			"src/new.ts:1:export const needle = 1;",
		]);
		expect(all.summary).toBe("needle: 3 matches");

		expect((await run(grep, { pattern: "needle", path: "src" })).output.split("\n").sort()).toEqual([
			"src/a.ts:4:needle here",
			"src/new.ts:1:export const needle = 1;",
		]);
		expect((await run(grep, { pattern: "needle", path: "src/a.ts" })).output).toBe("src/a.ts:4:needle here");
		expect((await run(grep, { pattern: "needle", glob: "*.md" })).output).toBe("docs/notes.md:1:needle in docs");
		expect((await run(grep, { pattern: "needle", path: "src", glob: "new.*" })).output).toBe(
			"src/new.ts:1:export const needle = 1;",
		);
	});

	it("never shows ignored files or binary matches", async () => {
		expect((await run(grep, { pattern: "needle ignored" })).output).toBe("No matches.");
		expect((await run(grep, { pattern: ".", glob: "*.bin" })).output).toBe("No matches.");
	});

	it("reports no matches and bad patterns", async () => {
		const none = await run(grep, { pattern: "zzz-not-there" });
		expect(none).toMatchObject({
			ok: true,
			output: "No matches.",
			summary: "zzz-not-there: no matches",
			truncated: false,
		});
		const bad = await run(grep, { pattern: "(" });
		expect(bad.ok).toBe(false);
	});

	it("caps the number of matches", async () => {
		const many = Array.from({ length: MAX_GREP_MATCHES + 20 }, (_, i) => `hit ${i}`).join("\n");
		await write("many.txt", many);
		const frozen = await freezeCandidate(repo);
		if (!frozen.ok) throw new Error(frozen.reason);
		const [, bigGrep] = createTreeTools(frozen.candidate.root, frozen.candidate.tree) as [
			ToolDefinition,
			ToolDefinition,
		];
		const outcome = await run(bigGrep, { pattern: "^hit", path: "many.txt" });
		expect(outcome.truncated).toBe(true);
		expect(outcome.output.split("\n").filter((line) => line.startsWith("many.txt:"))).toHaveLength(MAX_GREP_MATCHES);
		expect(outcome.output).toContain("[Showing the first 100 matches.");
	});

	it("says when a file over 8 MiB was read only in part, without its cut last line", async () => {
		const line = `${"x".repeat(99)}\n`;
		await write("big.txt", line.repeat(Math.ceil((9 * 1024 * 1024) / line.length)));
		const frozen = await freezeCandidate(repo);
		if (!frozen.ok) throw new Error(frozen.reason);
		const [bigRead] = createTreeTools(frozen.candidate.root, frozen.candidate.tree) as [ToolDefinition];
		const fullLines = Math.floor((8 * 1024 * 1024) / line.length);
		const outcome = await run(bigRead, { path: "big.txt", offset: fullLines - 1 });
		expect(outcome.ok).toBe(true);
		expect(outcome.truncated).toBe(true);
		expect(outcome.summary).toBe(`big.txt (first ${fullLines} lines of a file over 8 MiB)`);
		expect(outcome.output).toBe(
			[
				`${fullLines - 1}\t${"x".repeat(99)}`,
				`${fullLines}\t${"x".repeat(99)}`,
				"",
				`[Only the first 8 MiB of big.txt were read: ${fullLines} complete lines. Use grep to search the rest.]`,
			].join("\n"),
		);
	});
});
