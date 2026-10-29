import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEvent, type AtelierEventBody, FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { BUILTIN_AGENTS } from "../src/subagents/definitions.ts";
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
async function started(parentTurns: FakeStep[][], childTurns: ((cwd: () => string) => FakeStep[])[], cwd = repo) {
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
	});
	sessions.push(session);
	const play = async (turn: AsyncIterable<AtelierEvent> | undefined) => {
		const events: AtelierEvent[] = [];
		for await (const event of turn as AsyncIterable<AtelierEvent>) events.push(event);
		return events;
	};
	return { parent, children, session, play, woke: () => woke };
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

	it("names the files another task's patch also changed", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const { parent, session, play, woke } = await started(
			[[work("c1"), work("c2", "other"), { event: finished }], [{ event: finished }], [{ event: finished }]],
			[
				(cwd) => [{ run: () => writeFileSync(join(cwd(), "a.txt"), "first\n") }, text("one"), { event: finished }],
				(cwd) => [
					{ run: () => writeFileSync(join(cwd(), "a.txt"), "second\n") },
					{ run: () => held },
					text("two"),
					{ event: finished },
				],
			],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		release();
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
