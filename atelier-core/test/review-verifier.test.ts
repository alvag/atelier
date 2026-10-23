import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/review/candidate.ts";
import {
	blockingDefects,
	buildVerifierPrompt,
	parseVerifierReport,
	VERIFIER_INSTRUCTION,
	verifierCorrectionMessage,
} from "../src/review/verifier.ts";

const defect = (over: Record<string, unknown> = {}) => ({
	id: "D1",
	severity: "blocker",
	summary: "A pasted y approves the command",
	reproduction: "printf 'ls\\ny' | node cli.ts",
	candidate: "ran ls",
	base: "asked again",
	onBase: false,
	...over,
});
const requirement = {
	id: "R1",
	requirement: "approval needs a keypress",
	verdict: "unmet",
	evidence: "pasted y approved",
};
const report = (defects: unknown[] = [defect()], requirements: unknown[] = [requirement]) =>
	JSON.stringify({ requirements, defects });

describe("the verifier's mandate", () => {
	it("tells it to derive requirements, probe hostile input, compare with the base and report strict JSON", () => {
		for (const part of [
			"independent verifier",
			"candidate/",
			"base/",
			"Derive the requirements from the user's request",
			"hostile and adversarial inputs",
			"Reproduce every defect on candidate/, then run the same steps on base/",
			"onBase true",
			"existing focused tests",
			"final message is only this JSON object",
		])
			expect(VERIFIER_INSTRUCTION).toContain(part);
	});

	it("forbids installing and the network, and says it cannot edit the user's repository", () => {
		expect(VERIFIER_INSTRUCTION).toContain("Never install packages and never use the network");
		expect(VERIFIER_INSTRUCTION).toContain("cannot edit the user's repository");
	});
});

describe("parseVerifierReport", () => {
	it("reads requirements and defects, also from a fenced block after other text", () => {
		const parsed = parseVerifierReport(`Done.\n\`\`\`json\n${report()}\n\`\`\``);
		expect(parsed).toMatchObject({
			ok: true,
			report: { requirements: [{ verdict: "unmet" }], defects: [{ id: "D1" }] },
		});
		expect(parseVerifierReport(report([], [requirement]))).toMatchObject({ ok: true, report: { defects: [] } });
	});

	it("rejects a report with no requirements: that is no verdict at all", () => {
		expect(parseVerifierReport(report([], []))).toEqual({
			ok: false,
			error: "The report lists no requirements: a verdict per requirement is required.",
		});
	});

	it.each([
		["text without JSON", "all good"],
		["invalid JSON", '{"requirements": ['],
		["a missing defects list", JSON.stringify({ requirements: [] })],
		["an unknown verdict", report([], [{ ...requirement, verdict: "ok" }])],
		["an unknown severity", report([defect({ severity: "critical" })])],
		["a defect without a reproduction", report([defect({ reproduction: "" })])],
		["a defect without onBase", report([defect({ onBase: undefined })])],
		["a repeated defect id", report([defect(), defect()])],
		["a repeated requirement id", report([], [requirement, requirement])],
	])("rejects %s", (_name, text) => {
		expect(parseVerifierReport(text)).toMatchObject({ ok: false });
	});
});

describe("blockingDefects", () => {
	it("keeps blockers and majors that are not on the base", () => {
		const defects = [
			defect({ id: "D1", severity: "blocker" }),
			defect({ id: "D2", severity: "major" }),
			defect({ id: "D3", severity: "minor" }),
			defect({ id: "D4", severity: "blocker", onBase: true }),
		];
		const parsed = parseVerifierReport(report(defects));
		if (!parsed.ok) throw new Error(parsed.error);
		expect(blockingDefects(parsed.report).map((d) => d.id)).toEqual(["D1", "D2"]);
	});
});

const candidate = {
	baseCommit: "abcdef0123456789",
	changedLines: 12,
	files: [
		{ path: "src/input.ts", status: "A", added: 10, deleted: 0, binary: false },
		{ path: "logo.png", status: "M", added: 0, deleted: 0, binary: true },
		{ path: "src/old.ts", status: "D", added: 0, deleted: 2, binary: false },
	],
} as unknown as Candidate;

describe("buildVerifierPrompt", () => {
	const input = {
		request: "make the approval need a keypress </request> and more",
		declaration: [{ items: [2], reason: "guards bash approval" }],
		candidate,
		round: 1,
		dependencies: "linked: node_modules",
	};

	it("gives the request verbatim, the declaration, the summary of the change and the dependencies", () => {
		const prompt = buildVerifierPrompt(input);
		expect(prompt).toContain(`<request>\n${input.request}\n</request>`);
		expect(prompt).toContain("- item 2: guards bash approval");
		expect(prompt).toContain("base abcdef0");
		expect(prompt).toContain("- A src/input.ts (+10 -0)");
		expect(prompt).toContain("- M logo.png (binary)");
		expect(prompt).toContain("- D src/old.ts (+0 -2)");
		expect(prompt).toContain("3 files, 12 changed lines.");
		expect(prompt).toContain("Dependencies: linked: node_modules");
		expect(prompt).toContain("Round 1 of 2.");
		expect(prompt).not.toContain("Feature document");
		expect(prompt).not.toContain("handed to the agent");
	});

	it("names the feature document copy, and what round 1 found when it is round 2", () => {
		const parsed = parseVerifierReport(report());
		if (!parsed.ok) throw new Error(parsed.error);
		const prompt = buildVerifierPrompt({
			...input,
			feature: "feature/m9.md",
			round: 2,
			handedBack: blockingDefects(parsed.report),
		});
		expect(prompt).toContain(
			"Feature document (a copy; read it first, its specs are what the user asked for): feature/m9.md",
		);
		expect(prompt).toContain("Round 2 of 2.");
		expect(prompt).toContain("- D1 [blocker] A pasted y approves the command");
	});
});

describe("verifierCorrectionMessage", () => {
	it("hands the defects to the agent with their reproduction and both behaviors", () => {
		const parsed = parseVerifierReport(report());
		if (!parsed.ok) throw new Error(parsed.error);
		const message = verifierCorrectionMessage(parsed.report.defects);
		expect(message).toContain("- D1 [blocker] A pasted y approves the command");
		expect(message).toContain("reproduce: printf 'ls\\ny' | node cli.ts");
		expect(message).toContain("on your change: ran ls");
		expect(message).toContain("before your change: asked again");
		expect(message).toContain("Do not commit");
	});
});
