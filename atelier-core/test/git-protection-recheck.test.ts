import { execFileSync, type SpawnSyncOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";
import { gitConfigFixture } from "./support/git-config-cases.ts";

const gitFault = vi.hoisted(() => ({
	failRevParse: false,
	revParses: [] as { args: readonly string[]; status: number | null; code: string | undefined; elapsedMs: number }[],
}));
vi.mock("node:child_process", async (original) => {
	const cp = await original<typeof import("node:child_process")>();
	return {
		...cp,
		spawnSync(command: string, args: readonly string[], options: SpawnSyncOptions) {
			const start = performance.now();
			const run =
				gitFault.failRevParse && command === "git" && args[0] === "rev-parse"
					? {
							pid: 0,
							output: [null, "", ""],
							stdout: "",
							stderr: "",
							status: null,
							signal: "SIGTERM",
							error: Object.assign(new Error("controlled Git timeout"), { code: "ETIMEDOUT" }),
						}
					: cp.spawnSync(command, args, options);
			if (command === "git" && args[0] === "rev-parse")
				gitFault.revParses.push({
					args,
					status: run.status,
					code: (run.error as NodeJS.ErrnoException | undefined)?.code,
					elapsedMs: Math.round(performance.now() - start),
				});
			return run;
		},
	};
});

type FakeToolInput = Extract<FakeStep, { toolCall: unknown }>["toolCall"]["input"];

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

let base: string;
let cwd: string;
let home: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeEach(async () => {
	gitFault.revParses.length = 0;
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-git-recheck-")));
	cwd = join(base, "repo");
	home = join(base, "home");
	await mkdir(cwd);
	await mkdir(home);
	git("init", "-q");
	await writeFile(join(cwd, "a.txt"), "old\n");
});

afterEach(async () => {
	gitFault.failRevParse = false;
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

	function expectRevParseResults(forceRevParse: boolean) {
		expect(gitFault.revParses.length).toBeGreaterThan(0);
		for (const run of gitFault.revParses) {
			const message = forceRevParse
				? "The controlled rev-parse failure must return null status and ETIMEDOUT."
				: `Unforced git ${run.args.join(" ")} failed after ${run.elapsedMs} ms (status=${run.status}, error=${run.code ?? "none"}). Git may be slow or timed out under load; the normal-path counts must not switch to fallback expectations.`;
			expect(run.status, message).toBe(forceRevParse ? null : 0);
			if (forceRevParse) expect(run.code).toBe("ETIMEDOUT");
		}
	}

	/** Both paths pin exact counts; every config read must also keep its query shape. */
	async function expectConfigGroups(legacy: boolean, expectedQueries: number) {
		const runs = (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
		const prefix = `config --file ${join(cwd, ".git", "config")} `;
		const configs = runs.filter((line) => line.startsWith(prefix));
		const queries = ["--get-regexp ^(include\\.path|includeif\\..*\\.path|core\\.hookspath)$"];
		if (legacy) queries.push("--get-all include.path", "--get-regexp ^includeif\\..*\\.path$", "--get core.hooksPath");
		const group = queries.map((query) => `${prefix}--no-includes -z ${query}`);
		expect(configs).toHaveLength(expectedQueries);
		for (let offset = 0; offset < configs.length; offset += group.length)
			expect(configs.slice(offset, offset + group.length)).toEqual(group);
		return { runs, configs };
	}

	for (const forceRevParse of [false, true])
		it.each(["invalid UTF-8 below the old buffer", "get-all just over the old buffer"] as const)(
			`uses actual git query results rather than an emulated cutoff: %s (forced rev-parse failure=${forceRevParse})`,
			async (kind) => {
				await gitConfigFixture(base, kind);
				gitFault.failRevParse = forceRevParse;
				const before = await readFile(join(cwd, "team#cfg"));
				const tool = createWriteTool({ home });
				const input = { path: "team#cfg", content: "[core]\nhooksPath = evil-hooks\n" };
				const legacy = kind === "get-all just over the old buffer";
				for (const phase of ["gate", "execute"] as const) {
					await writeFile(log, "");
					gitFault.revParses.length = 0;
					const result = phase === "gate" ? await tool.gate?.(input, { cwd }) : await tool.execute(input, { cwd });
					expectRevParseResults(forceRevParse);
					if (phase === "gate")
						expect(result).toEqual({
							refusal: { output: refusal("team#cfg").output, summary: refusal("team#cfg").output },
						});
					else expect(result).toMatchObject(refusal("team#cfg"));
					expect(await readFile(join(cwd, "team#cfg"))).toEqual(before);
					// Five root-config reads per fallback check; invalid UTF-8 still needs no legacy queries.
					await expectConfigGroups(legacy, (forceRevParse ? 5 : 1) * (legacy ? 4 : 1));
					expect(gitFault.revParses.filter((run) => run.args.includes("--absolute-git-dir"))).toHaveLength(1);
				}
			},
			90_000,
		);

	for (const forceRevParse of [false, true])
		for (const warm of [false, true])
			it.each<[string, FakeToolInput]>([
				["edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] }],
				["write", { path: "a.txt", content: "new\n" }],
			])(
				`%s checks git before writing (${warm ? "warm" : "cold"} worktree lookup, forced rev-parse failure=${forceRevParse})`,
				async (tool, input) => {
					gitFault.failRevParse = forceRevParse;
					if (warm) {
						await session([[{ toolCall: { tool, callId: "warm", input } }]]);
						expectRevParseResults(forceRevParse);
						await writeFile(join(cwd, "a.txt"), "old\n");
					}
					await writeFile(log, "");
					gitFault.revParses.length = 0;
					const results = await session([[{ toolCall: { tool, callId: "c", input } }]]);
					expectRevParseResults(forceRevParse);
					expect(results[0]?.ok).toBe(true);
					expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("new\n");
					const { runs } = await expectConfigGroups(false, forceRevParse ? 10 : 2);
					const checks = gitFault.revParses.filter((run) => run.args.includes("--absolute-git-dir"));
					// Gate and execute must each check the repository, even when rev-parse fails.
					expect(checks).toHaveLength(2);
					expect(gitFault.revParses).toHaveLength(warm ? 2 : 3);
					// Forced rev-parse attempts are injected, not spawned: only ten real config processes remain.
					expect(runs).toHaveLength(forceRevParse ? 10 : warm ? 4 : 5);
				},
			);
});
