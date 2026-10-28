import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folderKey, readSessionStats } from "../src/index.ts";

/** Runs once the reader has taken the file's last line, before it decides whether that line was torn. */
const atEnd: { run?: () => void } = {};

vi.mock("node:readline", async (original) => {
	const readline = await original<typeof import("node:readline")>();
	return {
		...readline,
		createInterface: (...args: Parameters<typeof readline.createInterface>) => {
			const lines = readline.createInterface(...args);
			const iterate = lines[Symbol.asyncIterator].bind(lines);
			return Object.assign(lines, {
				async *[Symbol.asyncIterator]() {
					yield* { [Symbol.asyncIterator]: iterate };
					atEnd.run?.();
				},
			});
		},
	};
});

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-stats-live-"));
});
afterEach(async () => {
	delete atEnd.run;
	await rm(home, { recursive: true, force: true });
});

describe("readSessionStats on a session being written", () => {
	it("keeps out a last line the recorder finishes while it reads, instead of calling the file corrupt", async () => {
		const folder = join(home, ".atelier", "sessions", folderKey("/work/a"));
		await mkdir(folder, { recursive: true });
		const path = join(folder, "live.jsonl");
		const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
		const turn = (turnId: string) =>
			JSON.stringify({
				type: "event",
				event: { type: "turn_finished", stopReason: "end_turn", seq: 9, turnId, usage },
			});
		const header = {
			kind: "atelier.session",
			version: 1,
			id: "live",
			cwd: "/work/a",
			createdAt: "2026-10-20T10:00:00.000Z",
		};
		const second = turn("t2");
		const half = Math.floor(second.length / 2);
		await writeFile(path, `${JSON.stringify(header)}\n${turn("t1")}\n${second.slice(0, half)}`);
		// The rest of the line and its newline land after the read reached the end of the file.
		atEnd.run = () => appendFileSync(path, `${second.slice(half)}\n`);

		const stats = await readSessionStats(home);

		expect(stats.skipped).toEqual([]);
		expect(stats.total).toMatchObject({ turns: 1, usage });
	});
});
