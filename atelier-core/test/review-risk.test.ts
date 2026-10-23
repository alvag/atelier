import { describe, expect, it } from "vitest";
import type { Candidate, ChangedFile } from "../src/review/candidate.ts";
import { assessRisk, LENSES } from "../src/review/risk.ts";
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
		tree: "c".repeat(40),
		files,
		changedLines: files.reduce((sum, item) => sum + item.added + item.deleted, 0),
		signalLines: [],
		manifests: [],
		fencedDocs: [],
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
		["documentation next to code", candidate([file("README.md"), file("src/a.ts")])],
	])("%s is not passive", (_name, input) => {
		expect(assessRisk(input).level).not.toBe("passive");
	});

	it("ordinary code is medium with one lens, reliability by default", () => {
		const result = assessRisk(candidate([file("src/format.ts")]));
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
		const result = assessRisk(candidate([file("test/auth.test.ts")]));
		expect(result.reasons).toEqual(["path: test/auth.test.ts (auth)"]);
	});

	it.each([
		['import { spawn } from "node:child_process";', "child_process"],
		["const out = execSync(command);", "exec"],
		["exec(cmd, cb);", "exec"],
		["return eval(source);", "eval"],
		['run("rm -rf build")', "rm -rf"],
		["await db.query('drop table users')", "DROP TABLE"],
		["DELETE FROM sessions WHERE 1=1", "DELETE FROM"],
	])("added content %s is high risk", (text, signal) => {
		const result = assessRisk(candidate([file("src/run.ts")], { signalLines: [{ path: "src/run.ts", text }] }));
		expect(result.level).toBe("high");
		expect(result.reasons).toContain(`content: src/run.ts adds ${signal}`);
	});

	it("risky content counts in test files too", () => {
		const result = assessRisk(
			candidate([file("test/run.test.ts")], {
				signalLines: [{ path: "test/run.test.ts", text: 'execFileSync("git", ["init"]);' }],
			}),
		);
		expect(result.reasons).toEqual(["content: test/run.test.ts adds exec"]);
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

	it("is deterministic: same candidate, same result", () => {
		const input = candidate([file("src/b.ts"), file("src/auth/a.ts")], {
			signalLines: [{ path: "src/b.ts", text: "eval(x)" }],
		});
		expect(assessRisk(input)).toEqual(assessRisk(input));
		expect(assessRisk(input).files).toEqual(["src/auth/a.ts", "src/b.ts"]);
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

	it("records the lens for medium risk", async () => {
		const { outcome, state } = await run({ lenses: ["resilience"] });
		expect(outcome.output).toBe("Lens for a medium-risk review: resilience.");
		expect(state.lens).toBe("resilience");
	});

	it.each([
		[{}, "Give items with a reason to raise the risk, or a lens for a medium-risk review."],
		[{ items: [1] }, "A reason is required with items."],
		[{ reason: "why" }, "Give items with a reason to raise the risk, or a lens for a medium-risk review."],
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
