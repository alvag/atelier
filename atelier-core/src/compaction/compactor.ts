import type Anthropic from "@anthropic-ai/sdk";
import { buildRequest, type RequestState } from "../backends/anthropic-api/backend.ts";
import type { Usage } from "../events.ts";
import { MAX_COMPACT_INSTRUCTIONS_BYTES } from "../protocol/types.ts";

/**
 * Context compaction for the anthropic-api backend, as pure functions: when to
 * compact, where to cut, how to ask for the summary and how to rebuild the
 * history. The backend makes the request and owns the history (M8).
 */

/** Room kept below the window: compaction starts when the context passes `window − RESERVE_TOKENS`. */
export const RESERVE_TOKENS = 16_384;
/** Size of the history tail that stays verbatim. */
export const KEEP_RECENT_TOKENS = 20_000;
export const MAX_INSTRUCTIONS_BYTES = MAX_COMPACT_INSTRUCTIONS_BYTES;

export const SUMMARY_HEADINGS = [
	"## Goal",
	"## Constraints & Preferences",
	"## Progress",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
] as const;

export const COMPACTED_HEADER = "The conversation history before this point was compacted into the following summary:";

export const SUMMARY_INSTRUCTION = `Summarize the conversation above so that work can continue from the summary alone. Do not continue the conversation and do not call tools: output only the summary, in exactly this format:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Keep each section concise. Preserve exact file paths, function names and error messages. If the conversation begins with a summary of earlier history, update that summary with what happened since instead of starting over.`;

/** Paths touched by the read, edit and write tools, extracted by the core rather than by the model. */
export interface FileActivity {
	read: string[];
	edited: string[];
}

/** Tokens the next request carries: everything this response read plus what it wrote. */
export function contextTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * Where compaction starts: the window minus the reserve, and minus `outputReserve` for a backend that sends no output
 * cap. `override` (ATELIER_COMPACT_AT) sets it lower, never higher: past it compaction would never start.
 */
export function compactThreshold(options: {
	window: number;
	outputReserve?: number | undefined;
	override?: number | undefined;
}): number {
	const limit = options.window - ((options.outputReserve ?? 0) + RESERVE_TOKENS);
	return options.override === undefined ? limit : Math.min(limit, options.override);
}

/** Reads `ATELIER_COMPACT_AT`; a value that is set but invalid is an error, never a silent default. */
export function parseCompactAt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^[1-9]\d*$/.test(trimmed))
		throw new Error(`ATELIER_COMPACT_AT must be a positive integer number of tokens, got ${JSON.stringify(value)}.`);
	return Number(trimmed);
}

// A coarse allowance until API usage measures the image; encoded bytes are not text tokens.
export const IMAGE_TOKENS = 8_192;

/** How the current model sees images: an `omission` text stands in for each when it accepts none. */
export interface ImageView {
	omission?: string | undefined;
	/** A transport-specific omission for a file source, when the model otherwise accepts images. */
	fileOmission?: string | undefined;
	/** False leaves the allowance out: the size the text alone is known to have. */
	allowance?: boolean;
}

/** Four text characters per token, plus an allowance per native image, including nested tool results. */
export function estimateTokens(message: Anthropic.MessageParam, view: ImageView = {}): number {
	let images = 0;
	const imageText = (image: Anthropic.ImageBlockParam): Anthropic.TextBlockParam[] => {
		const omission = view.omission ?? (image.source.type === "file" ? view.fileOmission : undefined);
		if (omission !== undefined) return [{ type: "text", text: omission }];
		images++;
		return [];
	};
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block): Anthropic.ContentBlockParam[] => {
					if (block.type === "image") return imageText(block);
					if (block.type === "tool_result" && Array.isArray(block.content)) {
						const parts = block.content;
						return [
							{
								...block,
								content: parts.flatMap<(typeof parts)[number]>((part) =>
									part.type === "image" ? imageText(part) : [part],
								),
							},
						];
					}
					return [block];
				});
	return (
		Math.ceil(JSON.stringify({ role: message.role, content }).length / 4) +
		(view.allowance === false ? 0 : images * IMAGE_TOKENS)
	);
}

/** A cut is valid before an assistant message that follows a user message: both sides stay well formed. */
function isCut(messages: readonly Anthropic.MessageParam[], index: number): boolean {
	return index > 0 && messages[index]?.role === "assistant" && messages[index - 1]?.role === "user";
}

/**
 * Index of the assistant message where the verbatim tail starts: the shortest
 * tail that reaches `keepRecent` tokens. Every tool_result in the tail keeps its
 * tool_use, because a tool_use is always in the assistant message right before.
 * Undefined when no cut leaves something to summarize.
 */
export function findCut(
	messages: readonly Anthropic.MessageParam[],
	keepRecent: number = KEEP_RECENT_TOKENS,
	view: ImageView = {},
): number | undefined {
	let tail = 0;
	for (let index = messages.length - 1; index > 0; index--) {
		tail += estimateTokens(messages[index] as Anthropic.MessageParam, view);
		if (tail >= keepRecent && isCut(messages, index)) return index;
	}
	return undefined;
}

function assertCut(messages: readonly Anthropic.MessageParam[], cut: number): void {
	if (!isCut(messages, cut)) throw new Error(`Invalid compaction cut ${cut}: it must be before an assistant message.`);
}

function blocksOf(message: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/** The instruction that asks for the summary, with the user's own `/compact` instructions after it. */
export function summaryInstruction(instructions?: string): string {
	if (instructions !== undefined && Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTIONS_BYTES)
		throw new Error(`Compaction instructions must be at most ${MAX_INSTRUCTIONS_BYTES} bytes.`);
	return instructions?.trim() ? `${SUMMARY_INSTRUCTION}\n\n${instructions.trim()}` : SUMMARY_INSTRUCTION;
}

/**
 * The summary request: the session's own prefix up to the cut, so it reads the
 * cache written by the request that ended there, plus the instruction as an
 * unmarked block after the breakpoint. Nothing in `state` is modified.
 */
export function buildSummaryRequest(
	state: RequestState,
	cut: number,
	instructions?: string,
): Anthropic.MessageCreateParamsNonStreaming {
	assertCut(state.messages, cut);
	const instruction = summaryInstruction(instructions);
	const { diagnostics: _none, ...request } = buildRequest({ ...state, messages: state.messages.slice(0, cut) });
	const last = request.messages.at(-1) as Anthropic.MessageParam;
	return {
		...request,
		messages: [
			...request.messages.slice(0, -1),
			{ role: "user", content: [...blocksOf(last), { type: "text", text: instruction }] },
		],
		tool_choice: { type: "none" },
	};
}

/**
 * The summary request over the whole history, to hand the conversation to another backend: nothing stays verbatim,
 * so there is no cut. The instruction follows the history as a user message of its own when the history ends with
 * the assistant, and joins the last user message otherwise.
 */
export function buildHandoffRequest(state: RequestState): Anthropic.MessageCreateParamsNonStreaming {
	const { diagnostics: _none, ...request } = buildRequest(state);
	const last = request.messages.at(-1) as Anthropic.MessageParam;
	const instruction: Anthropic.TextBlockParam = { type: "text", text: SUMMARY_INSTRUCTION };
	const messages =
		last.role === "user"
			? [...request.messages.slice(0, -1), { role: "user" as const, content: [...blocksOf(last), instruction] }]
			: [...request.messages, { role: "user" as const, content: [instruction] }];
	return { ...request, messages, tool_choice: { type: "none" } };
}

export type SummaryCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Only a complete summary replaces history: one cut by max_tokens, empty, or missing a section is rejected. */
export function validateSummary(message: Pick<Anthropic.Message, "content" | "stop_reason">): SummaryCheck {
	if (message.stop_reason !== "end_turn")
		return { ok: false, reason: `The summary stopped with ${message.stop_reason ?? "no stop reason"}.` };
	return checkSummaryText(message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
}

/** A finished summary's text, checked for every section. */
export function checkSummaryText(raw: string): SummaryCheck {
	const text = raw.trim();
	if (text === "") return { ok: false, reason: "The summary is empty." };
	const missing = SUMMARY_HEADINGS.filter((heading) => !new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m").test(text));
	if (missing.length > 0) return { ok: false, reason: `The summary lacks ${missing.join(", ")}.` };
	return { ok: true, text };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fileActivity(
	messages: readonly Anthropic.MessageParam[],
	previous: FileActivity = { read: [], edited: [] },
): FileActivity {
	const read = new Set(previous.read);
	const edited = new Set(previous.edited);
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of blocksOf(message)) {
			if (block.type !== "tool_use") continue;
			const path = (block.input as { path?: unknown } | null)?.path;
			if (typeof path !== "string") continue;
			if (block.name === "read") read.add(path);
			else if (block.name === "edit" || block.name === "write") edited.add(path);
		}
	}
	return { read: [...read].sort(), edited: [...edited].sort() };
}

/** The current turn's request, verbatim, when the message that started the turn falls before the cut. */
export function turnPromptBefore(
	messages: readonly Anthropic.MessageParam[],
	turnStart: number,
	cut: number,
): string | undefined {
	if (turnStart >= cut) return undefined;
	const message = messages[turnStart];
	if (message === undefined) return undefined;
	const text = blocksOf(message)
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n\n");
	return text === "" ? undefined : text;
}

/** The files read and edited, as the summary message lists them. */
export function filesSection(files: FileActivity): string {
	const list = (paths: string[]) => (paths.length === 0 ? "(none)" : paths.join(", "));
	return `## Files\nRead: ${list(files.read)}\nEdited: ${list(files.edited)}`;
}

/** A new history: one user message with the summary, then the tail unchanged. The input is not modified. */
export function replaceHistory(
	messages: readonly Anthropic.MessageParam[],
	cut: number,
	options: CompactedParts,
): Anthropic.MessageParam[] {
	assertCut(messages, cut);
	return [{ role: "user", content: [{ type: "text", text: compactedText(options) }] }, ...messages.slice(cut)];
}

export interface CompactedParts {
	summary: string;
	files: FileActivity;
	turnPrompt?: string | undefined;
	state?: string | undefined;
}

/** The message that replaces the history before the cut: the summary, the files, the turn's request, the core's state. */
export function compactedText(options: CompactedParts): string {
	const parts = [`${COMPACTED_HEADER}\n\n<summary>\n${options.summary}\n</summary>`, filesSection(options.files)];
	if (options.turnPrompt !== undefined)
		parts.push(`The user's request for the current turn, verbatim:\n<request>\n${options.turnPrompt}\n</request>`);
	if (options.state !== undefined) parts.push(options.state);
	return parts.join("\n\n");
}
