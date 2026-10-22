import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/review/candidate.ts";
import { freezeCandidate } from "../src/review/candidate.ts";
import { type Finding, isBlocking, parseFindings } from "../src/review/findings.ts";
import { buildLensPrompt, LENS_CONTEXT_LIMIT_BYTES, LENS_INSTRUCTIONS, readPatch } from "../src/review/lenses.ts";
import { LENSES } from "../src/review/risk.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
	id: "x",
	lens: "risk",
	severity: "major",
	cause: "candidate",
	path: "src/a.ts",
	line: 3,
	claim: "Drops the token.",
	evidence: "src/a.ts:3",
	...over,
});
const asJson = (findings: unknown[]) => JSON.stringify({ findings });

describe("parseFindings", () => {
	it("reads a fenced json block, even after prose", () => {
		const text = `Here is my review.\n\n\`\`\`json\n${asJson([finding()])}\n\`\`\`\n`;
		const result = parseFindings(text);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.findings).toHaveLength(1);
	});

	it("reads a bare object and an empty list", () => {
		expect(parseFindings(asJson([finding()])).ok).toBe(true);
		expect(parseFindings(`  ${asJson([])}\n`)).toEqual({ ok: true, findings: [] });
	});

	it("rejects text that is not json", () => {
		expect(parseFindings("All good!")).toMatchObject({ ok: false, error: expect.stringContaining("JSON") });
		expect(parseFindings("{ not json }")).toMatchObject({ ok: false });
	});

	it("rejects the wrong shape, missing fields and wrong enums", () => {
		expect(parseFindings(JSON.stringify([finding()])).ok).toBe(false);
		expect(parseFindings(JSON.stringify({ items: [] })).ok).toBe(false);
		const { claim: _claim, ...noClaim } = finding();
		const missing = parseFindings(asJson([noClaim]));
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("claim");
		expect(parseFindings(asJson([finding({ severity: "huge" as never })])).ok).toBe(false);
		expect(parseFindings(asJson([finding({ cause: "me" as never })])).ok).toBe(false);
		expect(parseFindings(asJson([finding({ lens: "style" as never })])).ok).toBe(false);
		expect(parseFindings(asJson([finding({ line: 0 })])).ok).toBe(false);
	});

	it("accepts a finding without a line", () => {
		const { line: _line, ...noLine } = finding();
		expect(parseFindings(asJson([noLine])).ok).toBe(true);
	});

	it("gives every finding a unique id built from its lens", () => {
		const result = parseFindings(
			asJson([finding({ id: "dup" }), finding({ id: "dup" }), finding({ lens: "readability", id: "dup" })]),
		);
		if (!result.ok) throw new Error(result.error);
		const ids = result.findings.map((f) => f.id);
		expect(ids).toEqual(["RK-001", "RK-002", "RD-001"]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("pins the lens that ran when it is given", () => {
		const result = parseFindings(asJson([finding({ lens: "risk" })]), "reliability");
		if (!result.ok) throw new Error(result.error);
		expect(result.findings[0]).toMatchObject({ lens: "reliability", id: "RL-001" });
	});
});

describe("isBlocking", () => {
	const table: [Finding["severity"], Finding["cause"], boolean][] = [
		["blocker", "candidate", true],
		["critical", "candidate", true],
		["major", "candidate", false],
		["minor", "candidate", false],
		["blocker", "pre-existing", false],
		["critical", "pre-existing", false],
		["blocker", "unknown", false],
		["critical", "unknown", false],
	];
	it.each(table)("%s + %s -> %s", (severity, cause, expected) => {
		expect(isBlocking(finding({ severity, cause }))).toBe(expected);
	});
});

describe("lens instructions", () => {
	it.each(LENSES)("%s has a short, read-only instruction", (lens) => {
		const text = LENS_INSTRUCTIONS[lens];
		expect(text.length).toBeGreaterThan(200);
		expect(text.length).toBeLessThanOrEqual(1200);
		expect(text).toContain("read-only");
		expect(text).toContain("pre-existing");
		expect(text).toContain('"findings"');
	});

	it("differ in concern", () => {
		expect(new Set(LENSES.map((lens) => LENS_INSTRUCTIONS[lens])).size).toBe(LENSES.length);
	});
});

const fakeCandidate = (): Candidate => ({
	root: "/r",
	gitDir: "/r/.git",
	base: "b",
	tree: "t",
	files: [
		{ path: "src/a.ts", status: "M", added: 3, deleted: 1, binary: false, mode: "100644" },
		{ path: "logo.png", status: "A", added: 0, deleted: 0, binary: true, mode: "100644" },
	],
	changedLines: 4,
	addedLines: [],
	manifests: [],
	scanTruncated: false,
});

describe("buildLensPrompt", () => {
	it("holds the reasons, the file list and the whole patch", () => {
		const patch = "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n";
		const result = buildLensPrompt({
			candidate: fakeCandidate(),
			lens: "risk",
			patch,
			reasons: ["path: src/auth/session.ts"],
		});
		if (!result.ok) throw new Error(result.code);
		expect(result.instruction).toBe(LENS_INSTRUCTIONS.risk);
		expect(result.prompt).toContain("path: src/auth/session.ts");
		expect(result.prompt).toContain("src/a.ts (M, +3 -1)");
		expect(result.prompt).toContain("logo.png (A, binary)");
		expect(result.prompt).toContain(patch);
		expect(result.bytes).toBe(Buffer.byteLength(result.instruction) + Buffer.byteLength(result.prompt));
	});

	it("rejects a prompt over the budget and never truncates", () => {
		const patch = "x".repeat(LENS_CONTEXT_LIMIT_BYTES);
		const result = buildLensPrompt({ candidate: fakeCandidate(), lens: "reliability", patch, reasons: [] });
		expect(result).toMatchObject({ ok: false, code: "lens_context_budget_exceeded", limit: LENS_CONTEXT_LIMIT_BYTES });
		if (!result.ok) expect(result.bytes).toBeGreaterThan(LENS_CONTEXT_LIMIT_BYTES);
	});

	it("counts the instruction toward the budget", () => {
		const probe = buildLensPrompt({ candidate: fakeCandidate(), lens: "risk", patch: "", reasons: [] });
		if (!probe.ok) throw new Error(probe.code);
		const room = LENS_CONTEXT_LIMIT_BYTES - probe.bytes;
		const fits = buildLensPrompt({ candidate: fakeCandidate(), lens: "risk", patch: "y".repeat(room), reasons: [] });
		const over = buildLensPrompt({
			candidate: fakeCandidate(),
			lens: "risk",
			patch: "y".repeat(room + 1),
			reasons: [],
		});
		expect(fits.ok).toBe(true);
		expect(over.ok).toBe(false);
	});
});

describe("readPatch", () => {
	it("returns the full patch between the frozen trees, and rejects one over the budget", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atelier-patch-"));
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
			git("init", "-q");
			await writeFile(join(dir, "a.txt"), "one\n");
			git("add", "-A");
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
			await writeFile(join(dir, "a.txt"), "one\ntwo\n");
			const frozen = await freezeCandidate(dir);
			if (!frozen.ok) throw new Error(frozen.reason);
			const small = await readPatch(frozen.candidate);
			if (!small.ok) throw new Error(small.code);
			expect(small.patch).toContain("+two");

			await mkdir(join(dir, "big"));
			await writeFile(join(dir, "big/huge.txt"), "z".repeat(LENS_CONTEXT_LIMIT_BYTES + 10));
			const big = await freezeCandidate(dir);
			if (!big.ok) throw new Error(big.reason);
			expect(await readPatch(big.candidate)).toMatchObject({
				ok: false,
				code: "lens_context_budget_exceeded",
				limit: LENS_CONTEXT_LIMIT_BYTES,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
