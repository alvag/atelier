import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";

type FakeToolInput = Extract<FakeStep, { toolCall: unknown }>["toolCall"]["input"];

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

let base: string;
let cwd: string;
let home: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-git-recheck-")));
	cwd = join(base, "repo");
	home = join(base, "home");
	await mkdir(cwd);
	await mkdir(home);
	git("init", "-q");
	await writeFile(join(cwd, "a.txt"), "old\n");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

/** Runs each list of calls as one turn of the same session, answering every question with `approve`. */
async function session(turns: FakeStep[][], approve: () => Promise<boolean> = async () => true, between?: () => void) {
	const backend = new FakeBackend(turns.map((calls) => [...calls, finished]));
	const started = await Session.start({
		backend,
		cwd,
		tools: [createEditTool({ home }), createWriteTool({ home })],
		approve,
	});
	try {
		for (const [index] of turns.entries()) {
			if (index > 0) between?.();
			for await (const _ of started.send("go"));
		}
	} finally {
		await started.close();
	}
	return backend.toolResults;
}

const refusal = (path: string) => ({
	ok: false,
	output: `${path} is git state that runs code: the agent does not write it.`,
});

describe("edit and write look at the git places again where they can have changed", () => {
	it("between the question and the write: a core.hooksPath set while the user is asked is refused", async () => {
		const hooks = join(base, "outside-hooks");
		await mkdir(hooks);
		const hook = join(hooks, "pre-commit");
		await writeFile(hook, "old\n");
		const results = await session(
			[
				[
					{
						toolCall: { tool: "edit", callId: "e", input: { path: hook, edits: [{ oldText: "old", newText: "new" }] } },
					},
					{ toolCall: { tool: "write", callId: "w", input: { path: hook, content: "new\n" } } },
				],
			],
			async () => {
				git("config", "core.hooksPath", hooks);
				return true;
			},
		);
		expect(results).toEqual([refusal(hook), refusal(hook)]);
		expect(await readFile(hook, "utf8")).toBe("old\n");
	});

	it("between calls: a core.hooksPath set after one write protects the next one", async () => {
		await mkdir(join(cwd, ".hooks"));
		const write = (callId: string): FakeStep => ({
			toolCall: { tool: "write", callId, input: { path: ".hooks/pre-commit", content: "new\n" } },
		});
		const results = await session([[write("first")], [write("second")]], undefined, () =>
			git("config", "core.hooksPath", ".hooks"),
		);
		expect(results[0]?.ok).toBe(true);
		expect(results[1]).toEqual(refusal(".hooks/pre-commit"));
	});
});

describe.skipIf(process.platform === "win32")("how many git processes one edit or write runs", () => {
	let bin: string;
	let log: string;
	const path = process.env.PATH;

	beforeAll(async () => {
		bin = await mkdtemp(join(tmpdir(), "atelier-git-count-"));
		log = join(bin, "log");
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		// Every git the tools run goes through this one, which writes down its arguments.
		await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
		await chmod(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${path}`;
	});

	afterAll(async () => {
		process.env.PATH = path;
		await rm(bin, { recursive: true, force: true });
	});

	for (const warm of [false, true])
		it.each<[string, FakeToolInput]>([
			["edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] }],
			["write", { path: "a.txt", content: "new\n" }],
		])(`%s checks git before writing (${warm ? "warm" : "cold"} worktree lookup)`, async (tool, input) => {
			if (warm) {
				await session([[{ toolCall: { tool, callId: "warm", input } }]]);
				await writeFile(join(cwd, "a.txt"), "old\n");
			}
			await writeFile(log, "");
			const results = await session([[{ toolCall: { tool, callId: "c", input } }]]);
			expect(results[0]?.ok).toBe(true);
			const runs = (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
			expect(runs).toHaveLength(warm ? 4 : 5);
			expect(runs.filter((line) => line.includes("--absolute-git-dir"))).toHaveLength(2);
			// Both gate and execute read the config; a plain checkout's git and common directories are the same.
			const configs = runs.filter((line) => line.startsWith(`config --file ${join(cwd, ".git", "config")} `));
			expect(configs).toHaveLength(2);
			expect(configs.every((line) => line.includes("--no-includes -z --get-regexp"))).toBe(true);
		});
});
