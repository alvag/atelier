import { execFileSync, type SpawnSyncOptions } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";
import { projectRefusal } from "../src/tools/protection.ts";
import { gitConfigFixture } from "./support/git-config-cases.ts";

const gitFault = vi.hoisted(() => ({
	failRevParse: false,
	// Production gives each git 5 s, which a loaded machine can exceed; the tools then take their fallback path and the pinned counts fail for no defect.
	timeoutMs: 30_000,
	revParses: [] as { args: readonly string[]; status: number | null; code: string | undefined; elapsedMs: number }[],
	/** Every real git stopped before it exited: by this test's git timeout, or by Node at its output buffer. */
	stopped: [] as { args: readonly string[]; elapsedMs: number; code: "ETIMEDOUT" | "ENOBUFS" }[],
	/** Cuts the nth `--get-all` at its buffer as Node does, with the exit status Node can report for it. */
	cutGetAll: undefined as { read: number; status: 0 | null } | undefined,
	getAlls: 0,
	/** Stops every git config before it answers anything, as Node does at a buffer or a timeout. */
	stopConfig: undefined as "ENOBUFS" | "ETIMEDOUT" | undefined,
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
					: cp.spawnSync(command, args, command === "git" ? { ...options, timeout: gitFault.timeoutMs } : options);
			const elapsedMs = Math.round(performance.now() - start);
			const cut = gitFault.cutGetAll;
			const cutHere =
				cut !== undefined && command === "git" && args.includes("--get-all") && ++gitFault.getAlls === cut.read;
			if (cutHere)
				Object.assign(run, {
					stdout: (run.stdout as Buffer).subarray(0, options.maxBuffer),
					status: cut.status,
					signal: cut.status === null ? "SIGTERM" : null,
					error: Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" }),
				});
			const stopHere = gitFault.stopConfig !== undefined && command === "git" && args[0] === "config";
			if (stopHere)
				Object.assign(run, {
					stdout: Buffer.alloc(0),
					status: null,
					signal: "SIGTERM",
					error: Object.assign(new Error(`spawnSync git ${gitFault.stopConfig}`), { code: gitFault.stopConfig }),
				});
			const injected = (gitFault.failRevParse && args[0] === "rev-parse") || cutHere || stopHere;
			const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
			// ENOBUFS with status 0 means git exited before Node could kill it, which the tools accept.
			if (command === "git" && !injected && (code === "ETIMEDOUT" || (code === "ENOBUFS" && run.status === null)))
				gitFault.stopped.push({ args, elapsedMs, code });
			if (command === "git" && args[0] === "rev-parse")
				gitFault.revParses.push({
					args,
					status: run.status,
					code,
					elapsedMs,
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
	gitFault.stopped.length = 0;
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
	gitFault.cutGetAll = undefined;
	gitFault.stopConfig = undefined;
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

/** Each test runs git several times; under load that takes far longer than the default 5 s. */
const gitHeavy = { timeout: 90_000 };

const refused = (path: string) => `${path} is git state that runs code: the agent does not write it.`;

const refusal = (path: string) => ({
	ok: false,
	output: refused(path),
});

describe("edit and write look at the git places again where they can have changed", gitHeavy, () => {
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

describe("a git config read git does not finish keeps the protection", gitHeavy, () => {
	it.each(["ENOBUFS", "ETIMEDOUT"] as const)(
		"of a config that starts with a byte order mark: stopped by %s",
		async (code) => {
			await writeFile(join(cwd, ".git", "config"), "\uFEFF[include]\npath = ../bom-target.cfg\n");
			const target = join(cwd, "bom-target.cfg");
			await writeFile(target, "# included\n");
			gitFault.stopConfig = code;
			const input = { path: "bom-target.cfg", content: "[core]\nhooksPath = attacker-hooks\n" };
			const tool = createWriteTool({ home });
			expect(await projectRefusal("write", cwd, target, target, home)).toBe(refused(target));
			expect(await tool.gate?.(input, { cwd })).toEqual({
				refusal: { output: refusal("bom-target.cfg").output, summary: refusal("bom-target.cfg").output },
			});
			expect(await tool.execute(input, { cwd })).toMatchObject(refusal("bom-target.cfg"));
			expect(await readFile(target, "utf8")).toBe("# included\n");
		},
	);

	it.each([
		{ label: "as git and Node end it", cut: undefined },
		{ label: "cut with status null", cut: { read: 1, status: null } as const },
	])(
		"whatever order the includes are read in: a file reached first by a long chain is followed from a short one ($label)",
		async ({ cut }) => {
			// git lists the plain includes first; the parser lists the conditional one first, which leads ten files deep.
			await appendFile(
				join(cwd, ".git", "config"),
				`[includeIf "gitdir:/never/"]\n\tpath = "../deep#cfg"\n[include]\n${"\tpath = ../harmless.cfg\n".repeat(70_000)}\tpath = ../common.cfg\n`,
			);
			const chain = ["deep#cfg", ...Array.from({ length: 8 }, (_, i) => `d${i + 2}.cfg`), "common.cfg"];
			for (const [index, name] of chain.entries())
				if (index + 1 < chain.length) await writeFile(join(cwd, name), `[include]\n\tpath = ${chain[index + 1]}\n`);
			await writeFile(join(cwd, "common.cfg"), "[include]\n\tpath = child.cfg\n");
			await writeFile(join(cwd, "child.cfg"), "[include]\n\tpath = target.cfg\n");
			const target = join(cwd, "target.cfg");
			await writeFile(target, "# included\n");
			gitFault.cutGetAll = cut;
			const input = { path: "target.cfg", content: "[core]\nhooksPath = attacker-hooks\n" };
			const tool = createWriteTool({ home });
			for (const check of ["refusal", "gate", "execute"] as const) {
				gitFault.getAlls = 0;
				if (check === "refusal") expect(await projectRefusal("write", cwd, target, target, home)).toBe(refused(target));
				else if (check === "gate")
					expect(await tool.gate?.(input, { cwd })).toEqual({
						refusal: { output: refusal("target.cfg").output, summary: refusal("target.cfg").output },
					});
				else expect(await tool.execute(input, { cwd })).toMatchObject(refusal("target.cfg"));
			}
			expect(await readFile(target, "utf8")).toBe("# included\n");
		},
	);

	// A broken include makes rev-parse fail, so the hooks path is read from the file too.
	for (const stop of [undefined, "ENOBUFS", "ETIMEDOUT"] as const)
		it.each([
			{ label: "the old [includeIf.foo] syntax", config: "[includeIf.foo]\n\tpath = ../old.cfg\n", path: "old.cfg" },
			// An empty hooks path is the repository's top, as with every read of the whole file.
			{
				label: "a valueless core.hooksPath last",
				config: "[core]\n\thooksPath = first-hooks\n\thooksPath\n",
				path: "ordinary.cfg",
			},
			{ label: "a valueless include.path", config: "[include]\n\tpath\n", path: join(".git", "description") },
			// git reports a valueless conditional include by its key.
			{
				label: "a valueless includeIf path",
				config: '[includeIf "gitdir:/Never/"]\n\tpath\n',
				path: join(".git", "includeif.gitdir:", "Never", ".path"),
			},
		])(
			`protects as git reads it: $label (git config ${stop === undefined ? "answered" : `stopped by ${stop}`})`,
			async ({ config, path }) => {
				await appendFile(join(cwd, ".git", "config"), `${config}[include]\n\tpath = ../broken.cfg\n`);
				await writeFile(join(cwd, "broken.cfg"), "[invalid\n");
				const target = join(cwd, path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, "original\n");
				gitFault.stopConfig = stop;
				expect(await projectRefusal("write", cwd, target, target, home)).toBe(refused(target));
				const input = { path: target, content: "changed\n" };
				expect(await createWriteTool({ home }).execute(input, { cwd })).toMatchObject({
					ok: false,
					output: refused(target),
				});
				expect(await readFile(target, "utf8")).toBe("original\n");
			},
		);
});

describe.skipIf(process.platform === "win32")("how many git processes one edit or write runs", gitHeavy, () => {
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

	/**
	 * Runs first: a git stopped before it answered changes the path the tools take, which is not a wrong count. A
	 * get-all Node cuts at its buffer is read as cut whether git exited first or not, with the same counts and refusal
	 * (pinned by the cut test below), so `overflowing` accepts it; a timeout still fails.
	 */
	function expectNoStoppedGit(overflowing = false) {
		const stopped = gitFault.stopped.filter(
			({ args, code }) => !(overflowing && code === "ENOBUFS" && args.includes("--get-all")),
		);
		const message = stopped
			.map(({ args, elapsedMs, code }) =>
				code === "ETIMEDOUT"
					? `git ${args.join(" ")} was stopped by this test's ${gitFault.timeoutMs} ms git timeout after ${elapsedMs} ms: the machine was too slow, this is not a wrong count`
					: `git ${args.join(" ")} was killed by Node at its output buffer after ${elapsedMs} ms, before it could exit: it lost that race, this is not a wrong count`,
			)
			.join("; ");
		expect(stopped, message).toEqual([]);
	}

	function expectRevParseResults(forceRevParse: boolean, overflowing = false) {
		expectNoStoppedGit(overflowing);
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
					gitFault.stopped.length = 0;
					const result = phase === "gate" ? await tool.gate?.(input, { cwd }) : await tool.execute(input, { cwd });
					expectRevParseResults(forceRevParse, legacy);
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
		);

	for (const forceRevParse of [false, true])
		it.each([
			{ label: "as git and Node end it", cut: undefined },
			...([0, null] as const).flatMap((status) =>
				(forceRevParse ? [1, 5] : [1]).map((read) => ({
					label: `read ${read} cut with status ${status}`,
					cut: { read, status },
				})),
			),
		])(
			`a get-all over its buffer protects what git would have reported, with the same counts: $label (forced rev-parse failure=${forceRevParse})`,
			async ({ cut }) => {
				await gitConfigFixture(base, "get-all just over the old buffer");
				// The last include sits past the 1 MiB the cut get-all keeps.
				await appendFile(join(cwd, ".git", "config"), '\tpath = "../last#cfg"\n');
				await writeFile(join(cwd, "last#cfg"), "# included\n");
				gitFault.failRevParse = forceRevParse;
				for (const path of ["team#cfg", "last#cfg"]) {
					const before = await readFile(join(cwd, path));
					const input = { path, content: "[core]\nhooksPath = evil-hooks\n" };
					const tool = createWriteTool({ home });
					for (const phase of ["gate", "execute"] as const) {
						await writeFile(log, "");
						gitFault.revParses.length = 0;
						gitFault.stopped.length = 0;
						gitFault.getAlls = 0;
						gitFault.cutGetAll = cut;
						const result = phase === "gate" ? await tool.gate?.(input, { cwd }) : await tool.execute(input, { cwd });
						expectRevParseResults(forceRevParse, true);
						if (phase === "gate")
							expect(result).toEqual({ refusal: { output: refusal(path).output, summary: refusal(path).output } });
						else expect(result).toMatchObject(refusal(path));
						expect(await readFile(join(cwd, path))).toEqual(before);
						// The same as a read git finishes: a cut read never reads the root config once more.
						await expectConfigGroups(true, (forceRevParse ? 5 : 1) * 4);
					}
				}
			},
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
					gitFault.stopped.length = 0;
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
