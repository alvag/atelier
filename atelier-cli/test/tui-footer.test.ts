import { type AtelierEvent, type AtelierEventBody, FakeBackend, Session } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_STATUS_LINE, type FooterState, footerAfter, footerLine } from "../src/tui/footer.ts";
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
			" claude-opus-5-5 high · profile claude · auto · sandbox ✓ · ctx ▰▰▰▱▱▱▱▱ 34% · 200k · $0.42 · implementing · T2 1/3",
		);
	});

	it("says the context size is unknown right after a compaction, until a turn measures it", () => {
		const turn = (context: { tokens: number; unknown?: true }): Body => ({
			type: "turn_finished",
			stopReason: "end_turn",
			usage,
			context: { window: 1_000_000, compactAt: 967_000, ...context },
		});
		const compacted = after([turn({ tokens: 400_000 }), turn({ tokens: 3000, unknown: true })]);
		expect(footerLine(compacted, 120, plain, ["context"])).toBe(" ctx ▱▱▱▱▱▱▱▱ ? · 1M");
		expect(footerLine(after([turn({ tokens: 20_000 })], compacted), 120, plain, ["context"])).toBe(
			" ctx ▱▱▱▱▱▱▱▱ 2% · 1M",
		);
	});

	it("colors the gauge by how close compaction is, not by the share of the window", () => {
		const tagged = (style: Parameters<typeof plain>[0], text: string) => `<${String(style)}>${text}</>`;
		const at = (tokens: number) =>
			footerLine({ context: { tokens, window: 1_000_000, compactAt: 200_000 } }, 120, tagged, ["context"]);
		expect(at(100_000)).toBe(" ctx ▰▱▱▱▱▱▱▱ 10% · 1M");
		expect(at(150_000)).toBe(" <yellow>ctx ▰▱▱▱▱▱▱▱ 15% · 1M</>");
		expect(at(190_000)).toBe(" <red>ctx ▰▰▱▱▱▱▱▱ 19% · 1M</>");
	});

	it("says the size is unknown as soon as the main agent compacts, not when a subagent does", () => {
		const measured = after([
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 400_000, window: 1_000_000, compactAt: 983_616 },
			},
		]);
		const compacted: Body = {
			type: "compaction_finished",
			ok: true,
			reason: "threshold",
			tokensBefore: 400_000,
			kept: 2,
			usage,
		};
		expect(footerLine(after([compacted], measured), 120, plain, ["context"])).toBe(" ctx ▱▱▱▱▱▱▱▱ ? · 1M");
		expect(footerLine(after([{ ...compacted, parentCallId: "task1" }], measured), 120, plain, ["context"])).toBe(
			" ctx ▰▰▰▱▱▱▱▱ 40% · 1M",
		);
		expect(footerLine(after([{ ...compacted, ok: false }], measured), 120, plain, ["context"])).toBe(
			" ctx ▰▰▰▱▱▱▱▱ 40% · 1M",
		);
	});

	it("hides the gauge after the backend or the model changes, until a turn measures the new window", () => {
		const measured = after([
			{ type: "session_started", backend: "anthropic-api", model: "claude-opus-5-5", authSource: "api_key" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 400_000, window: 1_000_000, compactAt: 983_616 },
			},
		]);
		const configured = (backend: string, model?: string): Body => ({
			type: "session_configured",
			backend,
			...(model === undefined ? {} : { model }),
			thinking: "high",
			effort: "high",
			permissionMode: "normal",
		});
		const context = (state: FooterState) => footerLine(state, 120, plain, ["context"]);
		expect(context(after([configured("anthropic-api", "claude-opus-5-5")], measured))).toBe(" ctx ▰▰▰▱▱▱▱▱ 40% · 1M");
		expect(context(after([configured("anthropic-api", "claude-haiku-5-5")], measured))).toBe(" ");
		expect(context(after([configured("anthropic-api")], measured))).toBe(" ");
		expect(context(after([configured("openai-codex", "claude-opus-5-5")], measured))).toBe(" ");
	});

	it("keeps the gauge hidden when the model changes during a turn, until the new model measures it", async () => {
		let session: Session | undefined;
		const context = { window: 1_000_000, compactAt: 983_616 };
		const backend = new FakeBackend([
			[{ event: { type: "turn_finished", stopReason: "end_turn", usage, context: { tokens: 190_000, ...context } } }],
			[
				{ run: async () => void (await session?.configure({ model: "claude-haiku-5-5" })) },
				{ event: { type: "turn_finished", stopReason: "end_turn", usage, context: { tokens: 190_000, ...context } } },
			],
		]);
		session = await Session.start({ backend, cwd: "/w", tools: [], model: "claude-opus-5-5" });
		let state: FooterState = { backend: "fake", model: "claude-opus-5-5" };
		for await (const event of session.send("one")) state = footerAfter(state, event);
		expect(footerLine(state, 120, plain, ["context"])).toBe(" ctx ▰▰▱▱▱▱▱▱ 19% · 1M");
		for await (const event of session.send("two")) state = footerAfter(state, event);
		expect(footerLine(state, 120, plain, ["model", "context"])).toBe(" claude-haiku-5-5");
		await session.close();
	});

	it("says the asked level when the model did not take it", () => {
		const state = after([
			{
				type: "session_started",
				backend: "opencode-go",
				model: "glm-5.3",
				authSource: "api_key",
				effort: "medium not sent",
			},
		]);
		expect(footerLine(state, 120, plain)).toBe(" glm-5.3 medium not sent");
	});

	it("takes what a configuration change left and cuts the line to the width", () => {
		const state = after(
			[
				{
					type: "session_configured",
					backend: "anthropic-api",
					thinking: "low",
					effort: "low",
					permissionMode: "yolo",
				},
			],
			{ backend: "claude-code", model: "claude-opus-5-5", effort: "high", mode: "normal" },
		);
		expect(footerLine(state, 120, plain)).toBe(" anthropic-api low · yolo");
		expect(visibleWidth(footerLine({ ...state, profile: "x".repeat(200) }, 30, plain))).toBeLessThanOrEqual(30);
	});

	it("shows the effort the configuration says the backend sends, not the level asked", () => {
		const afterChange = (
			model: string,
			thinking: string,
			effort: NonNullable<Extract<AtelierEventBody, { type: "session_configured" }>["effort"]>,
		) =>
			after([
				{ type: "session_started", backend: "opencode-go", model, authSource: "api_key" },
				{ type: "session_configured", backend: "opencode-go", thinking, effort, permissionMode: "normal" },
			]);
		// kimi-k2.7-code reasons on its own: a level asked is `auto`.
		expect(footerLine(afterChange("kimi-k2.7-code", "high", "auto"), 120, plain)).toBe(" opencode-go auto · normal");
		// minimax-m3 with an output budget too small for a thinking budget: `high not sent`.
		expect(footerLine(afterChange("minimax-m3", "high", "high not sent"), 120, plain)).toBe(
			" opencode-go high not sent · normal",
		);
		// glm-5.3 takes no `medium`: `medium not sent`.
		expect(footerLine(afterChange("glm-5.3", "medium", "medium not sent"), 120, plain)).toBe(
			" opencode-go medium not sent · normal",
		);
	});

	it("keeps the effort label while a change waits for the turn to end", () => {
		const state = after([
			{
				type: "session_started",
				backend: "opencode-go",
				model: "kimi-k2.7-code",
				authSource: "api_key",
				effort: "auto",
			},
			{ type: "session_configured", backend: "opencode-go", thinking: "high", permissionMode: "normal" },
		]);
		expect(footerLine(state, 120, plain)).toBe(" opencode-go auto · normal");
	});

	it("shows the items chosen in their order and leaves out the ones without a value", () => {
		const state: FooterState = {
			backend: "claude-code",
			model: "claude-opus-5-5",
			effort: "high",
			mode: "auto",
			cwd: "/work/atelier",
			branch: "feat/x",
			version: "0.2.0",
			costUsd: 0.5,
		};
		expect(footerLine(state, 120, plain, ["cost", "mode", "phase", "git-branch", "version", "cwd"])).toBe(
			" $0.50 · auto · feat/x · v0.2.0 · atelier",
		);
		expect(footerLine(state, 120, plain, ["effort", "backend", "model"])).toBe(" high · claude-code · claude-opus-5-5");
		expect(footerLine(state, 120, plain, [])).toBe(" ");
	});

	it("by default adds the working folder and the branch after the model", () => {
		const state: FooterState = { model: "m", effort: "low", cwd: "/work/atelier", branch: "main", mode: "normal" };
		expect(footerLine(state, 120, plain)).toBe(" m low · atelier · main · normal");
		expect(footerLine(state, 120, plain, DEFAULT_STATUS_LINE)).toBe(" m low · atelier · main · normal");
	});
});
