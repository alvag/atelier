import type { AtelierEvent, AtelierEventBody, VerifyDefect, VerifyRequirement } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/conversation.ts";
import { painter } from "../src/tui/style.ts";
import { type VerifyState, verifyAfter, verifyCardLines } from "../src/tui/verify-card.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);
const text = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");
const after = (bodies: Body[]) => stamp(bodies).reduce(verifyAfter, { verifyId: "v1", rounds: [] } as VerifyState);
const lines = (state: VerifyState, expanded: boolean, width = 120) => {
	const { head, rest } = verifyCardLines(state, expanded, width, plain);
	return [...head, ...rest];
};

const started: Body = {
	type: "verification_started",
	verifyId: "v1",
	items: [2, 6],
	declaration: [{ items: [2, 6], reason: "touches the sandbox" }],
};
const requirements: VerifyRequirement[] = [
	{ id: "S1", requirement: "Parses --mode", verdict: "met", evidence: "the test passes" },
	{ id: "S2", requirement: "Rejects yolo", verdict: "unmet", evidence: "yolo was accepted" },
	{ id: "S3", requirement: "Documents it", verdict: "unverified", evidence: "no README change" },
];
const defect: VerifyDefect = {
	id: "D1",
	severity: "major",
	summary: "yolo accepted",
	reproduction: "atelier --mode yolo",
	candidate: "accepted",
	base: "refused",
	onBase: false,
};
const round = (more: Partial<Extract<Body, { type: "verification_round" }>> = {}): Body => ({
	type: "verification_round",
	verifyId: "v1",
	round: 1,
	ok: true,
	requirements,
	defects: [defect],
	blocking: ["D1"],
	correcting: true,
	usage,
	...more,
});
const finished = (more: Partial<Extract<Body, { type: "verification_finished" }>> = {}): Body => ({
	type: "verification_finished",
	verifyId: "v1",
	outcome: "corrected",
	rounds: 2,
	openDefects: [],
	usage,
	costUsd: 0.01,
	...more,
});

describe("verify state", () => {
	it("takes the start, each round and the end of its own verification", () => {
		const state = after([started, round(), round({ round: 2, defects: [], correcting: false }), finished()]);
		expect(state.started?.items).toEqual([2, 6]);
		expect(state.rounds.map((each) => each.round)).toEqual([1, 2]);
		expect(state.finished?.outcome).toBe("corrected");
	});

	it("ignores another verification's events, a subagent's and the rest", () => {
		const state = after([started]);
		const ignored = stamp([
			round({ verifyId: "v2" }),
			{ ...round(), parentCallId: "v1", agent: "verify:verifier" },
			{ type: "phase_changed", phase: "checking", source: "inferred" },
		]);
		expect(ignored.reduce(verifyAfter, state)).toBe(state);
	});
});

describe("verify card", () => {
	it("folded, lists each requirement's verdict and each defect, without evidence or reproduction", () => {
		const shown = text(lines(after([started, round()]), false));
		expect(shown).toBe(
			[
				" ▸ verify · items 2, 6 · round 2…",
				"   round 1 · 1 defect (major) · 1 met, 1 unmet, 1 unverified · asking the agent to fix them",
				"     ✓ S1 met · Parses --mode",
				"     ✗ S2 unmet · Rejects yolo",
				"     ? S3 unverified · Documents it",
				"     D1 major · yolo accepted",
			].join("\n"),
		);
	});

	it("unfolded, adds the declaration, every requirement's evidence and every defect's reproduction", () => {
		const shown = text(lines(after([started, round({ defects: [{ ...defect, onBase: true }] })]), true));
		expect(shown).toBe(
			[
				" ▾ verify · items 2, 6 · round 2…",
				"   declared items 2, 6: touches the sandbox",
				"   round 1 · 1 defect (major), 1 also on the base · 1 met, 1 unmet, 1 unverified · asking the agent to fix them",
				"     ✓ S1 met · Parses --mode",
				"       evidence: the test passes",
				"     ✗ S2 unmet · Rejects yolo",
				"       evidence: yolo was accepted",
				"     ? S3 unverified · Documents it",
				"       evidence: no README change",
				"     D1 major · yolo accepted (also on the base)",
				"       reproduce: atelier --mode yolo",
			].join("\n"),
		);
	});

	it("says a failed round and how the verification ended, with the open defects to decide on", () => {
		const shown = text(
			lines(
				after([
					started,
					round({ ok: false, error: "bad report", cause: "invalid_report", requirements: [], defects: [] }),
					finished({ outcome: "needs_decision", openDefects: [defect], costUsd: 0.02 }),
				]),
				true,
			),
		);
		expect(shown).toContain(" ▾ verify · items 2, 6\n");
		expect(shown).toContain("   round 1 · failed:");
		expect(shown).toContain(" ✗ verify: needs your decision · 1 open defect");
		expect(shown).toContain("   D1 major · yolo accepted\n     reproduce: atelier --mode yolo");
	});

	it("folded, opens what a needs_decision leaves to decide: the open defects and the last round's requirements not met", () => {
		const earlier = requirements.map((entry) => ({ ...entry, evidence: `earlier: ${entry.evidence}` }));
		const state = after([
			started,
			round({ requirements: earlier }),
			round({ round: 2, correcting: false }),
			finished({ outcome: "needs_decision", openDefects: [defect] }),
		]);
		const shown = text(lines(state, false));
		expect(shown).toContain("     ✗ S2 unmet · Rejects yolo\n       evidence: yolo was accepted");
		expect(shown).toContain("     ? S3 unverified · Documents it\n       evidence: no README change");
		expect(shown).toContain(
			" ✗ verify: needs your decision · 1 open defect\n   D1 major · yolo accepted\n     reproduce: atelier --mode yolo",
		);
		// The rest stays folded: what was met, the earlier round and the defects of the rounds.
		expect(shown).not.toContain("the test passes");
		expect(shown).not.toContain("earlier:");
		expect(shown.match(/reproduce:/g)).toHaveLength(1);
		expect(shown).toMatch(/^ ▸ verify/);
	});

	it("keeps a verification that passed or failed folded", () => {
		for (const outcome of ["passed", "corrected", "failed"] as const) {
			const shown = text(lines(after([started, round(), finished({ outcome, openDefects: [defect] })]), false));
			expect(shown).not.toContain("evidence:");
			expect(shown).not.toContain("reproduce:");
		}
	});

	it("says a passed and a corrected verification", () => {
		expect(text(lines(after([started, finished({ outcome: "passed", rounds: 1 })]), false))).toContain(
			" ✓ verify passed",
		);
		expect(text(lines(after([started, finished()]), false))).toContain(
			" ✓ verify passed after a correction · 2 rounds",
		);
	});

	it("wraps every line to a narrow terminal", () => {
		const state = after([started, round(), finished({ outcome: "needs_decision", openDefects: [defect] })]);
		for (const width of [4, 12, 30])
			for (const expanded of [false, true])
				for (const line of lines(state, expanded, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("shows control characters in the verifier's strings as markers", () => {
		const esc = "x\u001b[31my";
		const hostile: VerifyDefect = { ...defect, id: esc, summary: esc, reproduction: esc };
		const state = after([
			{ ...started, declaration: [{ items: [2], reason: esc }] },
			round({ requirements: [{ id: esc, requirement: esc, verdict: "unmet", evidence: esc }], defects: [hostile] }),
			finished({ outcome: "needs_decision", reason: esc, openDefects: [hostile] }),
		]);
		const shown = text(lines(state, true));
		expect(shown).toContain("x␛[31my");
		expect(shown).not.toContain("\u001b");
	});
});

describe("verification in the conversation", () => {
	it("is one card that grows with its rounds, the verifier's work under its head, folded with the tool cards", () => {
		const conversation = new Conversation(plain, "/repo");
		for (const event of stamp([
			started,
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-sonnet-5-5",
				authSource: "subscription",
				parentCallId: "v1",
				agent: "verify:verifier",
			},
			round(),
			finished(),
		]))
			conversation.event(event);
		const folded = text(conversation.render(120));
		expect(folded.match(/verify · items 2, 6/g)).toHaveLength(1);
		const order = ["▸ verify · items 2, 6", "└ verify:verifier", "round 1 ·", "✗ S2 unmet", "✓ verify passed after"];
		const at = order.map((part) => folded.indexOf(part));
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(folded).not.toContain("evidence:");
		conversation.toggleCards();
		expect(text(conversation.render(120))).toContain("evidence: yolo was accepted");
	});
});
