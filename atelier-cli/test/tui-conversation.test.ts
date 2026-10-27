import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/conversation.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);

function shown(bodies: Body[], width = 80, expanded = false) {
	const conversation = new Conversation(plain, "/repo");
	for (const event of stamp(bodies)) conversation.event(event);
	if (expanded) conversation.toggleCards();
	const lines = conversation.render(width);
	return { lines, text: lines.map((line) => line.trimEnd()).join("\n") };
}

describe("Conversation", () => {
	it("shows the agent's text as Markdown and each tool call as one folded line", () => {
		const { text } = shown([
			{ type: "text_delta", text: "Reading **the** " },
			{ type: "text_delta", text: "parser." },
			{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "src/args.ts" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "src/args.ts (132 lines)", truncated: false },
			{ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "pnpm test\n--run" } },
			{ type: "tool_call_finished", callId: "c2", ok: false, summary: "pnpm test (exit 1)", truncated: false },
			{ type: "tool_call_started", callId: "c3", tool: "grep", input: { pattern: "mode" } },
		]);
		expect(text).toContain("Reading the parser.");
		expect(text).not.toContain("**");
		expect(text).toContain("▸ read src/args.ts · 132 lines ✓");
		expect(text).toContain("▸ bash pnpm test · exit 1 ✗");
		expect(text).toContain("▸ grep mode …");
		expect(text).not.toContain("--run");
	});

	it("expands every card to show the call's input and where its full output is", () => {
		const { text } = shown(
			[
				{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "pnpm test\n--run" } },
				{
					type: "tool_call_finished",
					callId: "c1",
					ok: true,
					summary: "pnpm test (exit 0)",
					truncated: true,
					fullOutputPath: "/tmp/out.txt",
				},
				{
					type: "tool_call_started",
					callId: "c2",
					tool: "edit",
					input: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
				},
				{ type: "tool_call_finished", callId: "c2", ok: true, summary: "a.ts (1 edit)", truncated: false },
			],
			80,
			true,
		);
		expect(text).toContain("▾ bash pnpm test · exit 0 ✓");
		expect(text).toContain("│ $ pnpm test\n   │ --run");
		expect(text).toContain("│ full output: /tmp/out.txt");
		expect(text).toContain("│ - old\n   │ + new");
	});

	it("groups a subagent's work under its task call, with its tools and cost", () => {
		const bodies: Body[] = [
			{ type: "tool_call_started", callId: "task1", tool: "task", input: { agent: "worker", prompt: "fix it" } },
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-sonnet-5-5",
				authSource: "subscription",
				parentCallId: "task1",
				agent: "worker",
			},
			{ type: "text_delta", text: "child text", parentCallId: "task1", agent: "worker" },
			{ type: "tool_call_started", callId: "k1", tool: "read", input: { path: "b.ts" }, parentCallId: "task1" },
			{
				type: "tool_call_finished",
				callId: "k1",
				ok: true,
				summary: "b.ts (3 lines)",
				truncated: false,
				parentCallId: "task1",
			},
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.04, parentCallId: "task1" },
			{ type: "tool_call_finished", callId: "task1", ok: true, summary: "worker (done)", truncated: false },
		];
		const folded = shown(bodies).text;
		expect(folded).toContain("▸ task worker · done ✓\n   └ worker · claude-sonnet-5-5 · 1 tool · $0.04");
		expect(folded).not.toContain("child text");
		expect(folded).not.toContain("b.ts");
		const open = shown(bodies, 80, true).text;
		expect(open).toContain("▸ read b.ts · 3 lines ✓");
		expect(open).toContain("child text");
	});

	it("groups the verifier's events under one line in the verification's card", () => {
		const { text } = shown([
			{ type: "verification_started", verifyId: "v1", items: [2], declaration: [{ items: [2], reason: "auth" }] },
			{
				type: "tool_call_started",
				callId: "k1",
				tool: "bash",
				input: { command: "pnpm test" },
				parentCallId: "v1",
				agent: "verify:verifier",
			},
			{
				type: "tool_call_finished",
				callId: "k1",
				ok: true,
				summary: "pnpm test (exit 0)",
				truncated: false,
				parentCallId: "v1",
				agent: "verify:verifier",
			},
			{ type: "verification_finished", verifyId: "v1", outcome: "passed", rounds: 1, openDefects: [], usage },
		]);
		expect(text).toContain("▸ verify · item 2\n   └ verify:verifier · 1 tool\n ✓ verify passed");
	});

	it("shows control characters in the agent's text and tool input as markers", () => {
		const { text } = shown([
			{ type: "text_delta", text: "hi \u001b[2J there" },
			{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "echo ‮x" } },
		]);
		expect(text).toContain("hi ␛[2J there");
		expect(text).toContain("echo ⟨U+202E⟩x");
	});

	it("keeps review roles and their costs separate even with one review id", () => {
		const role = (agent: string, model: string, text: string, costUsd: number): Body[] => [
			{ type: "session_started", backend: "b", model, authSource: "subscription", agent, parentCallId: "r" },
			{ type: "text_delta", text, agent, parentCallId: "r" },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd, agent, parentCallId: "r" },
		];
		const { text } = shown([
			...role("review:risk", "risk-model", "Risk report.", 0.01),
			...role("review:reliability", "reliability-model", "Reliability report.", 0.02),
		]);
		expect(text).toContain("review:risk · risk-model · 0 tools · $0.01");
		expect(text).toContain("review:reliability · reliability-model · 0 tools · $0.02");
		expect(text).not.toContain("Risk report.Reliability report.");
	});

	it("expects a cache miss only in the compaction's turn and the next one", () => {
		const compacted: Body = {
			type: "compaction_finished",
			ok: true,
			reason: "manual",
			tokensBefore: 9000,
			kept: 1,
			usage,
		};
		const turn: Body = { type: "turn_finished", stopReason: "end_turn", usage };
		const miss: Body = { type: "cache_miss", reason: "system_changed", missedTokens: 100 };
		const soon = shown([compacted, turn, miss]).text;
		expect(soon).toContain("cache miss after compaction: system_changed (expected)");
		const late = shown([compacted, turn, turn, turn, miss]).text;
		expect(late).toContain("cache miss: system_changed (100 tokens not read from the cache)");
		expect(late).not.toContain("(expected)");
	});

	it("shows control characters of every event string as markers", () => {
		const esc = "x\u001b[31my";
		const { text } = shown([
			{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "ls" } },
			{ type: "tool_call_finished", callId: "c1", ok: false, summary: "ls (exit 1)", truncated: false, blocked: [esc] },
			{ type: "memory_status", available: true, project: esc },
			{ type: "memory_status", available: false, reason: esc },
			{ type: "project_instructions", files: [esc], dropped: [esc] },
			{ type: "review_status", available: false, reason: esc },
			{ type: "sandbox_status", sandboxed: false, mechanism: esc, reason: esc },
			{ type: "sandbox_warning", reason: esc },
			{ type: "cache_miss", reason: esc, missedTokens: 1 },
			{ type: "rate_limit", status: esc, window: esc },
			{ type: "error", code: esc, message: esc, recoverable: false },
			{ type: "phase_changed", phase: "planning", source: "inferred" },
		]);
		expect(text).toContain("x␛[31my");
		expect(text).not.toContain("\u001b");
	});

	it("leaves the phase to the footer", () => {
		expect(shown([{ type: "phase_changed", phase: "planning", source: "inferred" }]).text).toBe("");
	});

	it("says the header once while it does not change, and what a turn took", () => {
		const started: Body = {
			type: "session_started",
			backend: "claude-code",
			model: "claude-opus-5-5",
			authSource: "subscription",
		};
		const { text } = shown([
			started,
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.0421, requests: 3, durationMs: 12_300 },
			started,
		]);
		expect(text.match(/atelier · claude-code · claude-opus-5-5/g)).toHaveLength(1);
		expect(text).toContain("◇ 12.3s · 3 requests · $0.0421");
	});

	it("never renders a line wider than the terminal", () => {
		const long = "x".repeat(300);
		const { lines } = shown(
			[
				{ type: "text_delta", text: long },
				{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: long } },
				{
					type: "tool_call_finished",
					callId: "c1",
					ok: true,
					summary: `${long} (exit 0)`,
					truncated: false,
					blocked: [long],
				},
			],
			40,
			true,
		);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});
