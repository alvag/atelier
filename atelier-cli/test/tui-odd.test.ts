import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/conversation.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);
const text = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");

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

	it("leaves the phase to the footer", () => {
		expect(shown([{ type: "phase_changed", phase: "planning", source: "inferred" }])).toBe("");
	});
});
