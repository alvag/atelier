import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type AtelierEvent, type AtelierEventBody, FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { SessionReview } from "../src/review/session-review.ts";
import { createWriteTool } from "../src/tools/write.ts";

/** The first lookup of HEAD where a turn starts, held after git answered until `release`. */
const held = vi.hoisted(() => {
	const state = {
		armed: false,
		released: false,
		resolve: undefined as (() => void) | undefined,
		/** Lets the held answer go, now or as soon as git gives it. */
		release() {
			state.released = true;
			state.resolve?.();
		},
	};
	return state;
});
vi.mock("../src/review/git.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/review/git.ts")>();
	const runGit: typeof actual.runGit = (args, options) => {
		const result = actual.runGit(args, options);
		if (!held.armed || args.join(" ") !== "rev-parse --verify --quiet HEAD^{commit}") return result;
		held.armed = false;
		return result.then(
			(answer) =>
				new Promise((resolve) => {
					held.resolve = () => resolve(answer);
					if (held.released) resolve(answer);
				}),
		);
	};
	return { ...actual, runGit };
});

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(sessions.splice(0).map((session) => session.close()));
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("does not let the HEAD lookup of a turn that changed nothing land on the next turn's base", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "atelier-own-changes-race-")));
	dirs.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(root, "a.ts"), "base\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	// A turn's end that waits for its lookup lets it go; without that wait, the next turn does, after its own write.
	const original = SessionReview.prototype.turnStarted;
	let firstTurn = true;
	vi.spyOn(SessionReview.prototype, "turnStarted").mockImplementation(function (this: SessionReview) {
		if (firstTurn) held.release();
		return original.call(this);
	});
	const write: FakeStep = {
		toolCall: { tool: "write", input: { path: "own.ts", content: "export const own = 1;\n" }, callId: "c-write" },
	};
	const declared: FakeStep = { toolCall: { tool: "risk", input: { none: true, reason: "test" }, callId: "c-risk" } };
	const main = new FakeBackend([
		[{ event: { type: "text_delta", text: "hola" } }, { event: finished }],
		[declared, write, { run: () => held.release() }, { event: finished }],
	]);
	const session = await Session.start({
		backend: main,
		cwd: root,
		tools: [createWriteTool({ home: join(root, "home") })],
		review: { createBackend: () => new FakeBackend([]) },
	});
	sessions.push(session);
	const collect = async (prompt: string) => {
		const events: AtelierEvent[] = [];
		for await (const event of session.send(prompt)) events.push(event);
		return events;
	};
	held.armed = true;
	await collect("hola");
	firstTurn = false;
	// Committed between the turns: the second turn starts after it, so it is none of that turn's change.
	await writeFile(join(root, "foreign-committed.ts"), "export const foreign = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "foreign");
	const events = await collect("write");
	const [assessed] = events.filter((event) => event.type === "review_assessed");
	expect(assessed).toMatchObject({ files: ["own.ts"], changedLines: 1 });
	expect(assessed).not.toHaveProperty("since");
});
