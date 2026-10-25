import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { RequestState } from "../src/backends/anthropic-api/backend.ts";
import { systemPrompt } from "../src/backends/anthropic-api/system-prompt.ts";
import { toAnthropicTools } from "../src/backends/anthropic-api/tool-schema.ts";
import {
	buildSummaryRequest,
	COMPACTED_HEADER,
	compactThreshold,
	contextTokens,
	estimateTokens,
	fileActivity,
	findCut,
	parseCompactAt,
	replaceHistory,
	SUMMARY_HEADINGS,
	turnPromptBefore,
	validateSummary,
} from "../src/compaction/compactor.ts";
import { coreTools } from "../src/tools/index.ts";

const EPHEMERAL = { type: "ephemeral" };
type Message = Anthropic.MessageParam;

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
const toolUse = (id: string, name: string, input: Record<string, unknown>, text = ""): Message => ({
	role: "assistant",
	content: [...(text ? [{ type: "text" as const, text }] : []), { type: "tool_use", id, name, input }],
});
const toolResult = (id: string, output: string): Message => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, content: output }],
});

/** A single turn: the user's prompt, then `pairs` tool calls of about `size` characters each. */
function longTurn(prompt: string, pairs: number, size: number): Message[] {
	const messages: Message[] = [user(prompt)];
	for (let i = 0; i < pairs; i++) {
		messages.push(toolUse(`tu_${i}`, "read", { path: `src/f${i}.ts` }));
		messages.push(toolResult(`tu_${i}`, "x".repeat(size)));
	}
	messages.push(assistant("done"));
	return messages;
}

function state(messages: Message[]): RequestState {
	return {
		model: "claude-sonnet-5-5",
		maxTokens: 16_000,
		system: systemPrompt("/work", ""),
		tools: toAnthropicTools(coreTools),
		messages,
		previousMessageId: "msg_1",
	};
}

const toolUseIds = (messages: Message[]) =>
	messages.flatMap((m) =>
		typeof m.content === "string" ? [] : m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])),
	);
const toolResultIds = (messages: Message[]) =>
	messages.flatMap((m) =>
		typeof m.content === "string" ? [] : m.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])),
	);
function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function expectValidHistory(messages: Message[]): void {
	expect(messages[0]?.role).toBe("user");
	for (let i = 1; i < messages.length; i++) expect(messages[i]?.role).not.toBe(messages[i - 1]?.role);
	const uses = new Set(toolUseIds(messages));
	for (const id of toolResultIds(messages)) expect(uses.has(id)).toBe(true);
}

const VALID_SUMMARY = SUMMARY_HEADINGS.map((heading) => `${heading}\n- item`).join("\n\n");

describe("context measurement and threshold", () => {
	it("counts everything the next request carries, from the real usage", () => {
		expect(contextTokens({ input: 10, output: 5, cacheRead: 1000, cacheWrite: 200 })).toBe(1215);
	});

	it.each([
		{ window: 200_000, maxTokens: 16_000, override: undefined, expected: 200_000 - 16_000 - 16_384 },
		{ window: 1_000_000, maxTokens: 16_000, override: undefined, expected: 200_000 },
		{ window: 216_384, maxTokens: 0, override: undefined, expected: 200_000 },
		{ window: 1_000_000, maxTokens: 16_000, override: 50_000, expected: 50_000 },
		// An override above what the window allows would turn compaction off: it is capped like the default.
		{ window: 200_000, maxTokens: 16_000, override: 500_000, expected: 200_000 - 16_000 - 16_384 },
		{ window: 1_000_000, maxTokens: 16_000, override: 400_000, expected: 400_000 },
	])("window $window, maxTokens $maxTokens, override $override → $expected", ({ expected, ...input }) => {
		expect(compactThreshold(input)).toBe(expected);
	});

	it.each([
		{ value: undefined, expected: undefined },
		{ value: "120000", expected: 120_000 },
		{ value: " 90000 ", expected: 90_000 },
	])("ATELIER_COMPACT_AT=$value → $expected", ({ value, expected }) => {
		expect(parseCompactAt(value)).toBe(expected);
	});

	it.each(["", "0", "-5", "12.5", "abc", "1e5", "100k"])(
		"rejects ATELIER_COMPACT_AT=%j with a clear error",
		(value) => {
			expect(() => parseCompactAt(value)).toThrow(/ATELIER_COMPACT_AT must be a positive integer/);
		},
	);

	it("estimates a message at about four characters per token", () => {
		const message = user("x".repeat(4000));
		expect(estimateTokens(message)).toBe(Math.ceil(JSON.stringify(message).length / 4));
	});

	it("sizes a message as the API takes it, without the effort Atelier keeps next to it", () => {
		const answer = { role: "assistant" as const, content: "y".repeat(400) };
		expect(estimateTokens({ ...answer, effort: "xhigh" } as Anthropic.MessageParam)).toBe(estimateTokens(answer));
	});
});

describe("findCut", () => {
	it("cuts a long single turn before an assistant, keeping each tool result with its call", () => {
		const messages = longTurn("Refactor the parser", 40, 8000);
		const cut = findCut(messages, 20_000);
		expect(cut).toBeDefined();
		const at = cut as number;
		expect(messages[at]?.role).toBe("assistant");
		expect(messages[at - 1]?.role).toBe("user");
		const tail = messages.slice(at);
		const tailTokens = tail.reduce((sum, m) => sum + estimateTokens(m), 0);
		expect(tailTokens).toBeGreaterThanOrEqual(20_000);
		// Shortest such tail: dropping its first exchange falls below keepRecent.
		const shorter = tail.slice(2).reduce((sum, m) => sum + estimateTokens(m), 0);
		expect(shorter).toBeLessThan(20_000);
		const uses = new Set(toolUseIds(tail));
		for (const id of toolResultIds(tail)) expect(uses.has(id)).toBe(true);
	});

	it("cuts across turns in a multi-turn history", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 20; i++) messages.push(user(`question ${i} ${"q".repeat(4000)}`), assistant("a".repeat(4000)));
		messages.push(user("last question"));
		const cut = findCut(messages, 20_000) as number;
		expect(messages[cut]?.role).toBe("assistant");
		expect(cut).toBeGreaterThan(0);
		expect(cut).toBeLessThan(messages.length - 1);
	});

	it.each([
		{ name: "one exchange", messages: [user("hi"), assistant("hello")] },
		{ name: "only a prompt", messages: [user("hi")] },
		{ name: "a history smaller than the tail", messages: longTurn("small", 2, 100) },
		{ name: "no messages", messages: [] },
	])("has no valid cut for $name", ({ messages }) => {
		expect(findCut(messages, 20_000)).toBeUndefined();
	});

	it("always keeps at least the last assistant message", () => {
		const messages = [user("a".repeat(400_000)), assistant("b".repeat(400_000)), user("c")];
		expect(findCut(messages, 1)).toBe(1);
	});
});

describe("buildSummaryRequest", () => {
	const messages = longTurn("Refactor the parser", 10, 100);
	const cut = 7;

	it("sends the session's prefix up to the cut and leaves the state untouched", () => {
		const s = state(messages);
		const before = JSON.stringify(s);
		const request = buildSummaryRequest(s, cut);
		expect(JSON.stringify(s)).toBe(before);
		expect(request.model).toBe(s.model);
		expect(request.system).toEqual([{ type: "text", text: s.system, cache_control: EPHEMERAL }]);
		expect((request.tools as Anthropic.Tool[]).at(-1)?.cache_control).toEqual(EPHEMERAL);
		expect(request.messages).toHaveLength(cut);
		expect(request.tool_choice).toEqual({ type: "none" });
	});

	it("reads the cache at the end of an earlier request and adds the instruction after it, unmarked", () => {
		const request = buildSummaryRequest(state(messages), cut);
		const last = request.messages.at(-1) as Anthropic.MessageParam;
		expect(last.role).toBe("user");
		const blocks = last.content as Anthropic.ContentBlockParam[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tu_2",
			content: "x".repeat(100),
			cache_control: EPHEMERAL,
		});
		expect(blocks[1]?.type).toBe("text");
		expect("cache_control" in (blocks[1] as object)).toBe(false);
		const breakpoints = JSON.stringify(request).split('"cache_control"').length - 1;
		expect(breakpoints).toBe(3);
	});

	it("asks for the fixed format, exact names, and an update of an earlier summary", () => {
		const request = buildSummaryRequest(state(messages), cut);
		const instruction = textOf(request.messages.at(-1));
		for (const heading of [...SUMMARY_HEADINGS, "### Done", "### In Progress", "### Blocked"])
			expect(instruction).toContain(heading);
		expect(instruction).toMatch(/exact file paths, function names and error messages/);
		expect(instruction).toMatch(/update that summary/i);
		expect(instruction).toMatch(/do not continue the conversation/i);
	});

	it("appends the user's instructions, up to 2000 bytes", () => {
		const request = buildSummaryRequest(state(messages), cut, "Keep the API decisions.");
		expect(textOf(request.messages.at(-1))).toContain("Keep the API decisions.");
		expect(() => buildSummaryRequest(state(messages), cut, "é".repeat(1001))).toThrow(/2000 bytes/);
		expect(() => buildSummaryRequest(state(messages), cut, "x".repeat(2000))).not.toThrow();
	});

	it("refuses a cut that is not before an assistant message", () => {
		expect(() => buildSummaryRequest(state(messages), 2)).toThrow(/cut/);
		expect(() => buildSummaryRequest(state(messages), 0)).toThrow(/cut/);
	});
});

describe("validateSummary", () => {
	const response = (text: string, stop: Anthropic.StopReason = "end_turn") => ({
		stop_reason: stop,
		content: [{ type: "text" as const, text, citations: null }],
	});

	it.each([
		{ name: "cut by max_tokens", message: response(VALID_SUMMARY, "max_tokens"), reason: /max_tokens/ },
		{ name: "empty", message: response("   "), reason: /empty/ },
		{
			name: "missing a section",
			message: response(VALID_SUMMARY.replace("## Key Decisions", "")),
			reason: /## Key Decisions/,
		},
	])("rejects a summary that is $name", ({ message, reason }) => {
		const result = validateSummary(message);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(reason);
	});

	it("accepts a complete summary and returns its trimmed text", () => {
		expect(validateSummary(response(`\n${VALID_SUMMARY}\n`))).toEqual({ ok: true, text: VALID_SUMMARY });
	});
});

describe("fileActivity", () => {
	it("collects read and edited paths from our tools, cumulative, deduplicated and sorted", () => {
		const messages: Message[] = [
			user("go"),
			toolUse("a", "read", { path: "src/b.ts" }),
			toolResult("a", "..."),
			toolUse("b", "edit", { path: "src/a.ts", edits: [] }),
			toolResult("b", "ok"),
			toolUse("c", "read", { path: "src/b.ts" }),
			toolResult("c", "..."),
			toolUse("d", "bash", { command: "ls" }),
			toolResult("d", "..."),
		];
		expect(fileActivity(messages, { read: ["src/z.ts"], edited: ["src/a.ts"] })).toEqual({
			read: ["src/b.ts", "src/z.ts"],
			edited: ["src/a.ts"],
		});
		expect(fileActivity([])).toEqual({ read: [], edited: [] });
	});
});

describe("fileActivity with write", () => {
	it("counts a file created or replaced with write as edited", () => {
		const messages: Message[] = [
			user("go"),
			toolUse("a", "write", { path: "src/new.ts", content: "x" }),
			toolResult("a", "ok"),
			toolUse("b", "edit", { path: "src/a.ts", edits: [] }),
			toolResult("b", "ok"),
			toolUse("c", "write", { path: "src/a.ts", content: "y" }),
			toolResult("c", "ok"),
		];
		expect(fileActivity(messages)).toEqual({ read: [], edited: ["src/a.ts", "src/new.ts"] });
	});
});

describe("replaceHistory", () => {
	const messages = longTurn("Refactor the parser\nkeeping the API", 10, 100);
	const cut = 7;
	const files = { read: ["src/f0.ts"], edited: [] };

	it("returns one summary message followed by the unchanged tail, without touching the input", () => {
		const before = JSON.stringify(messages);
		const result = replaceHistory(messages, cut, { summary: VALID_SUMMARY, files });
		expect(JSON.stringify(messages)).toBe(before);
		expect(result).toHaveLength(1 + messages.length - cut);
		expect(result.slice(1)).toEqual(messages.slice(cut));
		const text = textOf(result[0]);
		expect(text.startsWith(COMPACTED_HEADER)).toBe(true);
		expect(text).toContain(`<summary>\n${VALID_SUMMARY}\n</summary>`);
		expect(text).toContain("## Files\nRead: src/f0.ts\nEdited: (none)");
		expectValidHistory(result);
	});

	it("keeps the current turn's request verbatim when it falls in the summarized part", () => {
		const prompt = turnPromptBefore(messages, 0, cut);
		expect(prompt).toBe("Refactor the parser\nkeeping the API");
		expect(turnPromptBefore(messages, 9, cut)).toBeUndefined();
		const text = textOf(replaceHistory(messages, cut, { summary: VALID_SUMMARY, files, turnPrompt: prompt })[0]);
		expect(text).toContain("<request>\nRefactor the parser\nkeeping the API\n</request>");
	});

	it("gives the core's state once", () => {
		const state = "<state>\nfeature: odd/tasks/x.md\n</state>";
		const text = textOf(replaceHistory(messages, cut, { summary: VALID_SUMMARY, files, state })[0]);
		expect(text.split(state)).toHaveLength(2);
		expect(textOf(replaceHistory(messages, cut, { summary: VALID_SUMMARY, files })[0])).not.toContain("<state>");
	});

	it("compacts a long turn into a valid history", () => {
		const turn = longTurn("Refactor the parser", 40, 8000);
		const at = findCut(turn, 20_000) as number;
		const prompt = turnPromptBefore(turn, 0, at);
		const result = replaceHistory(turn, at, {
			summary: VALID_SUMMARY,
			files: fileActivity(turn.slice(0, at)),
			...(prompt ? { turnPrompt: prompt } : {}),
		});
		expectValidHistory(result);
		expect(textOf(result[0])).toContain("<request>\nRefactor the parser\n</request>");
	});
});
