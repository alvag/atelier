import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/conversation.ts";
import { FeaturePanel, WorkStatus } from "../src/tui/odd.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);
const text = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");

const feature: Body = {
	type: "feature_changed",
	name: "m14-tui",
	path: "odd/tasks/m14-tui.md",
	title: "M14 – TUI",
	tasks: [
		{ id: "T1", title: "Hot model", specs: ["S2"], status: "done", commit: "34e37d5" },
		{ id: "T2", title: "Hot profile", specs: ["S3"], status: "in_progress" },
		{ id: "T3", title: "Hot backend", specs: ["S4"], status: "blocked" },
		{ id: "T4", title: "Sessions", specs: ["S5"], status: "dropped" },
		{ id: "T5", title: "TUI base", specs: ["S6"] },
	],
};

describe("FeaturePanel", () => {
	it("says nothing until a feature is active, then one line with the task in progress", () => {
		const panel = new FeaturePanel(plain);
		expect(panel.render(80)).toEqual([]);
		for (const event of stamp([feature])) panel.event(event);
		expect(text(panel.render(80))).toBe(" ◆ M14 – TUI · 1/5 done · now T2 Hot profile · Ctrl+T tasks");
	});

	it("lists every task with its state when unfolded", () => {
		const panel = new FeaturePanel(plain);
		for (const event of stamp([feature])) panel.event(event);
		panel.toggle();
		expect(text(panel.render(80))).toBe(
			[
				" ◆ M14 – TUI · 1/5 done · now T2 Hot profile · odd/tasks/m14-tui.md",
				"   ✓ T1 Hot model · 34e37d5",
				"   ▸ T2 Hot profile",
				"   ! T3 Hot backend · blocked",
				"   ~ T4 Sessions · dropped",
				"   · T5 TUI base",
			].join("\n"),
		);
	});

	it("ignores a subagent's feature and shows control characters as markers", () => {
		const panel = new FeaturePanel(plain);
		for (const event of stamp([
			{ ...feature, parentCallId: "c1", agent: "worker" },
			{ ...feature, title: "x\u001b[31my", tasks: [{ id: "T\u001b1", title: "t", specs: [] }] },
		]))
			panel.event(event);
		panel.toggle();
		const shown = text(panel.render(80));
		expect(shown).toContain("x␛[31my");
		expect(shown).toContain("T␛1");
		expect(shown).not.toContain("\u001b");
	});
});

describe("WorkStatus", () => {
	it("follows a review's lenses and steps while it runs, and clears when it ends", () => {
		const status = new WorkStatus(plain);
		const steps: Body[] = [
			{ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } },
			{ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "reliability" } },
			{ type: "review_progress", reviewId: "r1", step: { type: "lens_finished", lens: "risk", ok: true, findings: 2 } },
		];
		for (const event of stamp(steps)) status.event(event);
		expect(text(status.render(100))).toBe(" ◇ review · risk ✓ 2 findings · reliability …");
		for (const event of stamp([
			{
				type: "review_progress",
				reviewId: "r1",
				step: { type: "lens_finished", lens: "reliability", ok: false, findings: 0 },
			},
			{ type: "review_progress", reviewId: "r1", step: { type: "refuter_started", findings: 2 } },
		]))
			status.event(event);
		expect(text(status.render(100))).toBe(" ◇ review · risk ✓ 2 findings · reliability ✗ · refuting 2 findings…");
		for (const event of stamp([
			{
				type: "review_finished",
				reviewId: "r1",
				verdict: "approved",
				findings: [],
				refuted: [],
				followUps: [],
				correction: null,
				usage,
			},
		]))
			status.event(event);
		expect(status.render(100)).toEqual([]);
	});

	it("follows the verifier's rounds until it ends", () => {
		const status = new WorkStatus(plain);
		for (const event of stamp([{ type: "verification_started", verifyId: "v1", items: [2, 6], declaration: [] }]))
			status.event(event);
		expect(text(status.render(100))).toBe(" ◇ verify · items 2, 6 · round 1…");
		for (const event of stamp([
			{
				type: "verification_round",
				verifyId: "v1",
				round: 1,
				ok: true,
				requirements: [
					{ id: "S1", requirement: "a", verdict: "met", evidence: "" },
					{ id: "S2", requirement: "b", verdict: "unmet", evidence: "" },
				],
				defects: [],
				blocking: ["D1"],
				correcting: true,
				usage,
			},
		]))
			status.event(event);
		expect(text(status.render(100))).toBe(
			" ◇ verify · items 2, 6 · round 1: 1 met, 1 unmet · the agent is correcting…",
		);
		for (const event of stamp([
			{ type: "verification_finished", verifyId: "v1", outcome: "corrected", rounds: 2, openDefects: [], usage },
		]))
			status.event(event);
		expect(status.render(100)).toEqual([]);
	});

	it("clears what a turn left running when the turn ends", () => {
		const status = new WorkStatus(plain);
		for (const event of stamp([
			{ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } },
			{ type: "turn_finished", stopReason: "end_turn", usage },
		]))
			status.event(event);
		expect(status.render(100)).toEqual([]);
	});
});

describe("Conversation and ODD", () => {
	function shown(bodies: Body[]) {
		const conversation = new Conversation(plain, "/repo");
		for (const event of stamp(bodies)) conversation.event(event);
		return text(conversation.render(120));
	}

	it("lists the verifier's verdict on each requirement and the defects it found", () => {
		const screen = shown([
			{
				type: "verification_round",
				verifyId: "v1",
				round: 1,
				ok: true,
				requirements: [
					{ id: "S1", requirement: "Parses --mode", verdict: "met", evidence: "test passes" },
					{ id: "S2", requirement: "Rejects yolo", verdict: "unmet", evidence: "accepted it" },
					{ id: "S3", requirement: "Docs", verdict: "unverified", evidence: "no README" },
				],
				defects: [
					{
						id: "D1",
						severity: "major",
						summary: "yolo accepted",
						reproduction: "run it",
						candidate: "",
						base: "",
						onBase: false,
					},
				],
				blocking: ["D1"],
				correcting: false,
				usage,
			},
		]);
		expect(screen).toContain("◇ verify · round 1 · 1 defect (major) · 1 met, 1 unmet, 1 unverified");
		expect(screen).toContain("  ✓ S1 met · Parses --mode");
		expect(screen).toContain("  ✗ S2 unmet · Rejects yolo — accepted it");
		expect(screen).toContain("  ? S3 unverified · Docs — no README");
		expect(screen).toContain("  D1 major · yolo accepted");
		expect(screen).not.toContain("test passes");
	});

	it("sums up a review's steps once, before its verdict, instead of a line per step", () => {
		const screen = shown([
			{ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } },
			{ type: "review_progress", reviewId: "r1", step: { type: "lens_finished", lens: "risk", ok: true, findings: 2 } },
			{ type: "review_progress", reviewId: "r1", step: { type: "refuter_started", findings: 2 } },
			{ type: "review_progress", reviewId: "r1", step: { type: "refuter_finished", confirmed: 0, refuted: 2 } },
			{
				type: "review_finished",
				reviewId: "r1",
				verdict: "approved",
				findings: [],
				refuted: [],
				followUps: [],
				correction: null,
				usage,
			},
		]);
		expect(screen).toBe(" ◇ review: risk 2 findings · 0 confirmed · 2 refuted\n ✓ review approved");
	});

	it("leaves the phase to the footer", () => {
		expect(shown([{ type: "phase_changed", phase: "planning", source: "inferred" }])).toBe("");
	});
});
