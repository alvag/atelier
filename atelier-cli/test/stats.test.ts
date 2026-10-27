import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { folderKey } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/run.ts";

/** Days are local: the tests run in UTC unless a test names its zone. */
let zone: string | undefined;
beforeEach(() => {
	zone = process.env.TZ;
	process.env.TZ = "UTC";
});
afterEach(() => {
	if (zone === undefined) Reflect.deleteProperty(process.env, "TZ");
	else process.env.TZ = zone;
});

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-cli-stats-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});
const started = (backend: string, authSource: string) => ({
	type: "event",
	event: { type: "session_started", backend, model: "m", authSource, seq: 1, turnId: "t" },
});
const finished = (at: string, fields: object) => ({
	type: "event",
	event: { type: "turn_finished", stopReason: "end_turn", seq: 2, turnId: "t", at, ...fields },
});

async function save(cwd: string, id: string, lines: (object | string)[]): Promise<void> {
	const folder = join(home, ".atelier", "sessions", folderKey(cwd));
	await mkdir(folder, { recursive: true });
	const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
	await writeFile(join(folder, `${id}.jsonl`), `${text}\n`);
}

async function stats(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await run(["stats", ...argv], {
		stdin: new PassThrough(),
		isTTY: false,
		stdout: (text) => {
			out += text;
		},
		stderr: (text) => {
			err += text;
		},
		cwd: "/work/a",
		home,
		color: false,
	});
	return { code, out, err };
}

beforeEach(async () => {
	await save("/work/a", "s1", [
		{ kind: "atelier.session", version: 1, id: "s1", cwd: "/work/a", createdAt: "2026-10-20T10:00:00.000Z" },
		{ type: "config", backend: "anthropic-api", model: "claude-sonnet-5-5", mode: "normal" },
		started("anthropic-api", "api_key"),
		finished("2026-10-20T12:00:00.000Z", {
			usage: usage(1200, 3400, 2_100_000, 50_000),
			costUsd: 1.5,
			requests: 12,
			phases: {
				main: { usage: usage(1000, 3000, 2_000_000, 50_000), costUsd: 1.25, requests: 10 },
				verify: { usage: usage(200, 400, 100_000), costUsd: 0.25, requests: 2 },
			},
		}),
	]);
	await save("/work/b", "s2", [
		{ kind: "atelier.session", version: 1, id: "s2", cwd: "/work/b", createdAt: "2026-10-21T10:00:00.000Z" },
		{ type: "config", backend: "claude-code", model: "claude-opus-5-5", mode: "normal" },
		started("claude-code", "subscription"),
		finished("2026-10-21T12:00:00.000Z", { usage: usage(10, 20), costUsd: 3, requests: 1 }),
		finished("2026-10-21T13:00:00.000Z", { usage: usage(10, 20), requests: 1 }),
	]);
	await save("/work/b", "bad", ['{"kind":"atelier.session","version":7,"id":"bad","cwd":"/work/b"}']);
});

describe("atelier stats", () => {
	it("prints the totals and every breakdown, a subscription's cost apart and unknown costs as unknown", async () => {
		const { code, out, err } = await stats("--since", "all");

		expect(code).toBe(0);
		expect(err).toBe("");
		expect(out).toBe(
			[
				"atelier stats · all time · 2 sessions · 2 projects",
				"",
				"Total    $1.50 billed · ≈$3.00 subscription (API-equivalent, not billed) · 1 turn with no known cost",
				"         3 turns · 14 requests",
				"Tokens   in 1.2k · out 3.4k · cache read 2.1M · cache write 50k",
				"",
				"By day       cost                     turns   requests     in    out   cache r   cache w",
				"2026-10-20   $1.50                        1         12   1.2k   3.4k      2.1M       50k",
				"2026-10-21   ≈$3.00 sub · 1 unknown       2          2     20     40         0         0",
				"",
				"By project   cost                     turns   requests     in    out   cache r   cache w",
				"/work/b      ≈$3.00 sub · 1 unknown       2          2     20     40         0         0",
				"/work/a      $1.50                        1         12   1.2k   3.4k      2.1M       50k",
				"",
				"By model            cost                     turns   requests     in    out   cache r   cache w",
				"claude-opus-5-5     ≈$3.00 sub · 1 unknown       2          2     20     40         0         0",
				"claude-sonnet-5-5   $1.50                        1         12   1.2k   3.4k      2.1M       50k",
				"",
				"By phase   cost                             turns   requests     in    out   cache r   cache w",
				"main       $1.25 · ≈$3.00 sub · 1 unknown       3         12   1.0k   3.0k      2.0M       50k",
				"verify     $0.25                                1          2    200    400      100k         0",
				"",
				"By role        cost                             turns   requests     in    out   cache r   cache w",
				"orchestrator   $1.25 · ≈$3.00 sub · 1 unknown       3         12   1.0k   3.0k      2.0M       50k",
				"unknown        $0.25                                1          2    200    400      100k         0",
				"",
				"Skipped 1 session file: 1 from another session format version (atelier stats --json lists them).",
				"",
			].join("\n"),
		);
	});

	it("shows one breakdown with --by and one project with --project", async () => {
		const { out } = await stats("--since", "2026-10-01", "--project", ".", "--by", "model");

		expect(out).toContain("atelier stats · since 2026-10-01 · 1 session · 1 project");
		expect(out).toContain("By model");
		expect(out).not.toContain("By day");
		expect(out).not.toContain("/work/b");
	});

	it("leaves billed out when nothing was billed, and explains a mixed row under its table", async () => {
		await save("/work/c", "s3", [
			{ kind: "atelier.session", version: 1, id: "s3", cwd: "/work/c", createdAt: "2026-10-22T10:00:00.000Z" },
			{ type: "config", backend: "claude-code", model: "claude-opus-5-5", mode: "normal" },
			started("claude-code", "subscription"),
			finished("2026-10-22T12:00:00.000Z", {
				usage: usage(10, 20),
				costUsd: 2,
				phases: {
					lenses: {
						usage: usage(10, 20),
						costUsd: 2,
						agents: [
							{ role: "review-risk", backend: "claude-code", model: "claude-sonnet-5-5" },
							{ role: "review-reliability", backend: "claude-code", model: "claude-haiku-5-5" },
						],
					},
				},
			}),
		]);

		const { out } = await stats("--since", "all", "--project", "/work/c");

		expect(out).toContain("\nTotal    ≈$2.00 subscription (API-equivalent, not billed)\n");
		expect(out).toMatch(
			/\nmixed +≈\$2\.00 sub +1 .*\nmixed: parts of a turn that ran on several models, whose saved turns do not say what each one spent\.\n/,
		);
		expect(out).toContain(
			"mixed: parts of a turn that ran on several roles, whose saved turns do not say what each one spent.\n",
		);
	});

	it("answers JSON for scripts with --json", async () => {
		const { code, out } = await stats("--since", "all", "--json");

		expect(code).toBe(0);
		const json = JSON.parse(out);
		expect(json).toMatchObject({
			since: null,
			sessions: 2,
			total: { turns: 3, requests: 14, billedUsd: 1.5, subscriptionUsd: 3, unpriced: 1 },
			skipped: [{ code: "unsupported_version" }],
		});
		expect(json.byDay.map((row: { key: string }) => row.key)).toEqual(["2026-10-20", "2026-10-21"]);
	});

	it("says when the period holds no turns", async () => {
		const { code, out } = await stats("--since", "2099-01-01", "--by", "day");

		expect(code).toBe(0);
		expect(out).toContain("No turns since 2099-01-01.");
	});

	it("refuses options it does not know and the stats options elsewhere", async () => {
		for (const [argv, message] of [
			[["--since", "yesterday"], "--since must be a number of days (7d), a date (2026-10-01) or all."],
			[["--by", "week"], "--by must be day, project, model, phase or role."],
			[["--model", "x"], "atelier stats takes no session options (--model)."],
			[["extra"], "Usage: atelier stats"],
		] as const) {
			const { code, err } = await stats(...argv);
			expect(code).toBe(2);
			expect(err).toContain(message);
		}
		let err = "";
		const code = await run(["--json", "hi"], {
			stdin: new PassThrough(),
			isTTY: false,
			stdout: () => {},
			stderr: (text) => {
				err += text;
			},
			cwd: "/work/a",
			home,
			color: false,
		});
		expect(code).toBe(2);
		expect(err).toContain("--json is only valid with atelier stats.");
	});
});
