import { describe, expect, it } from "vitest";
import { type AtelierEvent, type ContextUsage, FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { contextGauge, contextWarningText, windowSize } from "../src/protocol/index.ts";
import type { SubagentDefinition } from "../src/subagents/definitions.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const ended = (context?: ContextUsage): FakeStep[] => [
	{ event: { type: "turn_finished", stopReason: "end_turn", usage, ...(context === undefined ? {} : { context }) } },
];
/** A context of `tokens` in a 1M window that compacts at 200,000, as Claude Code can. */
const at = (tokens: number): ContextUsage => ({ tokens, window: 1_000_000, compactAt: 200_000 });
const compacted = {
	event: { type: "compaction_finished", ok: true, reason: "threshold", tokensBefore: 190_000, kept: 2, usage },
} satisfies FakeStep;

async function drain(session: Session, prompt = "go"): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of session.send(prompt)) events.push(event);
	return events;
}

const warnings = (events: AtelierEvent[]) => events.filter((event) => event.type === "context_warning");

describe("contextGauge", () => {
	it.each([
		{ context: at(0), text: "▱▱▱▱▱▱▱▱ 0% · 1M", level: "normal" },
		{ context: at(110_000), text: "▰▱▱▱▱▱▱▱ 11% · 1M", level: "normal" },
		// The colors measure how close compaction is, not the share of the window.
		{ context: at(140_001), text: "▰▱▱▱▱▱▱▱ 14% · 1M", level: "warning" },
		{ context: at(180_001), text: "▰▱▱▱▱▱▱▱ 18% · 1M", level: "danger" },
		{ context: { tokens: 100_000, window: 200_000, compactAt: 183_616 }, text: "▰▰▰▰▱▱▱▱ 50% · 200k", level: "normal" },
		{
			context: { tokens: 272_000, window: 272_000, compactAt: 223_616 },
			text: "▰▰▰▰▰▰▰▰ 100% · 272k",
			level: "danger",
		},
		{ context: { ...at(150_000), unknown: true as const }, text: "▱▱▱▱▱▱▱▱ ? · 1M", level: "normal" },
	])("$text, $level", ({ context, text, level }) => {
		expect(contextGauge(context)).toMatchObject({ text, level });
	});

	it.each([
		[1_000_000, "1M"],
		[1_500_000, "1.5M"],
		[200_000, "200k"],
		[131_072, "131k"],
		[999, "999"],
	])("names a window of %i as %s", (tokens, name) => {
		expect(windowSize(tokens)).toBe(name);
	});

	it("says the share of the window and where it compacts", () => {
		expect(contextWarningText(at(182_000))).toBe(
			"⚠ context at 18% of the 1M window (182,000 tokens), near where it compacts (200,000)",
		);
	});
});

describe("context_warning", () => {
	it("is said once, before the turn ends, when the context reaches 90% of where it compacts", async () => {
		const backend = new FakeBackend([ended(at(170_000)), ended(at(180_000)), ended(at(185_000)), ended()]);
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		expect(warnings(await drain(session))).toEqual([]);
		const turn = await drain(session);
		expect(turn.slice(-2).map((event) => event.type)).toEqual(["context_warning", "turn_finished"]);
		expect(warnings(turn)).toMatchObject([{ tokens: 180_000, window: 1_000_000, compactAt: 200_000 }]);
		expect(warnings(await drain(session))).toEqual([]);
		expect(warnings(await drain(session))).toEqual([]);
		await session.close();
	});

	it("is said again after the context went below 90%, or was unknown", async () => {
		const backend = new FakeBackend([
			ended(at(190_000)),
			ended(at(100_000)),
			ended(at(190_000)),
			ended({ ...at(10_000), unknown: true }),
			ended(at(190_000)),
		]);
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		const said = [];
		for (let turn = 0; turn < 5; turn++) said.push(warnings(await drain(session)).length);
		expect(said).toEqual([1, 0, 1, 0, 1]);
		await session.close();
	});

	it("is said again after a compaction, also in the same turn, but not after a subagent's", async () => {
		// A subagent's events reach the session tagged with its task call, as the task tool forwards them.
		const childCompacted = { event: { ...compacted.event, parentCallId: "task_1" } } as FakeStep;
		const backend = new FakeBackend([
			ended(at(190_000)),
			[compacted, ...ended(at(190_000))],
			[childCompacted, ...ended(at(190_000))],
		]);
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		const said = [];
		for (let turn = 0; turn < 3; turn++) said.push(warnings(await drain(session)).length);
		expect(said).toEqual([1, 1, 0]);
		await session.close();
	});

	it("measures a turn by the model that ran it when the model changes during the turn", async () => {
		let session: Session | undefined;
		const backend = new FakeBackend([
			ended(at(190_000)),
			[{ run: async () => void (await session?.configure({ model: "other" })) }, ...ended(at(190_000))],
			ended({ tokens: 175_000, window: 200_000, compactAt: 183_616 }),
		]);
		session = await Session.start({ backend, cwd: "/w", tools: [] });
		expect(warnings(await drain(session))).toHaveLength(1);
		const changed = await drain(session);
		// The turn measured the model before the change: no warning, and no context for the new one.
		expect(warnings(changed)).toEqual([]);
		expect(changed.map((event) => event.type).slice(-2)).toEqual(["session_configured", "turn_finished"]);
		expect(changed.at(-1)).not.toHaveProperty("context");
		expect(warnings(await drain(session))).toMatchObject([{ tokens: 175_000, window: 200_000, compactAt: 183_616 }]);
		await session.close();
	});

	it("is said again after the model goes to another one and back", async () => {
		const backend = new FakeBackend([ended(at(190_000)), ended(at(190_000))]);
		const session = await Session.start({ backend, cwd: "/w", tools: [], model: "first" });
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.configure({ model: "other" });
		await session.configure({ model: "first" });
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.close();
	});

	it("is said again on a new backend session, also of the backend it was said on", async () => {
		const backend = new FakeBackend([ended(at(190_000))], "anthropic-api");
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.setBackend(new FakeBackend([], "openai-codex"));
		await session.setBackend(new FakeBackend([ended(at(190_000))], "anthropic-api"));
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.close();
	});

	it("looks only at the main agent's context: a subagent's turn neither warns, nor rearms, nor uses up the warning", async () => {
		const explorer: SubagentDefinition = {
			name: "explorer",
			description: "Reads code",
			tools: [],
			prompt: "EXPLORER PROMPT",
			models: {},
			maxRequests: 30,
		};
		const delegating = (callId: string, parent: number): FakeStep[] => [
			{ toolCall: { tool: "task", input: { agent: "explorer", prompt: "Look." }, callId } },
			...ended(at(parent)),
		];
		const child = (tokens: number): FakeStep[] => [
			{ event: { type: "text_delta", text: "report" } },
			...ended(at(tokens)),
		];
		// A child near compaction while the parent is not; then both near it; then a child far from it.
		const children = [child(195_000), child(195_000), child(10_000)];
		const backend = new FakeBackend([delegating("c1", 100_000), delegating("c2", 190_000), delegating("c3", 190_000)]);
		const session = await Session.start({
			backend,
			cwd: "/w",
			tools: [],
			subagents: { agents: [explorer], createBackend: () => new FakeBackend([children.shift() ?? []]) },
		});
		const turns = [await drain(session), await drain(session), await drain(session)];
		expect(turns.map((turn) => warnings(turn).length)).toEqual([0, 1, 0]);
		expect(warnings(turns[1] ?? [])).toEqual([
			expect.objectContaining({ tokens: 190_000, window: 1_000_000, compactAt: 200_000 }),
		]);
		expect(warnings(turns[1] ?? [])[0]).not.toHaveProperty("parentCallId");
		await session.close();
	});

	it("is said again after the model or the backend changes", async () => {
		const backend = new FakeBackend([ended(at(190_000)), ended(at(190_000)), ended(at(190_000))]);
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.configure({ model: "other" });
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.setBackend(new FakeBackend([ended(at(190_000))], "anthropic-api"));
		expect(warnings(await drain(session))).toHaveLength(1);
		await session.close();
	});
});
