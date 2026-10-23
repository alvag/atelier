import { readFile } from "node:fs/promises";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { mapSdkMessage } from "../src/backends/claude-code/map.ts";

// "text-and-tool-turn" is hand-written to cover cases a real run may not hit (thinking).
// "recorded-opus-email-validation" is a real Claude Code 0.3.308 session (paths redacted),
// recorded with ATELIER_RECORD_SDK while running the M1 example prompt.
async function fixture(name: string): Promise<SDKMessage[]> {
	const text = await readFile(new URL(`./fixtures/claude-code/${name}.jsonl`, import.meta.url), "utf8");
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SDKMessage);
}

function msg(value: Record<string, unknown>): SDKMessage {
	return { uuid: "u", session_id: "s", ...value } as unknown as SDKMessage;
}

const context = { previousCostUsd: 0 };

describe("mapSdkMessage", () => {
	it("maps a recorded turn with thinking, text, a tool call and usage", async () => {
		const events = (await fixture("text-and-tool-turn")).flatMap((m) => mapSdkMessage(m, context));
		expect(events).toEqual([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "other" },
			{ type: "rate_limit", status: "allowed", resetsAt: 1792000000, window: "five_hour" },
			{ type: "thinking_delta", text: "Need to read the file." },
			{ type: "text_delta", text: "Let me " },
			{ type: "text_delta", text: "look." },
			{ type: "text_delta", text: "Done." },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1200, output: 85, cacheRead: 9000, cacheWrite: 3100 },
				costUsd: 0.0421,
				requests: 2,
			},
		]);
	});

	it("reports the cost of this turn, not the running total", () => {
		const [event] = mapSdkMessage(
			msg({
				type: "result",
				subtype: "success",
				is_error: false,
				stop_reason: "end_turn",
				total_cost_usd: 0.1,
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
			{ previousCostUsd: 0.04 },
		);
		expect(event).toMatchObject({ type: "turn_finished" });
		expect((event as { costUsd: number }).costUsd).toBeCloseTo(0.06);
	});

	it.each([
		["none", "other"],
		["ANTHROPIC_API_KEY", "api_key"],
		["apiKeyHelper", "api_key"],
		["/login managed key", "api_key"],
	])("maps apiKeySource %s to authSource %s", (apiKeySource, authSource) => {
		const events = mapSdkMessage(
			msg({
				type: "system",
				subtype: "init",
				apiKeySource,
				model: "opus",
				mcp_servers: [{ name: "atelier", status: "connected" }],
			}),
			context,
		);
		expect(events).toEqual([{ type: "session_started", backend: "claude-code", model: "opus", authSource }]);
	});

	it("reports when the atelier tool server did not connect", () => {
		const events = mapSdkMessage(
			msg({
				type: "system",
				subtype: "init",
				apiKeySource: "none",
				model: "opus",
				mcp_servers: [{ name: "atelier", status: "failed" }],
			}),
			context,
		);
		expect(events[1]).toEqual({
			type: "error",
			code: "tools_unavailable",
			message: "Atelier tools are not available to Claude Code (MCP server status: failed).",
			recoverable: false,
		});
	});

	it("ignores streamed text from subagents", () => {
		expect(
			mapSdkMessage(
				msg({
					type: "stream_event",
					parent_tool_use_id: "toolu_x",
					event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
				}),
				context,
			),
		).toEqual([]);
	});

	it("tells the user to log in when authentication fails", () => {
		const events = mapSdkMessage(
			msg({
				type: "assistant",
				parent_tool_use_id: null,
				error: "authentication_failed",
				message: { content: [{ type: "text", text: "Invalid API key" }] },
			}),
			context,
		);
		expect(events).toEqual([
			{
				type: "error",
				code: "not_logged_in",
				message: "Claude Code is not logged in. Run `claude`, use /login, and try again.",
				recoverable: false,
			},
		]);
	});

	it.each([
		["rate_limit", true],
		["overloaded", true],
		["server_error", true],
		["billing_error", false],
	])("marks the API error %s as recoverable=%s", (error, recoverable) => {
		const [event] = mapSdkMessage(
			msg({
				type: "assistant",
				parent_tool_use_id: null,
				error,
				message: { content: [{ type: "text", text: "API Error: boom" }] },
			}),
			context,
		);
		expect(event).toEqual({ type: "error", code: `api_${error}`, message: "API Error: boom", recoverable });
	});

	it("ends the turn with an error when the result is an error", () => {
		const events = mapSdkMessage(
			msg({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				stop_reason: null,
				total_cost_usd: 0,
				errors: ["Request was aborted."],
				usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
			context,
		);
		expect(events).toEqual([
			{ type: "error", code: "error_during_execution", message: "Request was aborted.", recoverable: true },
			{
				type: "turn_finished",
				stopReason: "error_during_execution",
				usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
				costUsd: 0,
			},
		]);
	});

	it("ignores messages it does not need", () => {
		for (const type of ["user", "tool_progress", "prompt_suggestion"]) {
			expect(mapSdkMessage(msg({ type }), context)).toEqual([]);
		}
		expect(mapSdkMessage(msg({ type: "system", subtype: "status", status: null }), context)).toEqual([]);
	});

	it("maps a real recorded session", async () => {
		const events = (await fixture("recorded-opus-email-validation")).flatMap((m) => mapSdkMessage(m, context));
		const nonText = events.filter((e) => e.type !== "text_delta" && e.type !== "thinking_delta");
		expect(nonText).toEqual([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "other" },
			{ type: "rate_limit", status: "allowed", resetsAt: 1792685400, window: "five_hour" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 8, output: 1218, cacheRead: 12508, cacheWrite: 5536 },
				costUsd: 0.0711816,
				// num_turns counts the turn's model requests, not the session's (checked on a real two-turn run).
				requests: 6,
			},
		]);
		const text = events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
		expect(text.startsWith("Agregué la validación de email y los 3 tests pasan.")).toBe(true);
	});

	it("produces JSON-only events", async () => {
		const events = (await fixture("text-and-tool-turn")).flatMap((m) => mapSdkMessage(m, context));
		expect(JSON.parse(JSON.stringify(events))).toEqual(events);
	});

	it.each([
		{ trigger: "auto", reason: "threshold", post: 30_000 },
		{ trigger: "manual", reason: "manual", post: undefined },
	])("turns a $trigger compact_boundary into a finished compaction", ({ trigger, reason, post }) => {
		const message = msg({
			type: "system",
			subtype: "compact_boundary",
			compact_metadata: { trigger, pre_tokens: 180_000, ...(post === undefined ? {} : { post_tokens: post }) },
		});
		expect(mapSdkMessage(message, { previousCostUsd: 0 })).toEqual([
			{ type: "compaction_started", reason, tokens: 180_000 },
			{
				type: "compaction_finished",
				ok: true,
				reason,
				tokensBefore: 180_000,
				...(post === undefined ? {} : { tokensAfter: post }),
				kept: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]);
	});
});
