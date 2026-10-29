import { type JsonValue, visibleText } from "@atelier/core";

/** The name of the core's memory tool, whose calls both clients show their own way. */
export const MEMORY_TOOL = "memory";

const shown = (text: string) => visibleText(text).text;

/** A memory call's action and what it is about: the query or the title, on one line, or the id as `#7`. */
export function memoryCall(input: JsonValue): { action: string; subject?: string; quoted: boolean } {
	const record: { [key: string]: JsonValue } =
		typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
	const text = (name: string) => {
		const value = record[name];
		return typeof value === "string" ? value : undefined;
	};
	const action = shown(text("action") ?? "");
	if (action === "get") {
		const id = record.id;
		return { action, ...(typeof id === "number" ? { subject: `#${id}` } : {}), quoted: false };
	}
	const subject = text(action === "save" ? "title" : "query");
	if (subject === undefined) return { action, quoted: false };
	return { action, subject: shown(subject).replace(/\s+/g, " ").trim(), quoted: true };
}

/** `search "query"`, `get #7`, `save "title"`, whole. */
export function memoryCallText(input: JsonValue): string {
	const { action, subject, quoted } = memoryCall(input);
	if (subject === undefined) return action;
	return `${action} ${quoted ? `"${subject}"` : subject}`;
}

/** What a memory call came to: `saved #5518` and its warning apart, or the entry read without its id again. */
export function memoryOutcome(input: JsonValue, summary: string): { outcome: string; warning?: string } {
	const saved = /^Saved memory #(\d+)\.(?: Warning: (.*))?$/s.exec(summary);
	if (saved) return { outcome: `saved #${saved[1]}`, ...(saved[2] === undefined ? {} : { warning: shown(saved[2]) }) };
	const { action, subject } = memoryCall(input);
	if (action === "get" && subject !== undefined && summary.startsWith(`${subject} `))
		return { outcome: shown(summary.slice(subject.length + 1)) };
	return { outcome: shown(summary) };
}
