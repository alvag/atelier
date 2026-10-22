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
