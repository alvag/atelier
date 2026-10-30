import { type CompactedParts, compactedText, type FileActivity } from "../../compaction/compactor.ts";
import type { ResponsesItem } from "../../responses/client.ts";

/**
 * The compactor's rules (`compaction/compactor.ts`) on a history of Responses items: where to cut, which files the
 * tools touched, and the history that replaces it. The summary request and its checks are the compactor's own.
 */

/** About four characters per token, of the item as the API takes it: only used to size the verbatim tail. */
export function estimateItem(item: ResponsesItem): number {
	return Math.ceil(JSON.stringify(item).length / 4);
}

const isInput = (item: ResponsesItem | undefined) =>
	item !== undefined && (item.type === "function_call_output" || (item.type === "message" && item.role === "user"));

/** A cut is valid where a response starts after the user's input or a tool's output: every output keeps its call. */
function isCut(items: readonly ResponsesItem[], index: number): boolean {
	return index > 0 && !isInput(items[index]) && isInput(items[index - 1]);
}

/** Index where the verbatim tail starts: the shortest tail that reaches `keepRecent` tokens; undefined when none. */
export function findItemCut(items: readonly ResponsesItem[], keepRecent: number): number | undefined {
	let tail = 0;
	for (let index = items.length - 1; index > 0; index--) {
		tail += estimateItem(items[index] as ResponsesItem);
		if (tail >= keepRecent && isCut(items, index)) return index;
	}
	return undefined;
}

export function userMessage(text: string): ResponsesItem {
	return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/** The history ending in the instruction, as the user's: joined to the last user message when the history ends with one. */
export function withInstruction(items: readonly ResponsesItem[], instruction: string): ResponsesItem[] {
	const last = items.at(-1);
	if (last?.type === "message" && last.role === "user")
		return [...items.slice(0, -1), { ...last, content: [...last.content, { type: "input_text", text: instruction }] }];
	return [...items, userMessage(instruction)];
}

/** The text of an answer's messages. */
export function outputText(items: readonly ResponsesItem[]): string {
	return items
		.flatMap((item) =>
			item.type === "message" ? item.content.flatMap((part) => (part.type === "input_image" ? [] : [part.text])) : [],
		)
		.join("");
}

export function itemFileActivity(
	items: readonly ResponsesItem[],
	previous: FileActivity = { read: [], edited: [] },
): FileActivity {
	const read = new Set(previous.read);
	const edited = new Set(previous.edited);
	for (const item of items) {
		if (item.type !== "function_call") continue;
		let path: unknown;
		try {
			path = (JSON.parse(item.arguments) as { path?: unknown } | null)?.path;
		} catch {
			continue;
		}
		if (typeof path !== "string") continue;
		if (item.name === "read") read.add(path);
		else if (item.name === "edit" || item.name === "write") edited.add(path);
	}
	return { read: [...read].sort(), edited: [...edited].sort() };
}

/** The current turn's request, verbatim, when the message that started the turn falls before the cut. */
export function turnPromptBeforeItem(
	items: readonly ResponsesItem[],
	turnStart: number,
	cut: number,
): string | undefined {
	if (turnStart < 0 || turnStart >= cut) return undefined;
	const item = items[turnStart];
	if (item?.type !== "message") return undefined;
	const text = item.content
		.map((part) =>
			part.type === "input_image" ? "[image omitted: the carried prompt is text-only; see the summary]" : part.text,
		)
		.join("\n\n");
	return text === "" ? undefined : text;
}

/** A new history: the compacted message, then the tail unchanged. */
export function replaceItems(items: readonly ResponsesItem[], cut: number, parts: CompactedParts): ResponsesItem[] {
	if (!isCut(items, cut)) throw new Error(`Invalid compaction cut ${cut}: it must start a response.`);
	return [userMessage(compactedText(parts)), ...items.slice(cut)];
}
