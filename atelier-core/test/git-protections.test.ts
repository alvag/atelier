import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApprovalRequest, FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";
import { isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";

const onMac = process.platform === "darwin" && !isInsideSandbox();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

let base: string;
let outside: string;
let home: string;
let temp: string;
let sandbox: Sandbox;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-git-protections-")));
	outside = join(base, "outside");
	home = join(base, "home");
	temp = join(base, "temp");
	for (const dir of [outside, home, temp]) await mkdir(dir, { recursive: true });
	sandbox = new Sandbox({ home, tempDir: temp });
});

afterEach(async () => {
	await sandbox.reset();
	await rm(base, { recursive: true, force: true });
});

/** A repository with one commit. */
async function repo(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	await writeFile(join(dir, "a.txt"), "a\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	return dir;
}

/** Runs the calls as one turn of a session in `cwd` and answers every question with yes. */
async function turn(cwd: string, calls: FakeStep[]) {
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[...calls, finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createWriteTool({ home }), createEditTool({ home })],
		approve: async (request) => {
			questions.push(request);
			return true;
		},
	});
	for await (const _ of session.send("go"));
	await session.close();
	return { questions, results: backend.toolResults };
}
const writeCall = (path: string, callId = "w"): FakeStep => ({
	toolCall: { tool: "write", input: { path, content: "new\n" }, callId },
});
const editCall = (path: string, oldText: string, callId = "e"): FakeStep => ({
	toolCall: { tool: "edit", input: { path, edits: [{ oldText, newText: "edited" }] }, callId },
});
const refusal = (path: string) => ({
	ok: false,
	output: `${path} is git state that runs code: the agent does not write it.`,
});

describe("edit and write refuse the git places that run code, without asking", () => {
	it("(a) refuses the hooks directory core.hooksPath names in a main checkout", async () => {
		const cwd = await repo(join(base, "main"));
		git(cwd, "config", "core.hooksPath", ".hooks");
		await mkdir(join(cwd, ".hooks"));
		await writeFile(join(cwd, ".hooks", "pre-commit"), "old\n");
		const { questions, results } = await turn(cwd, [
			editCall(".hooks/pre-commit", "old"),
			writeCall(".hooks/pre-commit", "w1"),
			writeCall(".hooks/post-commit", "w2"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			refusal(".hooks/pre-commit"),
			refusal(".hooks/pre-commit"),
			refusal(".hooks/post-commit"),
		]);
		expect(await readFile(join(cwd, ".hooks", "pre-commit"), "utf8")).toBe("old\n");
		expect(await exists(join(cwd, ".hooks", "post-commit"))).toBe(false);
	});

	it("(a) refuses a core.hooksPath outside the working directory, which would otherwise be asked about", async () => {
		const cwd = await repo(join(base, "main"));
		const hooks = join(outside, "hooks");
		await mkdir(hooks);
		await writeFile(join(hooks, "pre-commit"), "old\n");
		git(cwd, "config", "core.hooksPath", hooks);
		const { questions, results } = await turn(cwd, [
			editCall(join(hooks, "pre-commit"), "old"),
			writeCall(join(hooks, "post-commit"), "w1"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([refusal(join(hooks, "pre-commit")), refusal(join(hooks, "post-commit"))]);
		expect(await readFile(join(hooks, "pre-commit"), "utf8")).toBe("old\n");
	});

	it("(b) refuses the .git file of a linked worktree", async () => {
		const main = await repo(join(base, "main"));
		const cwd = join(base, "wt");
		git(main, "worktree", "add", "-q", "--detach", cwd);
		const before = await readFile(join(cwd, ".git"), "utf8");
		const { questions, results } = await turn(cwd, [editCall(".git", "gitdir"), writeCall(".git", "w1")]);
		expect(questions).toEqual([]);
		expect(results).toEqual([refusal(".git"), refusal(".git")]);
		expect(await readFile(join(cwd, ".git"), "utf8")).toBe(before);
	});

	it("(c) refuses the repository's git state through ../ from a subdirectory", async () => {
		const top = await repo(join(base, "main"));
		const cwd = join(top, "sub");
		await mkdir(cwd);
		await mkdir(join(top, ".git", "hooks"), { recursive: true });
		await writeFile(join(top, ".git", "hooks", "pre-commit"), "old\n");
		const config = await readFile(join(top, ".git", "config"), "utf8");
		const { questions, results } = await turn(cwd, [
			editCall("../.git/config", "bare"),
			writeCall("../.git/config", "w1"),
			writeCall("../.git/hooks/x", "w2"),
			editCall("../.git/hooks/pre-commit", "old", "e2"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			refusal("../.git/config"),
			refusal("../.git/config"),
			refusal("../.git/hooks/x"),
			refusal("../.git/hooks/pre-commit"),
		]);
		expect(await readFile(join(top, ".git", "config"), "utf8")).toBe(config);
		expect(await exists(join(top, ".git", "hooks", "x"))).toBe(false);
	});

	it("outside a git repository, edit and write work as before", async () => {
		const cwd = join(base, "plain");
		await mkdir(cwd);
		await writeFile(join(cwd, "a.txt"), "old\n");
		const { questions, results } = await turn(cwd, [editCall("a.txt", "old"), writeCall("b.txt", "w1")]);
		expect(questions).toEqual([]);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("edited\n");
		expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("new\n");
	});
});

describe.skipIf(!onMac)("the agent's bash in the sandbox keeps those places, and normal git work", () => {
	const run = (cwd: string, command: string) => createBashTool({ sandbox }).execute({ command }, { cwd });

	it("(a) cannot write the hooks directory core.hooksPath names in a main checkout", async () => {
		const cwd = await repo(join(base, "main"));
		git(cwd, "config", "core.hooksPath", ".hooks");
		await mkdir(join(cwd, ".hooks"));
		await writeFile(join(cwd, ".hooks", "pre-commit"), "old\n");
		const result = await run(cwd, "echo x >> .hooks/pre-commit; echo x > .hooks/post-commit");
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await readFile(join(cwd, ".hooks", "pre-commit"), "utf8")).toBe("old\n");
		expect(await exists(join(cwd, ".hooks", "post-commit"))).toBe(false);
	});

	it("(b) cannot write the .git file of a linked worktree", async () => {
		const main = await repo(join(base, "main"));
		const cwd = join(base, "wt");
		git(main, "worktree", "add", "-q", "--detach", cwd);
		const before = await readFile(join(cwd, ".git"), "utf8");
		const result = await run(cwd, "echo 'gitdir: /elsewhere' > .git");
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await readFile(join(cwd, ".git"), "utf8")).toBe(before);
	});

	it("(c) cannot write the repository's git state from a subdirectory", async () => {
		const top = await repo(join(base, "main"));
		const cwd = join(top, "sub");
		await mkdir(cwd);
		const config = await readFile(join(top, ".git", "config"), "utf8");
		const result = await run(cwd, "echo x >> ../.git/config; echo x > ../.git/hooks/x");
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await readFile(join(top, ".git", "config"), "utf8")).toBe(config);
		expect(await exists(join(top, ".git", "hooks", "x"))).toBe(false);
	});

	const WORK = [
		"git switch -q -c topic",
		"echo t > t.txt && git add t.txt && git commit -qm t",
		"git switch -q main",
		"git merge -q --ff-only topic",
		"git switch -q -c side && echo s > s.txt && git add s.txt && git commit -qm s",
		"git switch -q main && echo m > m.txt && git add m.txt && git commit -qm m",
		"git merge -q --no-ff -m merged side",
		"echo wip >> a.txt && git stash -q && git stash pop -q && git checkout -q -- a.txt",
		"git switch -q -c one && echo 1 > a.txt && git commit -qam one",
		"git switch -q main && git switch -q -c two && echo 2 > a.txt && git commit -qam two",
		"! git merge one",
		"git merge --abort",
		"git tag v1 && git tag -a v2 -m v2 && git pack-refs --all && git tag -d v1",
		"git log --format=%s | head -3",
	].join(" && ");

	for (const kind of ["main checkout", "linked worktree"] as const)
		for (const hooks of ["none", "inside", "outside"] as const)
			it(`still commits, branches, stashes, merges, tags and packs refs: ${kind}, hooksPath ${hooks}`, async () => {
				const main = await repo(join(base, "main"));
				const cwd = kind === "main checkout" ? main : join(outside, "wt");
				if (kind === "linked worktree") git(main, "worktree", "add", "-q", "--detach", cwd);
				if (hooks === "inside") {
					git(main, "config", "core.hooksPath", ".hooks");
					await mkdir(join(cwd, ".hooks"), { recursive: true });
				}
				if (hooks === "outside") {
					git(main, "config", "core.hooksPath", join(base, "hooks"));
					await mkdir(join(base, "hooks"));
				}
				if (kind === "linked worktree") git(cwd, "switch", "-q", "-c", "main-wt");
				const result = await run(cwd, WORK.replaceAll("main", kind === "linked worktree" ? "main-wt" : "main"));
				expect(result.output).not.toContain("Operation not permitted");
				expect(result.ok, result.output).toBe(true);
				expect(result.output).toContain("merged");
			});
});

describe("when git cannot answer inside a repository, the protection holds anyway", () => {
	/** A repository whose included configuration is broken from outside the agent, as a bad merge or a tool could leave it. */
	async function broken() {
		const cwd = await repo(join(base, "main"));
		git(cwd, "config", "core.hooksPath", ".hooks");
		git(cwd, "config", "include.path", join(cwd, "included"));
		await mkdir(join(cwd, ".hooks"));
		await writeFile(join(cwd, ".hooks", "pre-commit"), "old\n");
		await writeFile(join(cwd, "included"), "[invalid\n");
		expect(() => git(cwd, "rev-parse", "--git-dir")).toThrow();
		return cwd;
	}

	it("edit and write refuse the hooks directory, without asking", async () => {
		const cwd = await broken();
		const { questions, results } = await turn(cwd, [
			editCall(".hooks/pre-commit", "old"),
			writeCall(".hooks/pre-commit", "w1"),
			writeCall(".git/hooks/x", "w2"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([refusal(".hooks/pre-commit"), refusal(".hooks/pre-commit"), refusal(".git/hooks/x")]);
		expect(await readFile(join(cwd, ".hooks", "pre-commit"), "utf8")).toBe("old\n");
	}, 30_000);

	it.skipIf(!onMac)("bash cannot write the hooks directory", async () => {
		const cwd = await broken();
		const result = await createBashTool({ sandbox }).execute({ command: "echo x > .hooks/pre-commit" }, { cwd });
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await readFile(join(cwd, ".hooks", "pre-commit"), "utf8")).toBe("old\n");
	});
});

describe("files the repository configuration includes run code too", () => {
	async function withIncludes() {
		const cwd = await repo(join(base, "main"));
		await writeFile(join(cwd, "extra.cfg"), "[user]\n\tname = x\n");
		await writeFile(join(cwd, "cond.cfg"), "[user]\n\tname = y\n");
		await writeFile(join(cwd, "deep.cfg"), "[user]\n\tname = z\n");
		await writeFile(join(cwd, "extra.cfg"), "[include]\n\tpath = deep.cfg\n");
		git(cwd, "config", "include.path", "../extra.cfg");
		git(cwd, "config", "includeIf.gitdir:/nowhere/.path", join(cwd, "cond.cfg"));
		return cwd;
	}

	it("edit and write refuse an included file, one named by includeIf and one included by an included file", async () => {
		const cwd = await withIncludes();
		const { questions, results } = await turn(cwd, [
			editCall("extra.cfg", "deep"),
			writeCall("cond.cfg", "w1"),
			writeCall("deep.cfg", "w2"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([refusal("extra.cfg"), refusal("cond.cfg"), refusal("deep.cfg")]);
		expect(await readFile(join(cwd, "cond.cfg"), "utf8")).toBe("[user]\n\tname = y\n");
	});

	it.skipIf(!onMac)("bash cannot replace them", async () => {
		const cwd = await withIncludes();
		const result = await createBashTool({ sandbox }).execute(
			{ command: "echo x > extra.cfg; echo x > cond.cfg; echo x > deep.cfg" },
			{ cwd },
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(3);
		expect(await readFile(join(cwd, "cond.cfg"), "utf8")).toBe("[user]\n\tname = y\n");
	});

	it("outside the repository's own files, an unrelated file is still written without asking", async () => {
		const cwd = await withIncludes();
		const { questions, results } = await turn(cwd, [writeCall("other.cfg")]);
		expect(questions).toEqual([]);
		expect(results[0]?.ok).toBe(true);
	});
});

describe("attributes and submodule git directories", () => {
	it("edit and write refuse info/attributes and a submodule's config, without asking", async () => {
		const cwd = await repo(join(base, "main"));
		await mkdir(join(cwd, ".git", "info"), { recursive: true });
		await mkdir(join(cwd, ".git", "modules", "x"), { recursive: true });
		await writeFile(join(cwd, ".git", "modules", "x", "config"), "old\n");
		const { questions, results } = await turn(cwd, [
			writeCall(".git/info/attributes"),
			editCall(".git/modules/x/config", "old"),
			writeCall(".git/modules/x/hooks/pre-commit", "w2"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			refusal(".git/info/attributes"),
			refusal(".git/modules/x/config"),
			refusal(".git/modules/x/hooks/pre-commit"),
		]);
	});

	it.skipIf(!onMac)("bash cannot write them", async () => {
		const cwd = await repo(join(base, "main"));
		await mkdir(join(cwd, ".git", "info"), { recursive: true });
		await mkdir(join(cwd, ".git", "modules", "x"), { recursive: true });
		const result = await createBashTool({ sandbox }).execute(
			{ command: "echo x > .git/info/attributes; echo x > .git/modules/x/config" },
			{ cwd },
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await exists(join(cwd, ".git", "info", "attributes"))).toBe(false);
	});
});

describe("a .git that is a link to a directory", () => {
	async function linked() {
		const cwd = await repo(join(base, "main"));
		const real = join(outside, "gitdir");
		execFileSync("mv", [join(cwd, ".git"), real]);
		await symlink(real, join(cwd, ".git"));
		return { cwd, real };
	}

	it("edit and write protect the same subset as a plain .git: metadata is writable, config and hooks are not", async () => {
		const { cwd } = await linked();
		const { results } = await turn(cwd, [
			writeCall(".git/metadata", "w1"),
			writeCall(".git/description", "w2"),
			writeCall(".git/config", "w3"),
			writeCall(".git/hooks/x", "w4"),
		]);
		expect(results.map((r) => r.ok)).toEqual([true, true, false, false]);
		expect(results[2]).toEqual(refusal(".git/config"));
	});
});
