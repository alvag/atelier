import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type FooterState, footerAfter, footerLine } from "../src/tui/footer.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);

describe("footer", () => {
	const after = (bodies: Body[], state: FooterState = {}) => stamp(bodies).reduce(footerAfter, state);

	it("says the model, effort, profile, mode, sandbox, context, cost, phase and task", () => {
		const state = after([
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-opus-5-5",
				authSource: "subscription",
				effort: "high",
				profile: { name: "claude", origin: "explicit", roles: {} },
				permissionMode: "auto",
			},
			{ type: "sandbox_status", sandboxed: true, mechanism: "seatbelt" },
			{ type: "phase_changed", phase: "implementing", source: "declared" },
			{
				type: "feature_changed",
				name: "m14",
				path: "odd/tasks/m14.md",
				title: "M14",
				tasks: [
					{ id: "T1", title: "a", specs: [], status: "done" },
					{ id: "T2", title: "b", specs: [], status: "in_progress" },
					{ id: "T3", title: "c", specs: [] },
				],
			},
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				costUsd: 0.3,
				context: { tokens: 68_000, window: 200_000, compactAt: 180_000 },
			},
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.12 },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 5, parentCallId: "task1" },
		]);
		expect(footerLine(state, 120, plain)).toBe(
			" claude-opus-5-5 high · profile claude · auto · sandbox ✓ · ctx 34% · $0.42 · implementing · T2 1/3",
		);
	});

	it("takes what a configuration change left and cuts the line to the width", () => {
		const state = after(
			[{ type: "session_configured", backend: "anthropic-api", thinking: "low", permissionMode: "yolo" }],
			{ backend: "claude-code", model: "claude-opus-5-5", effort: "high", mode: "normal" },
		);
		expect(footerLine(state, 120, plain)).toBe(" anthropic-api low · yolo");
		expect(visibleWidth(footerLine({ ...state, profile: "x".repeat(200) }, 30, plain))).toBeLessThanOrEqual(30);
	});
});
