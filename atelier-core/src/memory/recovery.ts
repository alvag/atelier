import { visibleText } from "../text.ts";

/** How saving a compaction summary to memory ended: what the agent is told to do about it after the compaction. */
export type SummaryOutcome = "saved" | "uncertain" | "failed" | "skipped";

/**
 * What goes before the first prompt after a compaction: the recent memory of the project, when it came, and what to
 * do about the summary, so the agent neither loses it nor saves it twice. `key` is the summary's topic key.
 */
export function recoveryNotice(project: string, context: string, outcome: SummaryOutcome, key: string): string {
	const recent = context.trim();
	const lines = [
		"<memory-recovery>",
		recent === ""
			? "The conversation was compacted."
			: `The conversation was compacted. Recent memory of project ${project}:\n${recent}`,
		instruction(outcome, key),
		"</memory-recovery>",
	];
	return lines.join("\n");
}

function instruction(outcome: SummaryOutcome, key: string): string {
	switch (outcome) {
		case "saved":
			return "The compaction summary is already in memory; do not save it again.";
		case "uncertain":
			return "It is unclear whether the compaction summary was saved to memory. Do not save it again blindly: search memory for it first and save it once only if it is absent.";
		case "failed":
			return `The compaction summary was not saved to memory. Save its key points once with the memory tool, under topicKey ${key}.`;
		case "skipped":
			return "The compaction summary was not saved to memory because it contains what looks like a credential; do not save it.";
	}
}

/** The longest preview of a saved summary, in characters, the ellipsis included. */
export const SUMMARY_PREVIEW_CHARS = 120;

/**
 * The summary's first line that says something, as plain text: hidden characters as markers, blanks as one space, cut
 * with `…` past `SUMMARY_PREVIEW_CHARS`.
 */
export function summaryPreview(summary: string): string {
	const line = summary.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	const plain = visibleText(line).text.replace(/\s+/g, " ").trim();
	const chars = [...plain];
	if (chars.length <= SUMMARY_PREVIEW_CHARS) return plain;
	return `${chars.slice(0, SUMMARY_PREVIEW_CHARS - 1).join("")}…`;
}
