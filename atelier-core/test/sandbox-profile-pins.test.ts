import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-profile-pins-")));
	home = join(base, "home");
	temp = join(base, "temp");
	for (const dir of [home, temp]) await mkdir(dir, { recursive: true });
	sandbox = new Sandbox({ home, tempDir: temp });
});

afterEach(async () => {
	await sandbox.reset();
	await rm(base, { recursive: true, force: true });
});

async function repo(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	await writeFile(join(dir, "a.txt"), "a\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	return dir;
}

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
	output: `${path} is Atelier profile configuration: the agent does not write it.`,
});

describe("edit and write refuse the profile files, without asking", () => {
	it("refuses the local pin in a main checkout", async () => {
		const cwd = await repo(join(base, "main"));
		await mkdir(join(cwd, ".git", "atelier"));
		await writeFile(join(cwd, ".git", "atelier", "profile-pin.json"), "old\n");
		const { questions, results } = await turn(cwd, [
			writeCall(".git/atelier/profile-pin.json"),
			editCall(".git/atelier/profile-pin.json", "old"),
			writeCall(".git/atelier/other.json", "w2"),
		]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			refusal(".git/atelier/profile-pin.json"),
			refusal(".git/atelier/profile-pin.json"),
			refusal(".git/atelier/other.json"),
		]);
		expect(await readFile(join(cwd, ".git", "atelier", "profile-pin.json"), "utf8")).toBe("old\n");
	});

	it("refuses the local pin of a linked worktree, which lives in the main checkout's git directory", async () => {
		const main = await repo(join(base, "main"));
		const cwd = join(base, "wt");
		git(main, "worktree", "add", "-q", "--detach", cwd);
		const pin = join(main, ".git", "atelier", "profile-pin.json");
		const { questions, results } = await turn(cwd, [writeCall(pin)]);
		expect(questions).toEqual([]);
		expect(results).toEqual([refusal(pin)]);
		expect(await exists(pin)).toBe(false);
	});

	it("refuses ~/.atelier/profiles.json", async () => {
		const cwd = await repo(join(base, "main"));
		await mkdir(join(home, ".atelier"));
		const file = join(home, ".atelier", "profiles.json");
		await writeFile(file, "old\n");
		const { questions, results } = await turn(cwd, [writeCall(file), editCall(file, "old", "e2")]);
		expect(questions).toEqual([]);
		// Already refused today, by the protected-location check rather than the profile message.
		expect(results.map((r) => r.ok)).toEqual([false, false]);
		expect(await readFile(file, "utf8")).toBe("old\n");
	});
});

describe.skipIf(!onMac)("the agent's bash in the sandbox cannot write the profile files", () => {
	const run = (cwd: string, command: string) => createBashTool({ sandbox }).execute({ command }, { cwd });

	it("cannot write the local pin in a main checkout", async () => {
		const cwd = await repo(join(base, "main"));
		const result = await run(cwd, "mkdir -p .git/atelier; echo x > .git/atelier/profile-pin.json");
		expect(result.output).toContain("Operation not permitted");
		expect(await exists(join(cwd, ".git", "atelier", "profile-pin.json"))).toBe(false);
	});

	it("cannot write ~/.atelier/profiles.json", async () => {
		const cwd = await repo(join(base, "main"));
		await mkdir(join(home, ".atelier"));
		const result = await run(cwd, `echo x > ${join(home, ".atelier", "profiles.json")}`);
		expect(result.ok).toBe(false);
		expect(await exists(join(home, ".atelier", "profiles.json"))).toBe(false);
	});
});
