import type { AtelierEvent, AtelierEventBody, ReviewStep } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/conversation.ts";
import { type ReviewState, reviewAfter, reviewBlockLines } from "../src/tui/review-block.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);
const text = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");
const after = (bodies: Body[], state: ReviewState = { steps: [] }) => stamp(bodies).reduce(reviewAfter, state);
const lines = (state: ReviewState, width = 120) => {
	const { head, result } = reviewBlockLines(state, width, plain, "/repo");
	return [...head, ...result];
};

const assessed: Body = {
	type: "review_assessed",
	tree: "abc",
	level: "high",
	reasons: ["touches the sandbox", "no test"],
	files: ["a.ts", "b.ts"],
	changedLines: 12,
	lenses: ["risk", "reliability"],
	lensesReason: "guards and logic",
	reviewDue: true,
	declaration: { kind: "items", items: [{ items: [2], reason: "sandbox" }] },
	since: "1234567",
};
/** The assessment with nothing optional said. */
const {
	lensesReason: _why,
	declaration: _declared,
	since: _since,
	...bare
} = assessed as Extract<Body, { type: "review_assessed" }>;
const progress = (step: ReviewStep): Body => ({ type: "review_progress", reviewId: "r1", step });
const finished = (more: Partial<Extract<Body, { type: "review_finished" }>>): Body => ({
	type: "review_finished",
	reviewId: "r1",
	verdict: "approved",
	findings: [],
	refuted: [],
	followUps: [],
	correction: null,
	usage,
	...more,
});
const finding = {
	id: "F1",
	lens: "risk",
	severity: "blocker",
	cause: "c",
	path: "src/a.ts",
	line: 3,
	claim: "the guard is skipped",
	evidence: "e",
};

const { line: _line, ...lineless } = finding;

describe("review state", () => {
	it("takes the assessment, the question, each step and the result of the main agent's review", () => {
		const state = after([
			assessed,
			{ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: [], lenses: [] },
			progress({ type: "lens_started", lens: "risk" }),
			progress({ type: "lens_finished", lens: "risk", ok: true, findings: 1 }),
			finished({ verdict: "escalated" }),
		]);
		expect(state.reviewId).toBe("r1");
		expect(state.assessed?.level).toBe("high");
		expect(state.consentAsked).toBe(true);
		expect(state.steps.map((step) => step.type)).toEqual(["lens_started", "lens_finished"]);
		expect(state.finished?.verdict).toBe("escalated");
	});

	it("ignores a subagent's events and the rest", () => {
		const state = after([assessed]);
		expect(after([{ ...progress({ type: "refuter_started", findings: 1 }), parentCallId: "c1" }], state)).toBe(state);
		expect(after([{ type: "phase_changed", phase: "checking", source: "inferred" }], state)).toBe(state);
	});
});

describe("review block", () => {
	it("says the risk, why, the lenses and the base while it waits for an answer", () => {
		const state = after([
			assessed,
			{ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: [], lenses: [] },
		]);
		expect(text(lines(state))).toBe(
			[
				" ◇ review high · 12 lines in 2 files · lenses risk, reliability",
				"   why: touches the sandbox; no test",
				"   lenses chosen: guards and logic",
				"   declared items 2: sandbox",
				"   since 1234567",
				"   waiting for your answer",
			].join("\n"),
		);
	});

	it("lists every step, then the result with the follow-ups, the cost and the receipt", () => {
		const state = after([
			{ ...bare, reasons: [], declaration: { kind: "none", reason: "docs only" }, since: "1234567" },
			progress({ type: "lens_started", lens: "risk" }),
			progress({ type: "lens_finished", lens: "risk", ok: true, findings: 2 }),
			progress({ type: "refuter_started", findings: 2 }),
			progress({ type: "refuter_finished", confirmed: 0, refuted: 2 }),
			finished({
				followUps: [{ ...finding, id: "F2" }],
				costUsd: 0.0123,
				receiptPath: "/repo/.atelier/receipts/r1.json",
			}),
		]);
		expect(text(lines(state))).toBe(
			[
				" ◇ review high · 12 lines in 2 files · lenses risk, reliability",
				"   declared none: docs only",
				"   since 1234567",
				"   · lens risk",
				"   · lens risk done · 2 findings",
				"   · refuting 2 findings",
				"   · 0 confirmed · 2 refuted",
				" ✓ review approved · 1 follow-up · $0.0123",
				"   receipt .atelier/receipts/r1.json",
			].join("\n"),
		);
	});

	it("lists the blocking findings of an escalated review and says the correction is left", () => {
		const state = after([
			progress({ type: "correction_started", budget: 10, findings: 1 }),
			finished({
				verdict: "escalated",
				cause: "over_budget",
				findings: [finding, { ...lineless, id: "F3", path: "b.ts" }],
				correction: { budget: 10, used: 14 },
			}),
		]);
		const shown = text(lines(state));
		expect(shown).toContain(" ◇ review\n");
		expect(shown).toContain("✗ review escalated:");
		expect(shown).toContain("the correction is left in your worktree, review it before committing · 0 follow-ups");
		expect(shown).toContain("   F1 blocker src/a.ts:3 — the guard is skipped");
		expect(shown).toContain("   F3 blocker b.ts — the guard is skipped");
	});

	it("says a review not due, a declined one and an unavailable one", () => {
		expect(text(lines(after([{ ...bare, reviewDue: false, reasons: [] }])))).toBe(
			" ◇ review high · 12 lines in 2 files · lenses risk, reliability · no review due",
		);
		expect(text(lines(after([finished({ verdict: "declined" })])))).toContain(" ◇ review declined");
		expect(text(lines(after([finished({ verdict: "unavailable", cause: "role_failed" })])))).toContain(
			" ◇ review unavailable:",
		);
	});

	it("wraps every line to a narrow terminal", () => {
		const state = after([
			assessed,
			progress({ type: "lens_finished", lens: "reliability", ok: false, findings: 0 }),
			finished({ verdict: "escalated", findings: [finding], receiptPath: "/elsewhere/receipt.json" }),
		]);
		for (const width of [4, 12, 30])
			for (const line of lines(state, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(text(lines(state, 30))).toContain("guard");
	});

	it("shows control characters in the review's strings as markers", () => {
		const esc = "x\u001b[31my";
		const state = after([
			{ ...assessed, reasons: [esc], lenses: [esc], lensesReason: esc, since: esc, baseNote: esc },
			progress({ type: "lens_started", lens: esc }),
			finished({
				verdict: "escalated",
				reason: esc,
				findings: [{ ...finding, path: esc, claim: esc }],
				receiptPath: esc,
			}),
		]);
		const shown = text(lines(state));
		expect(shown).toContain("x␛[31my");
		expect(shown).not.toContain("\u001b");
	});
});

describe("review in the conversation", () => {
	it("is one block that grows with the review, with its roles under it", () => {
		const conversation = new Conversation(plain, "/repo");
		for (const event of stamp([
			assessed,
			{ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: [], lenses: [] },
			progress({ type: "lens_started", lens: "risk" }),
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-sonnet-5-5",
				authSource: "subscription",
				parentCallId: "r1",
				agent: "review:risk",
			},
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.01, parentCallId: "r1", agent: "review:risk" },
			progress({ type: "lens_finished", lens: "risk", ok: true, findings: 0 }),
			finished({ receiptPath: "/repo/r.json" }),
		]))
			conversation.event(event);
		const shown = text(conversation.render(120));
		expect(shown.match(/◇ review high/g)).toHaveLength(1);
		const order = [
			"waiting for your answer",
			"· lens risk",
			"· lens risk done",
			"└ review:risk",
			"✓ review approved",
			"receipt r.json",
		];
		// Once steps arrive, the block stops waiting.
		expect(shown).not.toContain(order[0]);
		const at = order.slice(1).map((part) => shown.indexOf(part));
		expect(at.every((index) => index >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});
});
