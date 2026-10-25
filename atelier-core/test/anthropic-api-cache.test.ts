import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildRequest, type RequestState, type StoredMessage } from "../src/backends/anthropic-api/backend.ts";
import { BASE_SYSTEM_PROMPT, systemPrompt } from "../src/backends/anthropic-api/system-prompt.ts";
import { toAnthropicTools } from "../src/backends/anthropic-api/tool-schema.ts";
import { coreTools } from "../src/tools/index.ts";

const EPHEMERAL = { type: "ephemeral" };

function state(messages: StoredMessage[], previousMessageId?: string): RequestState {
	return {
		model: "claude-sonnet-5-5",
		maxTokens: 1000,
		system: systemPrompt("/work", ""),
		tools: toAnthropicTools(coreTools),
		messages,
		...(previousMessageId === undefined ? {} : { previousMessageId }),
	};
}

const countBreakpoints = (request: unknown) => JSON.stringify(request).split('"cache_control"').length - 1;

describe("buildRequest cache breakpoints", () => {
	it("marks the last tool, the system block and the last block of the last message", () => {
		const request = buildRequest(
			state([
				{ role: "user", content: [{ type: "text", text: "first" }] },
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tu_1", content: "a" },
						{ type: "text", text: "next" },
					],
				},
			]),
		);
		expect(countBreakpoints(request)).toBe(3);
		const tools = request.tools as Anthropic.Tool[];
		expect(tools.at(-1)?.cache_control).toEqual(EPHEMERAL);
		expect(tools.slice(0, -1).every((tool) => tool.cache_control === undefined)).toBe(true);
		expect(request.system).toEqual([{ type: "text", text: systemPrompt("/work", ""), cache_control: EPHEMERAL }]);
		const last = request.messages.at(-1)?.content as Anthropic.ContentBlockParam[];
		expect(last.at(-1)).toEqual({ type: "text", text: "next", cache_control: EPHEMERAL });
		expect(last[0]).toEqual({ type: "tool_result", tool_use_id: "tu_1", content: "a" });
	});

	it("never writes a breakpoint into the stored history or the frozen prefix", () => {
		const s = state([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		const before = JSON.stringify(s);
		buildRequest(s);
		buildRequest(s);
		expect(JSON.stringify(s)).toBe(before);
	});

	it("keeps three breakpoints however long the history grows", () => {
		const messages: Anthropic.MessageParam[] = [];
		for (let i = 0; i < 30; i++) {
			messages.push({ role: "user", content: [{ type: "text", text: `q${i}` }] });
			messages.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
		}
		messages.push({ role: "user", content: [{ type: "text", text: "last" }] });
		expect(countBreakpoints(buildRequest(state(messages)))).toBe(3);
	});

	it("sends the same tools and system bytes on every request of a session", () => {
		const s = state([{ role: "user", content: [{ type: "text", text: "one" }] }]);
		const first = buildRequest(s);
		s.messages.push({ role: "assistant", content: [{ type: "text", text: "two" }] });
		s.messages.push({ role: "user", content: [{ type: "text", text: "three" }] });
		const second = buildRequest(s);
		expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
		expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
	});

	it("asks for cache diagnostics against the previous response, or opts in with null on the first request", () => {
		expect(buildRequest(state([{ role: "user", content: "hi" }])).diagnostics).toEqual({ previous_message_id: null });
		expect(buildRequest(state([{ role: "user", content: "hi" }], "msg_7")).diagnostics).toEqual({
			previous_message_id: "msg_7",
		});
	});

	it("turns a plain string message into a marked text block", () => {
		const request = buildRequest(state([{ role: "user", content: "hi" }]));
		expect(request.messages[0]?.content).toEqual([{ type: "text", text: "hi", cache_control: EPHEMERAL }]);
	});

	it("keeps the effort each answer was asked with out of the request, and leaves the history as it was", () => {
		const s = {
			...state([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello", effort: "high" },
				{ role: "user", content: "and?" },
				{ role: "assistant", content: "more", effort: "high" },
			]),
			effort: "high" as const,
		};
		const request = buildRequest(s);
		expect(request.output_config).toEqual({ effort: "high" });
		expect(JSON.stringify(request.messages)).not.toContain("effort");
		expect(s.messages[1]).toEqual({ role: "assistant", content: "hello", effort: "high" });
	});
});

describe("system prompt", () => {
	it("stays small: it is sent, and cached, on every request", () => {
		expect(Buffer.byteLength(BASE_SYSTEM_PROMPT, "utf8")).toBeLessThanOrEqual(1024);
	});

	it("contains nothing that changes between turns", () => {
		expect(systemPrompt("/work", "x")).toBe(systemPrompt("/work", "x"));
		expect(BASE_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});
});
