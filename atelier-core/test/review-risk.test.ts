import { describe, expect, it } from "vitest";
import type { Candidate, ChangedFile } from "../src/review/candidate.ts";
import { assessRisk, LENSES, tierIsExplained } from "../src/review/risk.ts";
import { createRiskTool, RiskRequests } from "../src/review/tool.ts";

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
	path,
	status: "M",
	added: 1,
	deleted: 0,
	binary: false,
	mode: "100644",
	...over,
});

function candidate(files: ChangedFile[], over: Partial<Candidate> = {}): Candidate {
	return {
		root: "/repo",
		gitDir: "/repo/.git",
		base: "b".repeat(40),
		baseCommit: "a".repeat(40),
		tree: "c".repeat(40),
		files,
		changedLines: files.reduce((sum, item) => sum + item.added + item.deleted, 0),
		signalLines: [],
		manifests: [],
		fencedDocs: [],
		activeDocs: [],
		...over,
	};
}

describe("assessRisk", () => {
	it("an empty candidate has nothing to review", () => {
		const result = assessRisk(candidate([], { tree: "b".repeat(40) }));
		expect(result).toMatchObject({ empty: true, level: "passive", lenses: [], reviewDue: false, changedLines: 0 });
	});

	it("documentation only is passive, with no lenses", () => {
		const result = assessRisk(
			candidate([file("README.md"), file("docs/guide/setup.txt"), file("docs/notes"), file("docs/api.rst")]),
		);
		expect(result).toMatchObject({ level: "passive", lenses: [], reviewDue: false, empty: false });
		expect(result.reasons).toEqual(["documentation only"]);
	});

	it.each([
		["documentation with a code fence", candidate([file("README.md")], { fencedDocs: ["README.md"] })],
		["reStructuredText outside docs/", candidate([file("guide.rst")])],
		["an executable documentation file", candidate([file("docs/run.md", { mode: "100755" })])],
		["a binary file in docs", candidate([file("docs/logo.png", { binary: true })])],
		["a configuration file in docs", candidate([file("docs/config.json")])],
		[
			"a documentation file whose content is not proven inert",
			candidate([file("README.md")], { activeDocs: ["README.md"] }),
		],
		["documentation next to code", candidate([file("README.md"), file("src/a.ts")])],
	])("%s is not passive", (_name, input) => {
		expect(assessRisk(input).level).not.toBe("passive");
	});

	it("a documentation file that is not proven by content is medium, never passive, and says nothing high", () => {
		const result = assessRisk(candidate([file("README.md")], { activeDocs: ["README.md"] }), { none: "words" });
		expect(result).toMatchObject({ level: "medium", reviewDue: false });
	});

	it("ordinary code is medium with one lens, reliability by default", () => {
		const result = assessRisk(candidate([file("src/format.ts")]), { none: "nothing shares it" });
		expect(result).toMatchObject({ level: "medium", lenses: ["reliability"], reviewDue: false });
		expect(result.reasons).toEqual(["code change without a high-risk signal"]);
	});

	it("medium uses the lens the agent chose", () => {
		const result = assessRisk(candidate([file("src/format.ts")]), { lens: "readability" });
		expect(result.lenses).toEqual(["readability"]);
	});

	it.each([
		["src/auth/session.ts", "path: src/auth/session.ts (auth)"],
		["lib/Security.ts", "path: lib/Security.ts (security)"],
		["src/permissions.ts", "path: src/permissions.ts (permission)"],
		["api/payments/charge.ts", "path: api/payments/charge.ts (payment)"],
		["hooks/webhook.ts", "path: hooks/webhook.ts (webhook)"],
		["db/migrations/001.sql", "path: db/migrations/001.sql (migration)"],
		["config/secrets.ts", "path: config/secrets.ts (secret)"],
		["src/credentials.ts", "path: src/credentials.ts (credential)"],
		["pnpm-lock.yaml", "lockfile: pnpm-lock.yaml"],
		["sub/package-lock.json", "lockfile: sub/package-lock.json"],
		["Dockerfile", "environment: Dockerfile"],
		["docker/Dockerfile.dev", "environment: docker/Dockerfile.dev"],
		[".github/workflows/ci.yml", "environment: .github/workflows/ci.yml"],
	])("%s is high risk", (path, reason) => {
		const result = assessRisk(candidate([file(path)]));
		expect(result).toMatchObject({ level: "high", lenses: [...LENSES], reviewDue: true });
		expect(result.reasons).toContain(reason);
	});

	it("risky path words count in test files too", () => {
		const result = assessRisk(candidate([file("test/auth.test.ts")]), { none: "tests only" });
		expect(result.reasons).toEqual(["path: test/auth.test.ts (auth)"]);
	});

	const at = (path: string, text: string, line = 7) => candidate([file(path)], { signalLines: [{ path, text, line }] });

	it.each([
		['import { spawn } from "node:child_process";', "shell_process: src/run.ts:7"],
		["const out = execSync(command);", "shell_process: src/run.ts:7"],
		["exec(cmd, cb);", "shell_process: src/run.ts:7"],
		["const child = spawn(tool, args);", "shell_process: src/run.ts:7"],
		["execFileSync('git', ['init']);", "shell_process: src/run.ts:7"],
		["return eval(source);", "dangerous_sink: src/run.ts:7 (eval)"],
		["const f = new Function('a', body);", "dangerous_sink: src/run.ts:7 (Function constructor)"],
		['run("rm -rf build")', "dangerous_sink: src/run.ts:7 (rm -rf)"],
		["await db.query('drop table users')", "dangerous_sink: src/run.ts:7 (DROP TABLE)"],
		["DELETE FROM sessions WHERE 1=1", "dangerous_sink: src/run.ts:7 (DELETE FROM)"],
		["agent.options = { rejectUnauthorized: false };", "dangerous_sink: src/run.ts:7 (TLS JS)"],
	])("added content %s is high risk", (text, reason) => {
		const result = assessRisk(at("src/run.ts", text));
		expect(result.level).toBe("high");
		expect(result.reasons).toContain(reason);
	});

	it("a terminal mode change is not a process spawn, and neither is a member exec or a word that contains one", () => {
		for (const text of [
			"process.stdin.setRawMode(true);",
			"const m = /a(b)/.exec(line);",
			"await db.exec(sql);",
			"const again = respawn(child);",
			"const sink = evaluate(source);",
		]) {
			const result = assessRisk(at("src/term.ts", text), { none: "ui only" });
			expect(result, text).toMatchObject({ level: "medium", reviewDue: false });
			expect(result.reasons).toEqual(["code change without a high-risk signal"]);
		}
	});

	it.each([
		["src/run.ts", '// const cp = require("child_process");'],
		["src/run.ts", "   * exec(command) runs the thing"],
		["src/run.ts", "/* eval(source) */"],
		["tools/run.py", "# subprocess.run(cmd)"],
		["db/clean.sql", "-- DELETE FROM sessions"],
		["scripts/run.sh", "# rm -rf build"],
	])("%s: a comment that mentions a process or sink is ignored: %s", (path, text) => {
		const result = assessRisk(at(path, text), { none: "comment" });
		expect(result.level).toBe("medium");
	});

	it("only a comment in the file's own language is skipped, and code after a closed block comment counts", () => {
		expect(assessRisk(at("src/run.ts", "/* ok */ eval(source);"), { none: "x" }).level).toBe("high");
		expect(assessRisk(at("src/run.ts", "# eval(source)"), { none: "x" }).level).toBe("high");
		expect(assessRisk(at("tools/run.py", "// eval(source)"), { none: "x" }).level).toBe("high");
		expect(assessRisk(at("src/run.ts", "// note"), { none: "x" }).level).toBe("medium");
	});

	it("a sink counts only in the languages it applies to", () => {
		expect(assessRisk(at("tools/run.go", "return eval(source)"), { none: "x" }).level).toBe("medium");
		expect(assessRisk(at("tools/run.py", "return eval(source)"), { none: "x" }).level).toBe("high");
	});

	it("names one reason per file and kind, at the first line", () => {
		const input = candidate([file("src/run.ts")], {
			signalLines: [
				{ path: "src/run.ts", text: "spawn(a);", line: 3 },
				{ path: "src/run.ts", text: "eval(b);", line: 5 },
				{ path: "src/run.ts", text: "spawn(c);", line: 9 },
			],
		});
		expect(assessRisk(input, { none: "x" }).reasons).toEqual([
			"shell_process: src/run.ts:3",
			"dangerous_sink: src/run.ts:5 (eval)",
		]);
	});

	it("content in test files and documentation folders is not scanned, whatever it adds", () => {
		for (const path of ["test/run.test.ts", "src/__tests__/run.ts", "tools/test_run.py", "docs/example.ts"]) {
			const result = assessRisk(at(path, 'execFileSync("git", ["init"]);'), { none: "tests only" });
			expect(result.level, path).toBe("medium");
		}
	});

	it("content past the scan limit is high risk, naming where it was reached", () => {
		const result = assessRisk(candidate([file("src/big.ts")], { scanLimit: "src/big.ts" }), { none: "x" });
		expect(result).toMatchObject({ level: "high", reviewDue: true, lenses: [...LENSES] });
		expect(result.reasons).toContain("process_scan_limit: src/big.ts");
	});

	it("changed dependencies or install scripts in package.json are high risk; other fields are not", () => {
		const changed = (before: object, after: object) =>
			assessRisk(
				candidate([file("package.json")], {
					manifests: [{ path: "package.json", before: JSON.stringify(before), after: JSON.stringify(after) }],
				}),
			);
		expect(changed({ dependencies: { a: "1" } }, { dependencies: { a: "2" } }).reasons).toContain(
			"dependencies: package.json (dependencies)",
		);
		expect(changed({}, { devDependencies: { b: "1" } }).reasons).toContain(
			"dependencies: package.json (devDependencies)",
		);
		expect(changed({ scripts: {} }, { scripts: { postinstall: "x" } }).reasons).toContain(
			"dependencies: package.json (scripts.postinstall)",
		);
		expect(
			changed({ version: "1.0.0", scripts: { test: "a" } }, { version: "1.1.0", scripts: { test: "b" } }).level,
		).toBe("medium");
	});

	it("a package.json that does not parse is high risk", () => {
		const result = assessRisk(
			candidate([file("package.json")], { manifests: [{ path: "package.json", before: "{}", after: "{oops" }] }),
		);
		expect(result.reasons).toContain("dependencies: package.json (unreadable)");
	});

	it("size alone never changes the level", () => {
		const huge = assessRisk(candidate([file("src/a.ts", { added: 50_000, deleted: 20_000 })]));
		expect(huge.level).toBe("medium");
		expect(huge.changedLines).toBe(70_000);
		const tiny = assessRisk(candidate([file("src/auth.ts", { added: 1 })]));
		expect(tiny.level).toBe("high");
	});

	it("the agent's escalation raises to high and is reported; it never lowers", () => {
		const raised = assessRisk(candidate([file("src/format.ts")]), {
			escalations: [{ items: [6], reason: "no test covers the date math" }],
		});
		expect(raised).toMatchObject({ level: "high", lenses: [...LENSES], reviewDue: true });
		expect(raised.reasons).toContain("agent: item 6 (no test covers the date math)");

		const passive = assessRisk(candidate([file("README.md")]), { escalations: [{ items: [1, 3], reason: "format" }] });
		expect(passive.level).toBe("high");
		expect(passive.reasons).toContain("agent: items 1, 3 (format)");

		const high = assessRisk(candidate([file("src/auth.ts")]), { lens: "readability" });
		expect(high.lenses).toEqual([...LENSES]);
	});

	it("size and file count never raise the level, and the scan cap is the only content limit", () => {
		const many = Array.from({ length: 300 }, (_, i) => file(`src/m${i}.ts`, { added: 900, deleted: 100 }));
		expect(assessRisk(candidate(many), { none: "x" }).level).toBe("medium");
	});

	it("is deterministic: same candidate, same result", () => {
		const input = candidate([file("src/b.ts"), file("src/auth/a.ts")], {
			signalLines: [{ path: "src/b.ts", text: "eval(x)", line: 1 }],
		});
		expect(assessRisk(input)).toEqual(assessRisk(input));
		expect(assessRisk(input).files).toEqual(["src/auth/a.ts", "src/b.ts"]);
	});
});

describe("tierIsExplained", () => {
	const docs = [file("README.md")];
	it.each([
		["high with a named high reason", "high", ["shell_process: a.ts:1"], docs, true],
		["high with only the missing declaration", "high", ["no risk declaration"], docs, false],
		["high with no reasons", "high", [], docs, false],
		["passive documentation", "passive", ["documentation only"], docs, true],
		["passive with a code file", "passive", ["documentation only"], [file("src/a.ts")], false],
		["passive next to a high reason", "passive", ["documentation only", "path: docs/auth.md (auth)"], docs, false],
		["medium without a high reason", "medium", ["code change without a high-risk signal"], [file("src/a.ts")], true],
		["medium with a high reason", "medium", ["dangerous_sink: a.ts:1 (eval)"], [file("src/a.ts")], false],
	] as const)("%s", (_name, level, reasons, files, explained) => {
		expect(tierIsExplained(level, [...reasons], files)).toBe(explained);
	});
});

describe("risk tool", () => {
	const run = async (input: unknown, state = new RiskRequests()) => ({
		outcome: await createRiskTool(state).execute(input, { cwd: "/repo" }),
		state,
	});

	it("records an escalation with its items and reason", async () => {
		const { outcome, state } = await run({ items: [2, 4], reason: "touches the token check" });
		expect(outcome.ok).toBe(true);
		expect(outcome.output).toBe(
			"Risk raised to high: items 2, 4 (touches the token check). It applies until this change is reviewed or declined.",
		);
		expect(state.escalations).toEqual([{ items: [2, 4], reason: "touches the token check" }]);
	});

	it("limits item 1 to data that cannot be rebuilt, not new records or derived files", () => {
		const { description } = createRiskTool(new RiskRequests());
		expect(description).toContain(
			"1 stored data that cannot be rebuilt or irreversible effects (migrations, rewriting or deleting existing records; not saving new records, caches or generated files)",
		);
		expect(description).not.toContain("1 data or irreversible effects");
	});

	it("records a declaration of none with its reason", async () => {
		const { outcome, state } = await run({ none: true, reason: "no shared code" });
		expect(outcome.ok).toBe(true);
		expect(outcome.output).toBe(
			"Risk declared none (no shared code). It never lowers a risk Atelier finds, and applies until this change is reviewed or declined.",
		);
		expect(state.escalations).toEqual([]);
	});

	it("describes none in the tool description", () => {
		const { description } = createRiskTool(new RiskRequests());
		expect(description).toContain("none with a reason");
	});

	it("records the lens for medium risk", async () => {
		const { outcome, state } = await run({ lenses: ["resilience"] });
		expect(outcome.output).toBe("Lens for a medium-risk review: resilience.");
		expect(state.lens).toBe("resilience");
	});

	it.each([
		[{}, "Give items with a reason, none with a reason, or a lens for a medium-risk review."],
		[{ items: [1] }, "A reason is required with items."],
		[{ none: true }, "A reason is required with none."],
		[{ none: true, reason: "  " }, "A reason is required with none."],
		[{ none: true, items: [1], reason: "x" }, "Give items or none, not both."],
		[{ none: true, reason: "x".repeat(501) }, "The reason is 501 bytes; the limit is 500."],
		[{ reason: "why" }, "Give items with a reason, none with a reason, or a lens for a medium-risk review."],
		[{ items: [1], reason: "x".repeat(501) }, "The reason is 501 bytes; the limit is 500."],
		[{ items: [1], reason: "ñ".repeat(251) }, "The reason is 502 bytes; the limit is 500."],
	])("rejects %j and records nothing", async (input, message) => {
		const { outcome, state } = await run(input);
		expect(outcome).toMatchObject({ ok: false, output: message });
		expect(state.escalations).toEqual([]);
		expect(state.lens).toBeUndefined();
	});

	it("rejects items outside 1-6 and more than one lens through input validation", async () => {
		await expect(run({ lenses: ["risk", "resilience"] })).rejects.toThrow();
		await expect(run({ items: [7], reason: "x" })).rejects.toThrow();
		await expect(run({ items: [], reason: "x" })).rejects.toThrow();
	});

	it("clear forgets escalations and the lens", async () => {
		const state = new RiskRequests();
		await run({ items: [1], reason: "x", lenses: ["risk"] }, state);
		state.clear();
		expect(state.escalations).toEqual([]);
		expect(state.lens).toBeUndefined();
		expect(state.lensReason).toBeUndefined();
	});
});
