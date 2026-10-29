import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalAnswer,
	type ApprovalRequest,
	type AtelierEvent,
	createBashTool,
	FakeBackend,
	type FakeStep,
	PermissionRules,
	Session,
} from "../src/index.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

let home: string;
let app: string;
let clone: string;

beforeEach(async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-project-")));
	home = join(root, "home");
	app = join(root, "app");
	clone = join(root, "clone");
	for (const project of [app, clone]) {
		await mkdir(join(project, ".git"), { recursive: true });
		await writeFile(join(project, "run.sh"), "#!/bin/sh\nprintf ran\n");
		await chmod(join(project, "run.sh"), 0o755);
	}
	await mkdir(home);
});

/** A sandbox that is there and wraps nothing, counting what it wrapped; covered commands run plainly. */
function sandboxed() {
	const wrapped: string[] = [];
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => {
			wrapped.push(command);
			return command;
		},
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return { sandbox: new Sandbox({ platform: "darwin", manager, outside: () => true }), wrapped };
}

const leave = (command: string, callId: string): FakeStep => ({
	toolCall: { tool: "bash", input: { command, unsandboxed: true, reason: "needs the network" }, callId },
});
const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};

/** Runs one turn in `cwd`, answering each question with the next answer (then no). */
async function run(
	cwd: string,
	steps: FakeStep[],
	{
		answers = [],
		rules = new PermissionRules({ home, cwd }),
	}: { answers?: ApprovalAnswer[]; rules?: PermissionRules } = {},
) {
	const { sandbox } = sandboxed();
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[...steps, finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createBashTool({ sandbox })],
		permissionRules: rules,
		approve: async (request) => {
			questions.push(request);
			return answers[questions.length - 1] ?? false;
		},
	});
	const events: AtelierEvent[] = [];
	for await (const event of session.send("go")) events.push(event);
	return { questions, events, results: backend.toolResults, backend, rules };
}

const errors = (events: AtelierEvent[]) => events.filter((event) => event.type === "error");

describe("rules allowed always in this project", () => {
	it("are offered for a command that runs the project's code, with the project, never for every folder", async () => {
		const { questions, events } = await run(app, [leave("./run.sh", "c1")]);
		const remember = { rules: ["./run.sh"], always: false, project: app };
		expect(questions[0]?.remember).toEqual(remember);
		expect(events.find((event) => event.type === "approval_requested")).toMatchObject({ remember });
	});

	it("are saved for the project and cover its later sessions only", async () => {
		await run(app, [leave("./run.sh", "c1")], { answers: [{ remember: "project" }] });
		expect(JSON.parse(await readFile(join(home, ".atelier", "project-permissions.json"), "utf8")).allow).toEqual([
			{ bash: "./run.sh", project: app },
		]);
		const later = await run(app, [leave("./run.sh", "c1")]);
		expect(later.questions).toEqual([]);
		expect(later.results[0]?.output).toContain("ran");
		expect(later.backend.startOptions?.systemPromptAppend).toContain(
			"In this project the user also allows these bash commands outside the sandbox without asking: ./run.sh.",
		);
		const elsewhere = await run(clone, [leave("./run.sh", "c1")]);
		expect(elsewhere.questions).toHaveLength(1);
	});

	it("do not cover a line that changes directory", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "./run.sh" }], "project");
		await rules.allow([{ kind: "bash", value: "cd" }], "session");
		const { questions } = await run(app, [leave("cd . && ./run.sh", "c1")], { rules });
		expect(questions).toHaveLength(1);
	});

	it("asks when another segment has an absolute argument", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "printf" }], "session");
		await rules.allow([{ kind: "bash", value: "./run.sh" }], "project");
		const { questions } = await run(app, [leave("printf '%s' /tmp | ./run.sh", "c1")], { rules });
		expect(questions).toHaveLength(1);
	});

	it("asks when an argument is a link out of the project, and not for a real folder in it", async () => {
		await symlink(clone, join(app, "link"));
		await mkdir(join(app, "sub"));
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "./run.sh" }], "project");
		const { questions, results } = await run(
			app,
			[
				leave("./run.sh link", "c1"),
				leave("./run.sh --dir=link/x", "c2"),
				leave("./run.sh -Clink", "c3"),
				leave("./run.sh sub", "c4"),
			],
			{ rules },
		);
		expect(questions.map(({ callId }) => callId)).toEqual(["c1", "c2", "c3"]);
		expect(results[3]?.output).toContain("ran");
	});

	it("asks when an argument is a dangling link out of the project, and not for one that stays in it", async () => {
		const outside = join(await realpath(tmpdir()), `atelier-dangling-${process.pid}-${Date.now()}`, "made");
		await symlink(outside, join(app, "out"));
		await symlink("missing-inside", join(app, "in"));
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "./run.sh" }], "project");
		const { questions } = await run(app, [leave("./run.sh out", "c1"), leave("./run.sh in", "c2")], { rules });
		expect(questions.map(({ callId }) => callId)).toEqual(["c1"]);
	});

	it("follows a dangling link's target a part at a time, so a .. after a link goes up from where it leads", async () => {
		await symlink(clone, join(app, "pivot"));
		await symlink(`pivot/../victim-${process.pid}`, join(app, "out"));
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "./run.sh" }], "project");
		const { questions } = await run(app, [leave("./run.sh out", "c1")], { rules });
		expect(questions).toHaveLength(1);
	});

	it("asks when the program itself is a link out of the project", async () => {
		await symlink(join(clone, "run.sh"), join(app, "tool.sh"));
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "./tool.sh" }], "project");
		const { questions } = await run(app, [leave("./tool.sh", "c1")], { rules });
		expect(questions).toHaveLength(1);
	});

	it("covers the places of a linked worktree by the main checkout's rule", async () => {
		const main = join(app, "..", "main");
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
		await mkdir(main);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "x");
		const wt = join(app, "..", "wt");
		git(main, "worktree", "add", "-q", wt);
		await writeFile(join(wt, "run.sh"), "#!/bin/sh\nprintf WORKTREE_RAN\n", { mode: 0o755 });
		await mkdir(join(wt, "sub"));
		await new PermissionRules({ home, cwd: main }).allow([{ kind: "bash", value: "./run.sh" }], "project");
		const { questions, results } = await run(wt, [leave("./run.sh", "c1"), leave("./run.sh sub", "c2")]);
		expect(questions).toEqual([]);
		expect(results[0]?.output).toContain("WORKTREE_RAN");
	});

	it("asks when the line gives the covered command its standard input", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "./run.sh" }], "project");
		await rules.allow([{ kind: "bash", value: "printf" }], "session");
		const { questions } = await run(
			app,
			[
				leave("./run.sh <<'EOF'\ninclude /outside/Makefile\nEOF", "c1"),
				leave("./run.sh <<< 'x'", "c2"),
				leave("printf x | ./run.sh", "c3"),
				leave("./run.sh", "c4"),
			],
			{ rules },
		);
		expect(questions.map(({ callId }) => callId)).toEqual(["c1", "c2", "c3"]);
	});

	it("covers an absolute executable allowed for the project", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "/usr/bin/make" }], "project");
		const { questions } = await run(app, [leave("/usr/bin/make -C .", "c1")], { rules });
		expect(questions).toHaveLength(0);
	});

	it("keep an Allow always answer for a project's command for the session, and say so", async () => {
		const { events, rules } = await run(app, [leave("./run.sh", "c1")], { answers: [{ remember: "always" }] });
		expect(errors(events)).toEqual([
			expect.objectContaining({
				code: "permission_rules_not_saved",
				message:
					'Not saved: "./run.sh" runs code the project defines: it is allowed always only in a project; allowed for this session',
			}),
		]);
		expect(await rules.list()).toEqual([expect.objectContaining({ scope: "session", value: "./run.sh" })]);
	});

	it("are not offered without a project to save them for", async () => {
		const { questions, events, rules } = await run(app, [leave("./run.sh", "c1")], {
			rules: new PermissionRules({ home }),
			answers: [{ remember: "project" }],
		});
		expect(questions[0]?.remember).toEqual({ rules: ["./run.sh"], always: false });
		expect(errors(events)).toEqual([expect.objectContaining({ code: "permission_rules_not_saved" })]);
		expect(await rules.list()).toEqual([expect.objectContaining({ scope: "session", value: "./run.sh" })]);
	});
});

describe("an old rule for every folder that runs a project's code", () => {
	it("is not used, the others are, and the session says it once", async () => {
		await mkdir(join(home, ".atelier"));
		const file = join(home, ".atelier", "permissions.json");
		await writeFile(
			file,
			JSON.stringify({ kind: "atelier.permissions", version: 1, allow: [{ bash: "./run.sh" }, { bash: "printf" }] }),
		);
		await chmod(file, 0o600);
		const { questions, events, results } = await run(app, [
			leave("./run.sh", "c1"),
			leave("printf covered", "c2"),
			leave("./run.sh", "c3"),
		]);
		expect(questions.map(({ callId }) => callId)).toEqual(["c1", "c3"]);
		expect(results[1]?.output).toContain("covered");
		expect(errors(events)).toEqual([
			expect.objectContaining({
				code: "permission_rules_ignored",
				recoverable: true,
				message: expect.stringContaining('"./run.sh"'),
			}),
		]);
	});
});
