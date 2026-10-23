import type { AtelierEventBody } from "@atelier/core/protocol";
import { describe, expect, it } from "vitest";
import { type ChatAction, type ChatState, initialChatState, reduceChat } from "../src/renderer/src/chat/reducer.ts";

const usage = { input: 10, output: 5, cacheRead: 300, cacheWrite: 20 };

function run(actions: ChatAction[], state: ChatState = initialChatState): ChatState {
	return actions.reduce(reduceChat, state);
}

let seq = 0;
function event(body: AtelierEventBody, turnId = "t1", sessionId = "s1"): ChatAction {
	return { type: "event", sessionId, event: { ...body, seq: ++seq, turnId } as never };
}

const ready: ChatAction[] = [
	{ type: "core_ready", version: "0.0.0" },
	{ type: "session_opened", sessionId: "s1", cwd: "/work" },
];

describe("reduceChat", () => {
	it("tracks the core status", () => {
		expect(initialChatState.core).toEqual({ status: "starting" });
		expect(run([{ type: "core_ready", version: "1.2.3" }]).core).toEqual({ status: "ready", version: "1.2.3" });
		expect(run([{ type: "core_failed", message: "no binary" }]).core).toEqual({
			status: "failed",
			message: "no binary",
		});
	});

	it("builds a turn from the prompt, streamed text, a tool and the final tokens", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "add validation" },
			{ type: "turn_accepted", turnId: "t1" },
			event({ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" }),
			event({ type: "text_delta", text: "Let me " }),
			event({ type: "text_delta", text: "look." }),
			event({ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "src/user.ts" } }),
			event({ type: "tool_call_finished", callId: "c1", ok: true, summary: "src/user.ts (8 lines)", truncated: false }),
			event({ type: "text_delta", text: "Done." }),
			event({ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.07 }),
		]);
		expect(state.busy).toBe(false);
		expect(state.model).toBe("claude-opus-5-5");
		expect(state.authSource).toBe("subscription");
		expect(state.backend).toBe("claude-code");
		expect(state.turns).toEqual([
			{
				id: "t1",
				prompt: "add validation",
				items: [
					{ kind: "text", text: "Let me look." },
					{
						kind: "tool",
						callId: "c1",
						tool: "read",
						input: { path: "src/user.ts" },
						status: "ok",
						summary: "src/user.ts (8 lines)",
						truncated: false,
					},
					{ kind: "text", text: "Done." },
				],
				finished: { stopReason: "end_turn", usage, costUsd: 0.07 },
			},
		]);
	});

	it("keeps cache misses in the turn and the request count in its tokens", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			{ type: "turn_accepted", turnId: "t1" },
			event({ type: "session_started", backend: "anthropic-api", model: "claude-sonnet-5-5", authSource: "api_key" }),
			event({ type: "cache_miss", reason: "tools_changed", missedTokens: 900 }),
			event({ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.01, requests: 2 }),
		]);
		expect(state.backend).toBe("anthropic-api");
		expect(state.turns[0]?.items).toEqual([{ kind: "cache_miss", reason: "tools_changed", missedTokens: 900 }]);
		expect(state.turns[0]?.finished).toEqual({ stopReason: "end_turn", usage, costUsd: 0.01, requests: 2 });
	});

	it("is busy from the prompt until the turn finishes", () => {
		const sending = run([...ready, { type: "prompt_sent", text: "x" }]);
		expect(sending.busy).toBe(true);
		const finished = run(
			[{ type: "turn_accepted", turnId: "t1" }, event({ type: "turn_finished", stopReason: "end_turn", usage })],
			sending,
		);
		expect(finished.busy).toBe(false);
	});

	it("attaches events that arrive before the turn id to the pending turn", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "text_delta", text: "early" }, "t9"),
		]);
		expect(state.turns[0]).toMatchObject({ id: "t9", items: [{ kind: "text", text: "early" }] });
		expect(run([{ type: "turn_accepted", turnId: "t9" }], state).turns).toHaveLength(1);
	});

	it("nests a subagent's events under its task call without touching the parent's state", () => {
		const child = (body: Record<string, unknown>) =>
			event({ ...body, parentCallId: "c1", agent: "explorer" } as unknown as AtelierEventBody);
		const childUsage = { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 };
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			{ type: "turn_accepted", turnId: "t1" },
			event({ type: "session_started", backend: "claude-code", model: "opus", authSource: "subscription" }),
			event({
				type: "tool_call_started",
				callId: "c1",
				tool: "task",
				input: { agent: "explorer", prompt: "Find it." },
			}),
			child({ type: "session_started", backend: "claude-code", model: "haiku", authSource: "subscription" }),
			child({ type: "tool_call_started", callId: "r1", tool: "read", input: { path: "a.ts" } }),
			child({ type: "tool_call_finished", callId: "r1", ok: true, summary: "a.ts (3 lines)", truncated: false }),
			child({ type: "text_delta", text: "Found " }),
			child({ type: "text_delta", text: "it." }),
			child({ type: "turn_finished", stopReason: "end_turn", usage: childUsage, costUsd: 0.001, requests: 2 }),
		]);
		expect(state.busy).toBe(true);
		expect(state.model).toBe("opus");
		expect(state.turns[0]?.items).toEqual([
			{
				kind: "tool",
				callId: "c1",
				tool: "task",
				input: { agent: "explorer", prompt: "Find it." },
				status: "running",
				subagent: {
					agent: "explorer",
					model: "haiku",
					items: [
						{
							kind: "tool",
							callId: "r1",
							tool: "read",
							input: { path: "a.ts" },
							status: "ok",
							summary: "a.ts (3 lines)",
							truncated: false,
						},
						{ kind: "text", text: "Found it." },
					],
					finished: { stopReason: "end_turn", usage: childUsage, costUsd: 0.001, requests: 2 },
				},
			},
		]);
	});

	it("tracks the memory status, and forgets it with a new session", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "memory_status", available: false, reason: "no engram" }),
		]);
		expect(state.memory).toEqual({ available: false, reason: "no engram" });
		expect(state.turns[0]?.items).toEqual([]);
		expect(run([{ type: "session_opened", sessionId: "s2", cwd: "/w" }], state)).not.toHaveProperty("memory");
	});

	it("tracks the phase and the active feature", () => {
		const tasks = [
			{ id: "T1", title: "A", specs: ["S1"], status: "done" },
			{ id: "T2", title: "B", specs: ["S1"], status: "pending" },
		];
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "phase_changed", phase: "planning", source: "inferred" }),
			event({ type: "feature_changed", name: "f", path: "odd/tasks/f.md", title: "F", tasks }),
		]);
		expect(state.phase).toBe("planning");
		expect(state.feature).toEqual({ name: "f", path: "odd/tasks/f.md", title: "F", tasks });
		expect(state.turns[0]?.items).toEqual([]);
		expect(run([{ type: "session_opened", sessionId: "s2", cwd: "/w" }], state)).not.toHaveProperty("feature");
	});

	it("answers a subagent's approval card in place", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "tool_call_started", callId: "c1", tool: "task", input: {} }),
			event({
				type: "approval_requested",
				callId: "b1",
				command: "rm x",
				parentCallId: "c1",
				agent: "worker",
			} as never),
			{ type: "approval_answered", callId: "b1", approved: true },
		]);
		const task = state.turns[0]?.items[0];
		expect(task?.kind === "tool" && task.subagent?.items).toEqual([
			{ kind: "approval", callId: "b1", command: "rm x", state: "approved" },
		]);
	});

	it("shows an approval card and the denied tool", () => {
		const asked = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "rm -rf build" } }),
			event({ type: "approval_requested", callId: "c1", command: "rm -rf build" }),
		]);
		expect(asked.turns[0]?.items[1]).toEqual({
			kind: "approval",
			callId: "c1",
			command: "rm -rf build",
			state: "pending",
		});

		const answered = run(
			[
				{ type: "approval_answered", callId: "c1", approved: false },
				event({
					type: "tool_call_finished",
					callId: "c1",
					ok: false,
					summary: "The user denied this command.",
					truncated: false,
				}),
			],
			asked,
		);
		expect(answered.turns[0]?.items).toEqual([
			expect.objectContaining({ kind: "tool", callId: "c1", status: "denied" }),
			{ kind: "approval", callId: "c1", command: "rm -rf build", state: "denied" },
		]);
	});

	it("keeps errors in the turn and in the status bar", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "error", code: "not_logged_in", message: "Claude Code is not logged in.", recoverable: false }),
			event({ type: "turn_finished", stopReason: "error", usage }),
		]);
		expect(state.turns[0]?.items).toContainEqual({
			kind: "error",
			code: "not_logged_in",
			message: "Claude Code is not logged in.",
		});
		expect(state.lastError).toEqual({ code: "not_logged_in", message: "Claude Code is not logged in." });
	});

	it("shows a failed command and frees the composer", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			{ type: "command_failed", code: "busy", message: "A turn is already running in this session." },
		]);
		expect(state.busy).toBe(false);
		expect(state.lastError).toEqual({ code: "busy", message: "A turn is already running in this session." });
		expect(state.turns[0]?.items).toContainEqual({
			kind: "error",
			code: "busy",
			message: "A turn is already running in this session.",
		});
	});

	it("loses the session and says so when the core exits", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			{ type: "core_exited", message: "The core stopped (exit code 1)." },
		]);
		expect(state.core).toEqual({ status: "exited", message: "The core stopped (exit code 1)." });
		expect(state.session).toBeUndefined();
		expect(state.busy).toBe(false);
		expect(state.lastError).toEqual({ code: "core_exited", message: "The core stopped (exit code 1)." });
	});

	it("reports protocol errors and rate limits that matter", () => {
		expect(run([{ type: "protocol_error", message: "Unreadable line" }]).lastError).toEqual({
			code: "protocol_error",
			message: "Unreadable line",
		});
		const limited = run([...ready, event({ type: "rate_limit", status: "allowed_warning", window: "five_hour" })]);
		expect(limited.notice).toBe("Rate limit: allowed_warning (five_hour)");
		expect(run([...ready, event({ type: "rate_limit", status: "allowed" })]).notice).toBeUndefined();
	});

	it("ignores events from other sessions", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			event({ type: "text_delta", text: "other" }, "t1", "s2"),
		]);
		expect(state.turns[0]?.items).toEqual([]);
	});

	it("starts clean on a new session", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			{ type: "session_opened", sessionId: "s2", cwd: "/other" },
		]);
		expect(state.session).toEqual({ id: "s2", cwd: "/other" });
		expect(state.turns).toEqual([]);
		expect(state.busy).toBe(false);
	});

	it("applies a batch of messages in order", () => {
		const state = run([
			...ready,
			{ type: "prompt_sent", text: "x" },
			{ type: "batch", actions: [event({ type: "text_delta", text: "a" }), event({ type: "text_delta", text: "b" })] },
		]);
		expect(state.turns[0]?.items).toEqual([{ kind: "text", text: "ab" }]);
	});
});

describe("reduceChat: review", () => {
	const opened = [
		...ready,
		{ type: "prompt_sent", text: "x" } as ChatAction,
		{ type: "turn_accepted", turnId: "t1" } as ChatAction,
	];
	const assessed: AtelierEventBody = {
		type: "review_assessed",
		tree: "t",
		level: "high",
		reasons: ["path: src/auth.ts (auth)"],
		files: ["src/auth.ts"],
		changedLines: 9,
		lenses: ["risk", "resilience"],
		reviewDue: true,
	};
	const consent: AtelierEventBody = {
		type: "review_consent_requested",
		reviewId: "r1",
		level: "high",
		reasons: ["path: src/auth.ts (auth)"],
		lenses: ["risk", "resilience"],
	};
	const finishedReview: AtelierEventBody = {
		type: "review_finished",
		reviewId: "r1",
		verdict: "approved",
		findings: [],
		refuted: [],
		followUps: [],
		correction: null,
		receiptPath: "/repo/.git/atelier/reviews/abc.json",
		usage,
	};
	const items = (state: ChatState) => state.turns.at(-1)?.items ?? [];
	const child = (body: Record<string, unknown>, agent: string) =>
		event({ ...body, parentCallId: "r1", agent } as unknown as AtelierEventBody);

	it("keeps why there is no review in the status, and forgets it with the session", () => {
		const state = run([...ready, event({ type: "review_status", available: false, reason: "not a git repository" })]);
		expect(state.review).toEqual({ available: false, reason: "not a git repository" });
		expect(run([{ type: "session_opened", sessionId: "s2", cwd: "/other" }], state).review).toBeUndefined();
	});

	it("adds a review block with the risk, and a consent card that adopts the review id", () => {
		const state = run([...opened, event(assessed), event(consent)]);
		expect(items(state)).toEqual([
			{
				kind: "review",
				reviewId: "r1",
				level: "high",
				reasons: ["path: src/auth.ts (auth)"],
				lenses: ["risk", "resilience"],
				roles: [],
			},
			{
				kind: "review_consent",
				reviewId: "r1",
				level: "high",
				reasons: ["path: src/auth.ts (auth)"],
				lenses: ["risk", "resilience"],
				state: "pending",
			},
		]);
	});

	it("marks the card with the answer", () => {
		const state = run([
			...opened,
			event(assessed),
			event(consent),
			{ type: "review_consent_answered", reviewId: "r1", answer: "granted" },
		]);
		expect(items(state)[1]).toMatchObject({ kind: "review_consent", state: "granted" });
		const declined = run(
			[{ type: "review_consent_answered", reviewId: "r1", answer: "declined" }],
			run([...opened, event(consent)]),
		);
		expect(items(declined)[1]).toMatchObject({ kind: "review_consent", state: "declined" });
	});

	it("closes a pending card when the review finishes, and keeps an answered one", () => {
		const pending = run([...opened, event(assessed), event(consent), event(finishedReview)]);
		expect(items(pending)).toContainEqual(expect.objectContaining({ kind: "review_consent", state: "closed" }));
		const answered = run([
			...opened,
			event(consent),
			{ type: "review_consent_answered", reviewId: "r1", answer: "declined" },
			event({ ...finishedReview, verdict: "declined" }),
		]);
		expect(items(answered)).toContainEqual(expect.objectContaining({ kind: "review_consent", state: "declined" }));
	});

	it("closes a pending card when the turn ends without an answer (interrupted)", () => {
		const state = run([
			...opened,
			event(assessed),
			event(consent),
			event({ type: "turn_finished", stopReason: "interrupted", usage }),
		]);
		expect(items(state)).toContainEqual(expect.objectContaining({ kind: "review_consent", state: "closed" }));
	});

	it("nests each role's work in its own block under the review, not under a tool call", () => {
		const state = run([
			...opened,
			event({ type: "text_delta", text: "done" }),
			event(assessed),
			event({ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } }),
			child({ type: "session_started", backend: "fake", model: "opus", authSource: "subscription" }, "review:risk"),
			child({ type: "text_delta", text: "looking" }, "review:risk"),
			child({ type: "text_delta", text: "other" }, "review:resilience"),
			child({ type: "turn_finished", stopReason: "end_turn", usage }, "review:risk"),
		]);
		const review = items(state).find((item) => item.kind === "review");
		expect(review).toMatchObject({ kind: "review", reviewId: "r1" });
		if (review?.kind !== "review") throw new Error("no review block");
		expect(review.roles.map((role) => role.agent)).toEqual(["review:risk", "review:resilience"]);
		expect(review.roles[0]).toMatchObject({
			model: "opus",
			items: [{ kind: "text", text: "looking" }],
			finished: { stopReason: "end_turn" },
		});
		expect(review.roles[1]?.items).toEqual([{ kind: "text", text: "other" }]);
		// A role's end never ends the parent's turn.
		expect(state.busy).toBe(true);
	});

	it("adopts a role's events that arrive before the first progress event of an on-demand review", () => {
		const state = run([...opened, event(assessed), child({ type: "text_delta", text: "hi" }, "review:risk")]);
		expect(items(state)).toHaveLength(1);
		expect(items(state)[0]).toMatchObject({ kind: "review", reviewId: "r1", roles: [{ agent: "review:risk" }] });
	});

	it("keeps the verdict, the findings, the correction and the receipt path", () => {
		const finding = {
			id: "RL-001",
			lens: "reliability",
			severity: "critical",
			cause: "candidate",
			path: "src/auth.ts",
			line: 3,
			claim: "The token is dropped.",
			evidence: "src/auth.ts:3",
		};
		const state = run([
			...opened,
			event(assessed),
			event({
				...finishedReview,
				verdict: "escalated",
				reason: "The correction changed 30 lines, over the budget of 12.",
				findings: [finding],
				refuted: [{ id: "RS-001", reason: "not real" }],
				followUps: [finding],
				correction: { budget: 12, used: 30 },
			} as AtelierEventBody),
		]);
		expect(items(state)).toHaveLength(1);
		expect(items(state)[0]).toMatchObject({
			kind: "review",
			result: {
				verdict: "escalated",
				reason: "The correction changed 30 lines, over the budget of 12.",
				findings: [finding],
				refuted: 1,
				followUps: 1,
				correction: { budget: 12, used: 30 },
				receiptPath: "/repo/.git/atelier/reviews/abc.json",
			},
		});
	});

	it("shows a review that finished with no earlier assessment", () => {
		const state = run([
			...opened,
			event({ ...finishedReview, verdict: "unavailable", reason: "no HEAD" } as AtelierEventBody),
		]);
		expect(items(state)).toEqual([
			expect.objectContaining({
				kind: "review",
				reviewId: "r1",
				result: expect.objectContaining({ verdict: "unavailable" }),
			}),
		]);
	});

	it("leaves a task call's subagent alone", () => {
		const state = run([
			...opened,
			event(assessed),
			event({ type: "tool_call_started", callId: "c1", tool: "task", input: {} }),
			event({ type: "text_delta", text: "sub", parentCallId: "c1", agent: "worker" } as unknown as AtelierEventBody),
		]);
		expect(items(state)[0]).toMatchObject({ kind: "review", roles: [] });
		expect(items(state)[1]).toMatchObject({ kind: "tool", subagent: { agent: "worker" } });
	});
});
