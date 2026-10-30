import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { createTaskWorktree } from "../src/subagents/worktree.ts";
import { createBackgroundTools } from "../src/tools/background.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import { createWriteTool } from "../src/tools/write.ts";

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

	it.each([["with the sandbox", false]])(
		"gets the parent's node_modules folders %s, without being able to change them",
		async (_how, noSandbox) => {
			writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules/\n");
			for (const dir of ["node_modules/pkg", "sub/node_modules/x"]) mkdirSync(join(repo, dir), { recursive: true });
			writeFileSync(join(repo, "node_modules/pkg/index.js"), "parent\n");
			writeFileSync(join(repo, "sub/node_modules/x/index.js"), "parent x\n");
			const seen: string[] = [];
			const { parent, session, play, woke } = await started(
				[[work("c1"), { event: finished }], [{ event: finished }]],
				[
					(cwd) => [
						{
							run: () => {
								const pkg = join(cwd(), "node_modules/pkg/index.js");
								seen.push(readFileSync(pkg, "utf8"), readFileSync(join(cwd(), "sub/node_modules/x/index.js"), "utf8"));
								seen.push(String(lstatSync(join(cwd(), "node_modules")).isSymbolicLink()));
								writeFileSync(pkg, "child\n");
							},
						},
						text("done"),
						{ event: finished },
					],
				],
				repo,
				{ noSandbox },
			);
			await play(session.send("go"));
			const started_ = parent.toolResults[0]?.output ?? "";
			await until(() => woke() === 1);
			// Its own copies, whatever the file system: never a link to the parent's.
			expect(seen).toEqual(["parent\n", "parent x\n", "false"]);
			expect(started_).toMatch(/Its node_modules folders are (copy-on-write )?copies of yours\./);
			expect(readFileSync(join(repo, "node_modules/pkg/index.js"), "utf8")).toBe("parent\n");
			await play(session.nextQueued());
			expect(parent.prompts[1]).toContain("It changed no files.");
		},
	);

	it("points no link of its worktree at the parent's tree, so nothing written through one reaches the parent's", async () => {
		writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules/\n");
		mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules/pkg/index.js"), "parent\n");
		// pnpm-like: an absolute link inside the dependencies, and one in the tree itself.
		symlinkSync(join(repo, "node_modules/pkg"), join(repo, "node_modules/abs"));
		symlinkSync(join(repo, "a.txt"), join(repo, "here"));
		const before = readFileSync(join(repo, "a.txt"));
		const targets: string[] = [];
		const { parent, session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[
				(cwd) => [
					{
						run: () => {
							targets.push(readlinkSync(join(cwd(), "node_modules/abs")), readlinkSync(join(cwd(), "here")));
							writeFileSync(join(cwd(), "node_modules/abs/index.js"), "child\n");
							writeFileSync(join(cwd(), "here"), "through the link\n");
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
		expect(readFileSync(join(repo, "node_modules/pkg/index.js"), "utf8")).toBe("parent\n");
		expect(readFileSync(join(repo, "a.txt")).equals(before)).toBe(true);
		for (const target of targets) expect(target.startsWith(`${repo}/`)).toBe(false);
		// The worker changed a.txt through the link; the link itself is as the snapshot has it.
		expect(parent.prompts[1]).toMatch(/Its changes: 1 file changed, \+1 -2/);
	});

	it("gets every node_modules the parent has: inside an ignored folder, not ignored, or a link", async () => {
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
							for (const file of ["vendor/node_modules/v", "plain/node_modules/p", "node_modules/l"])
								seen.push(readFileSync(join(cwd(), file, "index.js"), "utf8"));
							seen.push(String(lstatSync(join(cwd(), "node_modules")).isSymbolicLink()));
							writeFileSync(join(cwd(), "node_modules/l/index.js"), "child\n");
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
		expect(seen).toEqual(["vendored\n", "plain\n", "linked\n", "false"]);
		expect(readFileSync(join(repo, ".store/nm/l/index.js"), "utf8")).toBe("linked\n");
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

	it("forgets a worktree of Atelier's that a crash left, and none of the user's, whatever its path", async () => {
		const crashed = await realpath(await mkdtemp(join(tmpdir(), "atelier-crashed-")));
		const stale = join(crashed, "atelier-session-old", "work", "worktrees", "1", "tree");
		const theirs = join(crashed, "my-directory", "atelier-session-project", "work", "worktrees", "7", "tree");
		git(repo, "worktree", "add", "-q", "--detach", "--lock", "--reason", "atelier: background worker", stale, "HEAD");
		git(repo, "worktree", "add", "-q", "--detach", theirs, "HEAD");
		await rm(crashed, { recursive: true, force: true });
		const { session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[() => [text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		const listed = git(repo, "worktree", "list", "--porcelain");
		expect(listed).not.toContain(stale);
		expect(listed).toContain(theirs);
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

	it("leaves the repository as it was when the dependencies cannot be copied, and starts no subagent", async () => {
		writeFileSync(join(repo, ".gitignore"), "ignored.log\nnode_modules/\n");
		mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
		const unreadable = join(repo, "node_modules/pkg/secret.js");
		writeFileSync(unreadable, "x\n");
		chmodSync(unreadable, 0);
		const before = { git: gitDirState(), objects: objectFiles(), refs: git(repo, "for-each-ref") };
		try {
			const { parent, children, session, play } = await started([[work("c1"), { event: finished }]], []);
			await play(session.send("go"));
			expect(parent.toolResults[0]?.output).toMatch(
				/^The worker's worktree could not be made: could not copy node_modules/,
			);
			expect(children).toHaveLength(0);
			expect({ git: gitDirState(), objects: objectFiles(), refs: git(repo, "for-each-ref") }).toEqual(before);
		} finally {
			chmodSync(unreadable, 0o644);
		}
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

describe("a worker's worktree where the file system cannot clone", () => {
	it("copies the parent's node_modules folders, which the worker then cannot change", async () => {
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
		mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules/pkg/index.js"), "parent\n");
		const dir = await realpath(await mkdtemp(join(tmpdir(), "atelier-copy-")));
		const worktree = await createTaskWorktree(repo, join(dir, "w"), { clone: false });
		try {
			expect(worktree.dependencies).toBe("copied");
			const pkg = join(worktree.cwd, "node_modules/pkg/index.js");
			expect(lstatSync(join(worktree.cwd, "node_modules")).isSymbolicLink()).toBe(false);
			writeFileSync(pkg, "child\n");
			expect(readFileSync(join(repo, "node_modules/pkg/index.js"), "utf8")).toBe("parent\n");
			expect(await worktree.collect(join(dir, "p.patch"))).toBeUndefined();
		} finally {
			await worktree.remove();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("the links of a worker's worktree", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await realpath(await mkdtemp(join(tmpdir(), "atelier-links-")));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it.each(["absolute", "relative"])(
		"copies the ignored store a dependency's %s link leads to, and writes there stay the worker's",
		async (kind) => {
			writeFileSync(join(repo, ".gitignore"), "node_modules/\n.store/\n");
			mkdirSync(join(repo, ".store/pkg"), { recursive: true });
			mkdirSync(join(repo, "node_modules"), { recursive: true });
			writeFileSync(join(repo, ".store/pkg/index.js"), "store\n");
			symlinkSync(kind === "absolute" ? join(repo, ".store/pkg") : "../.store/pkg", join(repo, "node_modules/pkg"));
			const worktree = await createTaskWorktree(repo, join(dir, "w"));
			try {
				const file = join(worktree.cwd, "node_modules/pkg/index.js");
				expect(readFileSync(file, "utf8")).toBe("store\n");
				expect(realpathSync(file).startsWith(`${repo}/`)).toBe(false);
				writeFileSync(file, "child\n");
				expect(readFileSync(join(repo, ".store/pkg/index.js"), "utf8")).toBe("store\n");
			} finally {
				await worktree.remove();
			}
		},
	);

	it("copies a dependency's link out of the tree, so a link back from there leads into the worktree", async () => {
		const outside = await realpath(await mkdtemp(join(tmpdir(), "atelier-outside-")));
		try {
			writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
			mkdirSync(join(repo, "node_modules/real"), { recursive: true });
			writeFileSync(join(repo, "node_modules/real/index.js"), "parent\n");
			symlinkSync(join(repo, "node_modules/real"), join(outside, "back"));
			symlinkSync(outside, join(repo, "node_modules/x"));
			const worktree = await createTaskWorktree(repo, join(dir, "w"));
			try {
				const file = join(worktree.cwd, "node_modules/x/back/index.js");
				expect(readFileSync(file, "utf8")).toBe("parent\n");
				expect(realpathSync(file).startsWith(`${repo}/`)).toBe(false);
				writeFileSync(file, "child\n");
				expect(readFileSync(join(repo, "node_modules/real/index.js"), "utf8")).toBe("parent\n");
			} finally {
				await worktree.remove();
			}
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("keeps the relative links of a linked package outside the tree leading where they led from there", async () => {
		const outside = await realpath(await mkdtemp(join(tmpdir(), "atelier-outside-")));
		try {
			writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
			mkdirSync(join(repo, "node_modules"), { recursive: true });
			for (const dir of ["pkg/lib", "shared"]) mkdirSync(join(outside, dir), { recursive: true });
			writeFileSync(join(outside, "shared/index.js"), "shared\n");
			writeFileSync(join(outside, "pkg/lib/index.js"), "lib\n");
			symlinkSync("../shared", join(outside, "pkg/shared"));
			symlinkSync("lib", join(outside, "pkg/main"));
			symlinkSync(join(outside, "pkg"), join(repo, "node_modules/pkg"));
			const worktree = await createTaskWorktree(repo, join(dir, "w"));
			try {
				const pkg = join(worktree.cwd, "node_modules/pkg");
				expect(readFileSync(join(pkg, "shared/index.js"), "utf8")).toBe("shared\n");
				expect(readFileSync(join(pkg, "main/index.js"), "utf8")).toBe("lib\n");
				expect(readlinkSync(join(pkg, "main"))).toBe("lib");
				for (const file of ["shared/index.js", "main/index.js"])
					expect(realpathSync(join(pkg, file)).startsWith(`${dir}/`)).toBe(true);
			} finally {
				await worktree.remove();
			}
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("refuses a dependency's link to a folder that holds the parent's tree, leaving the repository as it was", async () => {
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
		mkdirSync(join(repo, "node_modules"), { recursive: true });
		symlinkSync(dirname(repo), join(repo, "node_modules/up"));
		const before = { git: gitDirState(), objects: objectFiles() };
		await expect(createTaskWorktree(repo, join(dir, "w"))).rejects.toThrow(
			/node_modules\/up leads to .+, which holds the repository/,
		);
		expect({ git: gitDirState(), objects: objectFiles() }).toEqual(before);
		expect(existsSync(join(dir, "w"))).toBe(false);
	});
});
