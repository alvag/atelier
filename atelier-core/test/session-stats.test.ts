import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderKey, readSessionStats } from "../src/index.ts";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-stats-home-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const header = (id: string, cwd: string, createdAt: string, version = 1) =>
	({ kind: "atelier.session", version, id, cwd, createdAt }) as const;
const config = (backend = "anthropic-api", model = "claude-sonnet-5-5") => ({
	type: "config",
	backend,
	model,
	mode: "normal",
});
const started = (backend: string, authSource: string, tag: object = {}) => ({
	type: "event",
	event: { type: "session_started", backend, model: "m", authSource, seq: 1, turnId: "t", ...tag },
});
const agent = (role: string, model: string, backend = "anthropic-api") => ({ role, backend, model });
const finished = (fields: object, tag: object = {}) => ({
	type: "event",
	event: { type: "turn_finished", stopReason: "end_turn", seq: 9, turnId: "t", ...fields, ...tag },
});

/** Writes a session file the way the store lays it out; `raw` lines are written as they are. */
async function save(cwd: string, id: string, lines: (object | string)[], end = "\n"): Promise<string> {
	const folder = join(home, ".atelier", "sessions", folderKey(cwd));
	await mkdir(folder, { recursive: true });
	const path = join(folder, `${id}.jsonl`);
	await writeFile(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + end);
	return path;
}

/** Every file under the sessions folder with its size and time, to show nothing was written. */
async function snapshot(): Promise<string[]> {
	const root = join(home, ".atelier", "sessions");
	const out: string[] = [];
	for (const folder of await readdir(root)) {
		for (const name of await readdir(join(root, folder))) {
			const path = join(root, folder, name);
			const info = await stat(path);
			out.push(`${path} ${info.size} ${info.mtimeMs} ${await readFile(path, "utf8")}`);
		}
	}
	return out.sort();
}

describe("readSessionStats", () => {
	it("adds up turns by day, project, model, phase and role, with the parts of each turn", async () => {
		await save("/work/a", "s1", [
			header("s1", "/work/a", "2026-10-20T10:00:00.000Z"),
			config(),
			started("anthropic-api", "api_key"),
			{ type: "prompt", turnId: "t1", text: "a prompt that names turn_finished" },
			finished({
				usage: usage(100, 10, 1000, 50),
				costUsd: 0.5,
				requests: 3,
				at: "2026-10-21T12:00:00.000Z",
				phases: {
					main: { usage: usage(80, 8, 1000, 50), costUsd: 0.4, requests: 2, agents: [agent("orchestrator", "opus")] },
					lenses: {
						usage: usage(20, 2),
						costUsd: 0.1,
						requests: 1,
						agents: [agent("review-risk", "sonnet"), agent("review-reliability", "haiku")],
					},
				},
			}),
		]);
		await save("/work/b", "s2", [
			header("s2", "/work/b", "2026-10-22T09:00:00.000Z"),
			config(),
			started("anthropic-api", "api_key"),
			finished({ usage: usage(5), costUsd: 0.25, requests: 1, at: "2026-10-22T12:00:00.000Z" }),
		]);

		const stats = await readSessionStats(home);

		expect(stats.sessions).toBe(2);
		expect(stats.total).toEqual({
			turns: 2,
			requests: 4,
			usage: usage(105, 10, 1000, 50),
			billedUsd: 0.75,
			subscriptionUsd: 0,
			unpriced: 0,
		});
		expect(stats.byDay.map((row) => [row.key, row.turns, row.billedUsd])).toEqual([
			["2026-10-21", 1, 0.5],
			["2026-10-22", 1, 0.25],
		]);
		expect(stats.byProject.map((row) => [row.key, row.billedUsd])).toEqual([
			["/work/a", 0.5],
			["/work/b", 0.25],
		]);
		expect(stats.byModel.map((row) => [row.key, row.billedUsd])).toEqual([
			["opus", 0.4],
			["claude-sonnet-5-5", 0.25],
			["mixed", 0.1],
		]);
		expect(stats.byPhase.map((row) => [row.key, row.turns, row.billedUsd])).toEqual([
			["main", 2, 0.65],
			["lenses", 1, 0.1],
		]);
		expect(stats.byRole.map((row) => row.key)).toEqual(["orchestrator", "mixed"]);
		expect(stats.skipped).toEqual([]);
	});

	it("counts a subagent's turns apart, and not the review's, which the turn's parts already hold", async () => {
		await save("/work/a", "s1", [
			header("s1", "/work/a", "2026-10-20T10:00:00.000Z"),
			config(),
			started("anthropic-api", "api_key"),
			finished(
				{
					usage: usage(7),
					costUsd: 0.07,
					requests: 1,
					phases: { main: { usage: usage(7), agents: [agent("orchestrator", "haiku")] } },
				},
				{ agent: "explorer", parentCallId: "c1" },
			),
			finished({ usage: usage(9), costUsd: 0.09 }, { agent: "verify:verifier", parentCallId: "v1" }),
			finished({ usage: usage(9), costUsd: 0.09 }, { agent: "review:risk", parentCallId: "r1" }),
			finished({
				usage: usage(10),
				costUsd: 0.1,
				requests: 2,
				phases: { main: { usage: usage(1), costUsd: 0.01 }, verify: { usage: usage(9), costUsd: 0.09 } },
			}),
		]);

		const stats = await readSessionStats(home);

		expect(stats.total).toMatchObject({ turns: 1, requests: 3, usage: usage(17) });
		expect(stats.total.billedUsd).toBeCloseTo(0.17);
		expect(stats.byPhase.map((row) => row.key)).toEqual(["main", "verify", "subagent"]);
		expect(stats.byRole.map((row) => [row.key, row.turns])).toEqual([
			["unknown", 1],
			["explorer", 1],
			["orchestrator", 1],
		]);
		expect(stats.byModel.map((row) => row.key)).toEqual(["claude-sonnet-5-5", "haiku"]);
	});

	it("keeps a subscription's cost apart and counts parts without a cost as unpriced, never as zero", async () => {
		await save("/work/a", "s1", [
			header("s1", "/work/a", "2026-10-20T10:00:00.000Z"),
			config("claude-code", "opus"),
			started("claude-code", "subscription"),
			finished({ usage: usage(1), costUsd: 2 }),
			config("anthropic-api", "sonnet"),
			started("anthropic-api", "api_key"),
			finished({ usage: usage(1) }),
		]);

		const stats = await readSessionStats(home);

		expect(stats.total).toMatchObject({ turns: 2, billedUsd: 0, subscriptionUsd: 2, unpriced: 1 });
		expect(stats.byModel.map((row) => [row.key, row.subscriptionUsd, row.unpriced])).toEqual([
			["opus", 2, 0],
			["sonnet", 0, 1],
		]);
	});

	it("dates a turn without at by its session's start, and leaves out what came before since", async () => {
		await save("/work/a", "old", [
			header("old", "/work/a", "2026-10-01T10:00:00.000Z"),
			config(),
			finished({ usage: usage(1), costUsd: 1 }),
			finished({ usage: usage(1), costUsd: 1, at: "2026-10-25T10:00:00.000Z" }),
		]);

		const all = await readSessionStats(home);
		const recent = await readSessionStats(home, { since: new Date("2026-10-20T00:00:00.000Z") });

		expect(all.byDay.map((row) => row.key)).toEqual(["2026-10-01", "2026-10-25"]);
		expect(recent.total).toMatchObject({ turns: 1, billedUsd: 1 });
	});

	it("reads one project only, by its working directory", async () => {
		await save("/work/a", "s1", [header("s1", "/work/a", "2026-10-20T10:00:00.000Z"), finished({ usage: usage(1) })]);
		await save("/work/b", "s2", [header("s2", "/work/b", "2026-10-20T10:00:00.000Z"), finished({ usage: usage(2) })]);

		const stats = await readSessionStats(home, { project: "/work/b" });

		expect(stats.byProject.map((row) => row.key)).toEqual(["/work/b"]);
		expect(stats.total.usage).toEqual(usage(2));
	});

	it("skips corrupt files and other versions, says why, and keeps a turn torn by a crash out", async () => {
		await save("/work/a", "bad", [
			header("bad", "/work/a", "2026-10-20T10:00:00.000Z"),
			'{"type":"event","event":{"type":"turn_finished",',
			finished({ usage: usage(1) }),
		]);
		await save("/work/a", "new", [
			header("new", "/work/a", "2026-10-20T10:00:00.000Z", 2),
			finished({ usage: usage(1) }),
		]);
		await save("/work/a", "nohead", ["{}", finished({ usage: usage(1) })]);
		await save(
			"/work/a",
			"torn",
			[
				header("torn", "/work/a", "2026-10-20T10:00:00.000Z"),
				finished({ usage: usage(4) }),
				'{"type":"event","event":{"type":"turn_fin',
			],
			"",
		);

		const stats = await readSessionStats(home);

		expect(stats.total).toMatchObject({ turns: 1, usage: usage(4) });
		expect(stats.skipped.map(({ code, message }) => [code, message]).sort()).toEqual([
			["corrupt", "line 2 is not valid JSON"],
			["corrupt", "the first line is not an atelier.session header"],
			["unsupported_version", "it was saved with session format version 2"],
		]);
	});

	it("never writes to the sessions folder, and answers nothing for a home without sessions", async () => {
		const path = await save("/work/a", "s1", [
			header("s1", "/work/a", "2026-10-20T10:00:00.000Z"),
			finished({ usage: usage(1) }),
		]);
		await utimes(path, new Date("2026-10-20T10:00:00.000Z"), new Date("2026-10-20T10:00:00.000Z"));
		await chmod(path, 0o444);
		const before = await snapshot();

		await readSessionStats(home);

		expect(await snapshot()).toEqual(before);
		const empty = await readSessionStats(await mkdtemp(join(tmpdir(), "atelier-stats-empty-")));
		expect(empty).toMatchObject({ sessions: 0, total: { turns: 0, unpriced: 0 }, byDay: [], skipped: [] });
	});
});
