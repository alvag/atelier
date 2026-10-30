import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { BUILTIN_AGENTS } from "../src/subagents/definitions.ts";
import { createTaskWorktree } from "../src/subagents/worktree.ts";
import { createBackgroundTools } from "../src/tools/background.ts";

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
		tools: createBackgroundTools(),
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

	it.each([
		["with the sandbox", false],
		["with the sandbox off", true],
	])("gets the parent's node_modules folders %s, without being able to change them", async (_how, noSandbox) => {
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
			tools: createBackgroundTools(),
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

	it("forgets a worktree of Atelier's that a crash left, and only that one", async () => {
		const crashed = await realpath(await mkdtemp(join(tmpdir(), "atelier-crashed-")));
		const stale = join(crashed, "atelier-session-old", "work", "worktrees", "1", "tree");
		git(repo, "worktree", "add", "-q", "--detach", stale, "HEAD");
		await rm(crashed, { recursive: true, force: true });
		const { session, play, woke } = await started(
			[[work("c1"), { event: finished }], [{ event: finished }]],
			[() => [text("done"), { event: finished }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(stale);
		expect(worktrees()).toBe(1);
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
