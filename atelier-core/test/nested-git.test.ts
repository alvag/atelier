import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBackend, type FakeStep, Session } from "../src/index.ts";
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
const present = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

// Each bash test starts the real sandbox and asks git for the protected places at each command.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-nested-git-")));
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

/** A repository with one commit and an empty `sub/`. */
async function repo(dir: string): Promise<string> {
	await mkdir(join(dir, "sub"), { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	await writeFile(join(dir, "a.txt"), "a\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	return dir;
}

/** A folder that is not in a repository. */
async function plain(): Promise<string> {
	const dir = join(base, "plain");
	await mkdir(dir);
	return dir;
}

const run = (cwd: string, command: string) => createBashTool({ sandbox }).execute({ command }, { cwd });

describe.skipIf(!onMac)("bash cannot create, replace or write a .git below the working directory", () => {
	it.each([
		["a directory", "mkdir sub/.git"],
		["a .git file that points git elsewhere", "printf 'gitdir: /tmp/x\\n' > sub/.git"],
		["a link to another git directory", "ln -s ../.git sub/.git"],
		["git init in a subfolder", "cd sub && git init -q"],
		["a deeper one", "mkdir -p sub/a/b && mkdir sub/a/b/.git"],
		["one moved into place", "mkdir d && mv d sub/.git"],
		["one created through a link to its name", "ln -s sub/.git alias && echo x > alias"],
	])("refuses %s", async (_, command) => {
		const cwd = await repo(join(base, "main"));
		const result = await run(cwd, command);
		expect(result.output).toContain("Operation not permitted");
		expect(await present(join(cwd, "sub", ".git"))).toBe(false);
		expect(await present(join(cwd, "sub", "a", "b", ".git"))).toBe(false);
	});

	it("leaves an existing nested repository's configuration, hooks and link alone, with a working directory that is not the process's", async () => {
		const cwd = await repo(join(base, "main"));
		expect(process.cwd()).not.toBe(cwd);
		git(join(cwd, "sub"), "init", "-q");
		await mkdir(join(cwd, "linked"));
		await symlink(join(cwd, "sub", ".git"), join(cwd, "linked", ".git"));
		const config = await readFile(join(cwd, "sub", ".git", "config"), "utf8");
		const result = await run(
			cwd,
			"echo x >> sub/.git/config; echo x > sub/.git/hooks/pre-commit; ln -sfn /tmp linked/.git; rm sub/.git/HEAD",
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(4);
		expect(await readFile(join(cwd, "sub", ".git", "config"), "utf8")).toBe(config);
		expect(await present(join(cwd, "sub", ".git", "hooks", "pre-commit"))).toBe(false);
		expect(await readlink(join(cwd, "linked", ".git"))).toBe(join(cwd, "sub", ".git"));
		expect(await present(join(cwd, "sub", ".git", "HEAD"))).toBe(true);
	});

	it("still cannot replace a .git at the top that is a link to the git directory", async () => {
		const cwd = await repo(join(base, "main"));
		const real = join(outside, "gitdir");
		execFileSync("mv", [join(cwd, ".git"), real]);
		await symlink(real, join(cwd, ".git"));
		const result = await run(cwd, "rm .git; ln -sfn /tmp .git; ln -s /tmp x && mv -f x .git");
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(3);
		expect(await readlink(join(cwd, ".git"))).toBe(real);
	});

	it.each([
		["outside a repository", plain],
		["in a subfolder of a repository", async () => join(await repo(join(base, "main")), "sub")],
	])("refuses a .git at the top of the working directory %s", async (_, make) => {
		const cwd = await make();
		const result = await run(cwd, "printf 'gitdir: /tmp/x\\n' > .git; mkdir .git");
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await present(join(cwd, ".git"))).toBe(false);
	});

	it("still works in the repository, writes names that only start with .git, and inits repositories in the temporary directory", async () => {
		const cwd = await repo(join(base, "main"));
		const result = await run(
			cwd,
			[
				"echo t > t.txt && git add t.txt && git commit -qm t",
				"echo x > sub/.gitignore && mkdir -p sub/.github && echo x > sub/.github/ci.yml",
				'mkdir -p "$TMPDIR/fixture" && git init -q "$TMPDIR/fixture" && echo inited',
			].join(" && "),
		);
		expect(result.output).not.toContain("Operation not permitted");
		expect(result.ok, result.output).toBe(true);
		expect(result.output).toContain("inited");
	});
});

/** Runs the calls as one turn of a session in `cwd` and answers every question with yes. */
async function turn(cwd: string, calls: FakeStep[]) {
	const backend = new FakeBackend([[...calls, finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createWriteTool({ home }), createEditTool({ home })],
		approve: async () => true,
	});
	for await (const _ of session.send("go"));
	await session.close();
	return backend.toolResults;
}
const writeCall = (path: string, callId: string): FakeStep => ({
	toolCall: { tool: "write", input: { path, content: "new\n" }, callId },
});
const editCall = (path: string, callId: string): FakeStep => ({
	toolCall: { tool: "edit", input: { path, edits: [{ oldText: "old", newText: "new" }] }, callId },
});
const refusal = (path: string) => ({
	ok: false,
	output: `${path} is git state that runs code: the agent does not write it.`,
});

describe("edit and write refuse a .git below the working directory, without asking", () => {
	it("refuses creating one, or a file in one, at any depth, in any letter case or through a link", async () => {
		const cwd = await repo(join(base, "main"));
		await symlink(join(cwd, "sub"), join(cwd, "link"));
		const results = await turn(cwd, [
			writeCall("sub/.git", "w1"),
			writeCall("sub/.git/config", "w2"),
			writeCall("sub/a/b/.git/HEAD", "w3"),
			writeCall("SUB/.GIT", "w4"),
			writeCall("link/.git", "w5"),
		]);
		expect(results).toEqual([
			refusal("sub/.git"),
			refusal("sub/.git/config"),
			refusal("sub/a/b/.git/HEAD"),
			refusal("SUB/.GIT"),
			refusal("link/.git"),
		]);
		expect(await present(join(cwd, "sub", ".git"))).toBe(false);
	});

	it("refuses editing an existing nested repository's files", async () => {
		const cwd = await repo(join(base, "main"));
		git(join(cwd, "sub"), "init", "-q");
		await writeFile(join(cwd, "sub", ".git", "description"), "old\n");
		const results = await turn(cwd, [editCall("sub/.git/description", "e1")]);
		expect(results).toEqual([refusal("sub/.git/description")]);
	});

	it("refuses a .git at the top of a working directory that has none", async () => {
		const cwd = await plain();
		expect(await turn(cwd, [writeCall(".git", "w1")])).toEqual([refusal(".git")]);
	});

	it("still writes names that only start with .git, and the repository's own metadata", async () => {
		const cwd = await repo(join(base, "main"));
		const results = await turn(cwd, [
			writeCall("sub/.gitignore", "w1"),
			writeCall("sub/.github/ci.yml", "w2"),
			writeCall(".git/description", "w3"),
		]);
		expect(results.map((r) => r.ok)).toEqual([true, true, true]);
	});
});
