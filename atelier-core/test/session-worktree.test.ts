import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { PermissionRules } from "../src/permission-rules.ts";
import { BUILTIN_AGENTS } from "../src/subagents/definitions.ts";
import { createBackgroundTools } from "../src/tools/background.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { isInsideSandbox, Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import { createWriteTool } from "../src/tools/write.ts";

const onMac = process.platform === "darwin" && !isInsideSandbox();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });
const work = (callId: string, label = "fix"): FakeStep => ({
	toolCall: { tool: "task", input: { agent: "worker", prompt: "Fix it.", background: true, label } as never, callId },
});

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
	});

let repo: string;
let sessions: Session[] = [];
beforeEach(async () => {
	repo = await realpath(await mkdtemp(join(tmpdir(), "atelier-worktree-")));
	git(repo, "init", "-q");
	writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	// Uncommitted work the worker must see: a change, a new file, and an ignored file it must not.
	writeFileSync(join(repo, "a.txt"), "one\ndirty\n");
	writeFileSync(join(repo, "b.txt"), "new\n");
	writeFileSync(join(repo, "ignored.log"), "noise\n");
});
afterEach(async () => {
	await Promise.all(sessions.map((session) => session.close()));
	sessions = [];
	await rm(repo, { recursive: true, force: true });
});

/** A parent in `cwd` playing `parentTurns`, whose worker children play `childTurns`; `seen` gets each child's folder. */
async function started(
	parentTurns: FakeStep[][],
	childTurns: ((cwd: () => string) => FakeStep[])[],
	cwd = repo,
	extra: Partial<SessionOptions> = {},
) {
	const parent = new FakeBackend(parentTurns);
	const children: FakeBackend[] = [];
	let woke = 0;
	const session = await Session.start({
		backend: parent,
		cwd,
		tools: [...createBackgroundTools(), sandboxedBash()],
		subagents: {
			agents: BUILTIN_AGENTS,
			createBackend: () => {
				const index = children.length;
				const child: FakeBackend = new FakeBackend([
					childTurns[index]?.(() => child.startOptions?.cwd as string) ?? [],
				]);
				children.push(child);
				return child;
			},
		},
		wake: () => woke++,
		...extra,
	});
	sessions.push(session);
	const play = async (turn: AsyncIterable<AtelierEvent> | undefined) => {
		const events: AtelierEvent[] = [];
		for await (const event of turn as AsyncIterable<AtelierEvent>) events.push(event);
		return events;
	};
	return { parent, children, session, play, woke: () => woke };
}

/** `bash` in a sandbox that is there and wraps nothing: a background worker needs one. */
function sandboxedBash() {
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return createBashTool({ sandbox: new Sandbox({ platform: "darwin", manager }) });
}

/** A gate a child's turn waits on until the test opens it. */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, step: { run: () => opened } as FakeStep };
}

/** Every file of the repository's .git but its objects, with a digest of each: what Atelier must leave as it was. */
function gitDirState(): Record<string, string> {
	const state: Record<string, string> = {};
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const name = `${prefix}${entry.name}`;
			if (name === "objects") continue;
			if (entry.isDirectory()) walk(path, `${name}/`);
			else state[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
		}
	};
	walk(join(repo, ".git"), "");
	return state;
}

/** The repository's loose objects and packs, by name. */
function objectFiles(): string[] {
	return readdirSync(join(repo, ".git", "objects"), { recursive: true, encoding: "utf8" }).sort();
}

const worktrees = () => git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length ?? 0;

describe("a worker in the background", () => {
	it("works in its own worktree of the parent's tree as it is, and returns its change as a patch", async () => {
		let inside = "";
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{
						run: () => {
							inside = cwd();
							writeFileSync(join(inside, "a.txt"), "one\ndirty\nfixed\n");
							writeFileSync(join(inside, "c.txt"), "added\n");
						},
					},
					text("Fixed a.txt and added c.txt."),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		const head = git(repo, "rev-parse", "--short", "HEAD").trim();
		expect(parent.toolResults[0]?.output).toContain(
			`It works in its own git worktree, from your working tree as it is now (HEAD ${head} plus uncommitted changes); its changes come back as a patch.`,
		);
		await until(() => woke() === 1);
		expect(inside).not.toBe(repo);
		expect(existsSync(inside)).toBe(false);
		expect(worktrees()).toBe(1);
		await play(session.nextQueued());
		const notice = parent.prompts[1] ?? "";
		expect(notice).toMatch(
			/Its changes: 2 files changed, \+2 -0, as a patch against your working tree as it was when the task started: (\S+\.patch)\. Apply it from \S+ with git apply and check it\./,
		);
		const patch = notice.match(/started: (\S+\.patch)\./)?.[1] as string;
		git(repo, "apply", patch);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\ndirty\nfixed\n");
		expect(readFileSync(join(repo, "c.txt"), "utf8")).toBe("added\n");
		// The user's index, branch and stash are as they were: the snapshot touched none of them.
		expect(git(repo, "stash", "list")).toBe("");
		expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
	});

	it("sees the uncommitted work but not the ignored files", async () => {
		const seen: string[] = [];
		const { session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{
						run: () => {
							seen.push(readFileSync(join(cwd(), "a.txt"), "utf8"), String(existsSync(join(cwd(), "b.txt"))));
							seen.push(String(existsSync(join(cwd(), "ignored.log"))));
						},
					},
					text("nothing to do"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		expect(seen).toEqual(["one\ndirty\n", "true", "false"]);
		await play(session.nextQueued());
	});

	it("says it changed nothing, and names the files the parent changed since the snapshot", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const { parent, session, play, woke } = await started(
			[
				[work("c1"), { event: finished }],
				[{ event: finished }],
				[work("c2", "again"), { event: finished }],
				[{ event: finished }],
			],
			[
				() => [text("Nothing needed."), { event: finished }],
				(cwd) => [
					{ run: () => held },
					{ run: () => writeFileSync(join(cwd(), "a.txt"), "theirs\n") },
					text("done"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toContain("It changed no files.");
		await play(session.send("again"));
		writeFileSync(join(repo, "a.txt"), "mine\n");
		release();
		await until(() => woke() === 2);
		await play(session.nextQueued());
		expect(parent.prompts[3]).toContain("Files it changed that also changed in your working tree since: a.txt.");
	});

	it("links every node_modules the parent has: ignored, not ignored, a link, or inside an ignored folder", async () => {
		writeFileSync(join(repo, ".gitignore"), "ignored.log\nvendor/\n.store/\n");
		for (const dir of ["vendor/node_modules/v", "plain/node_modules/p", ".store/nm/l"])
			mkdirSync(join(repo, dir), { recursive: true });
		writeFileSync(join(repo, "vendor/node_modules/v/index.js"), "vendored\n");
		writeFileSync(join(repo, "plain/node_modules/p/index.js"), "plain\n");
		writeFileSync(join(repo, ".store/nm/l/index.js"), "linked\n");
		symlinkSync(join(repo, ".store/nm"), join(repo, "node_modules"));
		const seen: string[] = [];
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{
						run: () => {
							// Folders of their own, whose entries are links to the parent's.
							for (const folder of ["vendor/node_modules", "plain/node_modules", "node_modules"])
								seen.push(String(lstatSync(join(cwd(), folder)).isSymbolicLink()));
							for (const entry of ["vendor/node_modules/v", "plain/node_modules/p", "node_modules/l"])
								seen.push(String(lstatSync(join(cwd(), entry)).isSymbolicLink()));
							for (const file of ["vendor/node_modules/v", "plain/node_modules/p", "node_modules/l"])
								seen.push(readFileSync(join(cwd(), file, "index.js"), "utf8"));
						},
					},
					text("done"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toContain(
			"Its node_modules folders are links to yours: it reads and runs them, and cannot write them.",
		);
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(seen).toEqual(["false", "false", "false", "true", "true", "true", "vendored\n", "plain\n", "linked\n"]);
		expect(parent.prompts[1]).toContain("It changed no files.");
	});

	it("runs its own change of a package of the repository from another one that imports it", async () => {
		writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules/\n");
		for (const dir of ["packages/a", "packages/b/node_modules/@org", "packages/b/node_modules/.bin"])
			mkdirSync(join(repo, dir), { recursive: true });
		writeFileSync(join(repo, "packages/a/index.js"), 'module.exports = "parent A";\n');
		writeFileSync(join(repo, "packages/a/cli.js"), '#!/usr/bin/env node\nconsole.log(require("./index.js"));\n', {
			mode: 0o755,
		});
		writeFileSync(
			join(repo, "packages/b/b.test.cjs"),
			'require("node:test")("b", () => require("node:assert").equal(require("@org/a"), "worker A"));\n',
		);
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "packages");
		// As pnpm and npm lay them out: the workspace package by a relative link under its scope, its command in .bin,
		// and a dependency of the store's.
		symlinkSync("../../../a", join(repo, "packages/b/node_modules/@org/a"));
		symlinkSync("../@org/a/cli.js", join(repo, "packages/b/node_modules/.bin/a-cli"));
		mkdirSync(join(repo, "packages/b/node_modules/plain"));
		writeFileSync(join(repo, "packages/b/node_modules/plain/index.js"), 'module.exports = "plain";\n');
		const before = readFileSync(join(repo, "packages/a/index.js"));
		const call = (tool: string, input: Record<string, unknown>, callId: string): FakeStep => ({
			toolCall: { tool, input: input as never, callId },
		});
		const { parent, children, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				() => [
					call("write", { path: "packages/a/index.js", content: 'module.exports = "worker A";\n' }, "k1"),
					call("bash", { command: "cd packages/b && node --test b.test.cjs" }, "k2"),
					call("bash", { command: "packages/b/node_modules/.bin/a-cli" }, "k3"),
					call("bash", { command: "cd packages/b && node -p 'require(\"plain\")'" }, "k4"),
					text("done"),
					{ event: finished },
				],
			],
			repo,
			{ tools: [...createBackgroundTools(), sandboxedBash(), createWriteTool()] },
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		const results = children[0]?.toolResults ?? [];
		expect(results[1], results[1]?.output).toMatchObject({ ok: true });
		expect(results[2]?.output).toContain("worker A");
		expect(results[3]?.output).toContain("plain");
		expect(readFileSync(join(repo, "packages/a/index.js")).equals(before)).toBe(true);
		expect(readlinkSync(join(repo, "packages/b/node_modules/@org/a"))).toBe("../../../a");
		expect(parent.prompts[1]).toMatch(/Its changes: 1 file changed, \+1 -1/);
	});

	it("skips a node_modules of the parent's that is a dangling link, and starts the worker all the same", async () => {
		mkdirSync(join(repo, "pkg"), { recursive: true });
		symlinkSync(join(repo, "gone"), join(repo, "pkg", "node_modules"));
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[() => [text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toMatch(/^Started worker in the background as task task-1/);
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toContain("It changed no files.");
	});

	it("leaves the dependency folders out of the patch, whatever the worker made of them", async () => {
		writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules/\n");
		mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules/pkg/index.js"), "parent\n");
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{
						run: () => {
							// A link is not a folder: `node_modules/` no longer ignores it.
							rmSync(join(cwd(), "node_modules"), { recursive: true, force: true });
							symlinkSync(join(repo, "node_modules"), join(cwd(), "node_modules"));
						},
					},
					text("done"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toContain("It changed no files.");
	});

	it("leaves out of the patch a node_modules folder the worker made, ignored or not", async () => {
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{
						run: () => {
							mkdirSync(join(cwd(), "lib/node_modules/x"), { recursive: true });
							writeFileSync(join(cwd(), "lib/node_modules/x/index.js"), "made\n");
						},
					},
					text("done"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toContain("It changed no files.");
	});

	it("runs none of the repository's git filters for its snapshot, worktree or patch", async () => {
		const marker = join(repo, "RAN_WITHOUT_APPROVAL");
		for (const what of ["clean", "smudge"]) git(repo, "config", `filter.attack.${what}`, `touch ${marker}; cat`);
		git(repo, "config", "filter.attack.required", "true");
		git(repo, "config", "diff.attack.textconv", `touch ${marker}; cat`);
		writeFileSync(join(repo, ".gitattributes"), "a.txt filter=attack diff=attack\n");
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[(cwd) => [{ run: () => writeFileSync(join(cwd(), "a.txt"), "changed\n") }, text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toMatch(/Its changes: 1 file changed/);
		expect(existsSync(marker)).toBe(false);
	});

	it("runs no filter that the configuration turns on only for the worker's worktree", async () => {
		const marker = join(repo, "RAN_IN_THE_WORKTREE");
		const included = join(repo, ".git", "worktree-only.cfg");
		writeFileSync(included, `[filter "attack"]\n\tclean = touch ${marker}; cat\n\tsmudge = touch ${marker}; cat\n`);
		git(repo, "config", "includeIf.gitdir:**/.git/worktrees/**.path", included);
		writeFileSync(join(repo, ".gitattributes"), "a.txt filter=attack\n");
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[(cwd) => [{ run: () => writeFileSync(join(cwd(), "a.txt"), "changed\n") }, text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toMatch(/Its changes: 1 file changed/);
		expect(existsSync(marker)).toBe(false);
	});

	it("removes its worktree even when its subagent's session fails to close", async () => {
		const { children, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[() => [text("done"), { event: finished }]],
		);
		const failing = new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (children[0] === undefined) return;
				children[0].closeError = "close exploded";
				clearInterval(check);
				resolve();
			}, 1);
		});
		await play(session.send("go"));
		await failing;
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(worktrees()).toBe(1);
		expect(existsSync(children[0]?.startOptions?.cwd as string)).toBe(false);
	});

	it("starts no subagent and leaves no worktree when the session closes while it is being made", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const child = new FakeBackend([[text("late"), { event: finished }]]);
		const parent = new FakeBackend([[work("c1"), { event: finished }]]);
		const session = await Session.start({
			backend: parent,
			cwd: repo,
			tools: [...createBackgroundTools(), sandboxedBash()],
			subagents: {
				agents: BUILTIN_AGENTS,
				createBackend: async () => {
					await held;
					return child;
				},
			},
			wake: () => {},
		});
		const turn = (async () => {
			for await (const _event of session.send("go")) {
			}
		})();
		await until(() => worktrees() === 2);
		const closing = session.close();
		release();
		await closing;
		await turn;
		expect(parent.toolResults[0]?.output).toBe("Refused: the session is closing.");
		expect(child.prompts).toEqual([]);
		expect(worktrees()).toBe(1);
	});

	it("names the files another task's patch also changed", async () => {
		const first = gate();
		const second = gate();
		const { parent, session, play, woke } = await started(
			[[work("c1"), work("c2", "other"), { event: finished }], [{ event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{ run: () => writeFileSync(join(cwd(), "a.txt"), "first\n") },
					first.step,
					text("one"),
					{ event: finished },
				],
				(cwd) => [
					{ run: () => writeFileSync(join(cwd(), "a.txt"), "second\n") },
					second.step,
					text("two"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		first.open();
		await until(() => woke() === 1);
		await play(session.nextQueued());
		second.open();
		await until(() => woke() === 2);
		await play(session.nextQueued());
		expect(parent.prompts[2]).toContain("Files the patch of task-1 also changed: a.txt.");
	});

	it("removes its worktree when it is stopped and when the session closes", async () => {
		const { session, play, children } = await started(
			[
				[
					work("c1"),
					{ toolCall: { tool: "job_stop", input: { id: "task-1" }, callId: "c2" } },
					work("c3", "two"),
					{ event: finished },
				],
			],
			[() => [{ waitForInterrupt: true }], () => [{ waitForInterrupt: true }]],
		);
		await play(session.send("go"));
		await until(() => children[1]?.prompts.length === 1);
		expect(worktrees()).toBe(2);
		await session.close();
		expect(worktrees()).toBe(1);
		expect(existsSync(children[0]?.startOptions?.cwd as string)).toBe(false);
		expect(existsSync(children[1]?.startOptions?.cwd as string)).toBe(false);
	});

	it("leaves nothing in the repository's .git but the snapshot's objects, even with a split index", async () => {
		git(repo, "config", "core.splitIndex", "true");
		git(repo, "update-index", "--split-index");
		const before = gitDirState();
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[(cwd) => [{ run: () => writeFileSync(join(cwd(), "a.txt"), "changed\n") }, text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toMatch(/Its changes: 1 file changed/);
		expect(gitDirState()).toEqual(before);
	});

	it("never forgets a worktree of the user's whose folder is gone", async () => {
		const theirs = await realpath(await mkdtemp(join(tmpdir(), "atelier-their-worktree-")));
		git(repo, "worktree", "add", "-q", "--detach", join(theirs, "wt"), "HEAD");
		await rm(theirs, { recursive: true, force: true });
		const { session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[() => [text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(git(repo, "worktree", "list", "--porcelain")).toContain(join(theirs, "wt"));
	});

	it("forgets a worktree of Atelier's that a crash left, and none of the user's, whatever its path or lock", async () => {
		const reason = "atelier: background worker";
		// Atelier's own: in a session's scratch directory, locked with its reason.
		const session_ = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-")));
		const stale = join(session_, "work", "worktrees", "1", "tree");
		git(repo, "worktree", "add", "-q", "--detach", "--lock", "--reason", reason, stale, "HEAD");
		// The user's: one locked with the same reason, one where Atelier's would be but unlocked, and one whose name
		// would forge a lock line in git's plain listing.
		const theirs = await realpath(await mkdtemp(join(tmpdir(), "atelier-theirs-")));
		const mimic = join(theirs, "mimic");
		const shaped = join(theirs, "atelier-session-project", "work", "worktrees", "7", "tree");
		const forged = join(theirs, `evil\nlocked ${reason}\nworktree x`);
		git(repo, "worktree", "add", "-q", "--detach", "--lock", "--reason", reason, mimic, "HEAD");
		git(repo, "worktree", "add", "-q", "--detach", shaped, "HEAD");
		git(repo, "worktree", "add", "-q", "--detach", forged, "HEAD");
		await rm(session_, { recursive: true, force: true });
		await rm(theirs, { recursive: true, force: true });
		const { session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[() => [text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		const listed = git(repo, "worktree", "list", "--porcelain", "-z").split("\0");
		expect(listed).not.toContain(`worktree ${stale}`);
		for (const path of [mimic, shaped, forged]) expect(listed).toContain(`worktree ${path}`);
	});

	it("never takes for Atelier's a worktree of the user's reached through a link, dangling or not", async () => {
		const reason = "atelier: background worker";
		const theirs = await realpath(await mkdtemp(join(tmpdir(), "atelier-theirs-")));
		const inScratch = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-")));
		// Both registered outside the scratch directories, then made to lead into one by a link above them.
		const dangling = join(theirs, "gone", "work", "worktrees", "1", "tree");
		const existing = join(theirs, "there", "work", "worktrees", "2", "tree");
		for (const path of [dangling, existing])
			git(repo, "worktree", "add", "-q", "--detach", "--lock", "--reason", reason, path, "HEAD");
		await rm(join(theirs, "gone"), { recursive: true, force: true });
		await rm(join(theirs, "there"), { recursive: true, force: true });
		symlinkSync(join(tmpdir(), "atelier-session-missing"), join(theirs, "gone"));
		symlinkSync(inScratch, join(theirs, "there"));
		try {
			const { session, play, woke } = await started(
				[[work("c1"), { event: finished }], [{ event: finished }]],
				[() => [text("done"), { event: finished }]],
			);
			await play(session.send("go"));
			await until(() => woke() === 1);
			await play(session.nextQueued());
			const listed = git(repo, "worktree", "list", "--porcelain", "-z").split("\0");
			for (const path of [dangling, existing]) expect(listed).toContain(`worktree ${path}`);
		} finally {
			await rm(theirs, { recursive: true, force: true });
			await rm(inScratch, { recursive: true, force: true });
		}
	});

	it("denies a write into the parent's tree, without asking, even in a folder the user's rules allow", async () => {
		const rules = new PermissionRules();
		await rules.allow([{ kind: "path", value: repo }], "session");
		const before = readFileSync(join(repo, "a.txt"));
		const { children, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				() => [
					{ toolCall: { tool: "write", input: { path: join(repo, "a.txt"), content: "child\n" }, callId: "w1" } },
					text("done"),
					{ event: finished },
				],
			],
			repo,
			{ permissionRules: rules, tools: [...createBackgroundTools(), sandboxedBash(), createWriteTool()] },
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(children[0]?.toolResults[0]?.output).toMatch(/^Denied without asking/);
		expect(readFileSync(join(repo, "a.txt")).equals(before)).toBe(true);
	});

	it("writes nothing outside its worktree, whatever the project's sandbox configuration allows", async () => {
		const outside = await realpath(await mkdtemp(join(tmpdir(), "atelier-outside-")));
		try {
			writeFileSync(join(outside, "index.js"), "outside\n");
			mkdirSync(join(repo, ".atelier"), { recursive: true });
			writeFileSync(join(repo, ".atelier", "sandbox.json"), JSON.stringify({ allowWrite: [outside, repo] }));
			symlinkSync(outside, join(repo, "out"));
			const { children, session, play, woke } = await started(
				[[work("c1"), { event: finished }], [{ event: finished }]],
				[
					() => [
						{ toolCall: { tool: "write", input: { path: "out/index.js", content: "child\n" }, callId: "w1" } },
						{ toolCall: { tool: "write", input: { path: join(repo, "a.txt"), content: "child\n" }, callId: "w2" } },
						text("done"),
						{ event: finished },
					],
				],
				repo,
				{ tools: [...createBackgroundTools(), sandboxedBash(), createWriteTool()] },
			);
			const before = readFileSync(join(repo, "a.txt"));
			await play(session.send("go"));
			await until(() => woke() === 1);
			await play(session.nextQueued());
			for (const result of children[0]?.toolResults ?? []) expect(result.output).toMatch(/^Denied without asking/);
			expect(readFileSync(join(outside, "index.js"), "utf8")).toBe("outside\n");
			expect(readFileSync(join(repo, "a.txt")).equals(before)).toBe(true);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it.each([
		["the sandbox is off", { noSandbox: true }],
		[
			"there is no sandbox",
			{ tools: [...createBackgroundTools(), createBashTool({ sandbox: new Sandbox({ platform: "linux" }) })] },
		],
	] as const)("is refused when %s, before anything is made, while an explorer still runs", async (_how, extra) => {
		const before = { git: gitDirState(), objects: objectFiles() };
		const explore: FakeStep = {
			toolCall: {
				tool: "task",
				input: { agent: "explorer", prompt: "Look.", background: true } as never,
				callId: "c2",
			},
		};
		const { parent, children, session, play } = await started(
			[[work("c1"), explore, { event: finished }]],
			[() => [text("seen"), { event: finished }]],
			repo,
			extra,
		);
		await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toMatch(
			/^Refused: a worker runs in the background only in the sandbox, which is not available here \(.+\); run it without background\.$/,
		);
		expect(parent.toolResults[1]?.output).toMatch(/^Started explorer in the background/);
		expect(children).toHaveLength(1);
		expect({ git: gitDirState(), objects: objectFiles() }).toEqual(before);
	});

	it("is refused outside a git repository, before a subagent starts", async () => {
		const plain = await realpath(await mkdtemp(join(tmpdir(), "atelier-plain-")));
		try {
			const { parent, children, session, play } = await started([[work("c1"), { event: finished }]], [], plain);
			await play(session.send("go"));
			expect(parent.toolResults[0]?.output).toBe(
				`Refused: a worker runs in the background in a git worktree of its own, and ${plain} is not in a git repository with a commit; run it without background.`,
			);
			expect(children).toHaveLength(0);
		} finally {
			await rm(plain, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!onMac)("a background worker in the real sandbox", () => {
	let home: string;
	let sandbox: Sandbox;
	beforeEach(async () => {
		home = await realpath(await mkdtemp(join(tmpdir(), "atelier-worker-home-")));
		vi.stubEnv("HOME", home);
		sandbox = new Sandbox({ home, tempDir: join(home, "tmp") });
	});
	afterEach(async () => {
		await sandbox.reset();
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	});

	it("reads and runs the parent's dependencies through their link, and writes them neither with write, edit nor bash", async () => {
		writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules/\n");
		mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
		const index = join(repo, "node_modules/pkg/index.js");
		writeFileSync(index, 'module.exports = "parent";\n');
		// The project's own configuration lets commands write the whole parent's tree.
		mkdirSync(join(repo, ".atelier"), { recursive: true });
		writeFileSync(join(repo, ".atelier", "sandbox.json"), JSON.stringify({ allowWrite: [repo] }));
		const before = readFileSync(index);
		const test = 'require("node:test")("pkg", () => require("node:assert").equal(require("pkg"), "parent"));\n';
		const call = (tool: string, input: Record<string, unknown>, callId: string): FakeStep => ({
			toolCall: { tool, input: input as never, callId },
		});
		const { parent, children, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				() => [
					call("write", { path: "node_modules/pkg/index.js", content: "child\n" }, "k1"),
					call("edit", { path: "node_modules/pkg/index.js", edits: [{ oldText: "parent", newText: "child" }] }, "k2"),
					call("bash", { command: "echo child > node_modules/pkg/index.js" }, "k3"),
					call("write", { path: "pkg.test.cjs", content: test }, "k4"),
					call("bash", { command: "node --test pkg.test.cjs" }, "k5"),
					text("done"),
					{ event: finished },
				],
			],
			repo,
			{ tools: [createBashTool({ sandbox }), createWriteTool(), createEditTool()] },
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		const results = children[0]?.toolResults ?? [];
		expect(results[0]?.output).toMatch(/^Denied without asking/);
		expect(results[1]?.output).toMatch(/^Denied without asking/);
		expect(results[2]?.ok).toBe(false);
		expect(results[4]).toMatchObject({ ok: true });
		expect(readFileSync(index).equals(before)).toBe(true);
		// The test it wrote is its change; the dependencies are never part of the patch.
		expect(parent.prompts[1]).toMatch(/Its changes: 1 file changed, \+1 -0/);
		expect(readFileSync(parent.prompts[1]?.match(/started: (\S+\.patch)\./)?.[1] as string, "utf8")).not.toContain(
			"node_modules",
		);
	});
});
