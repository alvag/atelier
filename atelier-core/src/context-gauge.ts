import type { ContextUsage } from "./events.ts";

/**
 * How full the context is, as every client shows it: the bar and the percentage are the share of the window, as pi
 * shows them; the level and the warning measure how close compaction is, so they mean the same when a backend
 * compacts far below its window.
 */

export type ContextLevel = "normal" | "warning" | "danger";

export interface ContextGauge {
	/** Eight cells, filled by the share of the window; empty while the size is unknown. */
	bar: string;
	/** The share of the window, rounded; absent while the size is unknown. */
	percent?: number;
	/** The window's size, as `1M` or `200k`. */
	window: string;
	/** `warning` past 70% of where it compacts, `danger` past 90%. */
	level: ContextLevel;
	/** `▰▱▱▱▱▱▱▱ 11% · 1M`, or `▱▱▱▱▱▱▱▱ ? · 1M` while the size is unknown. */
	text: string;
}

const CELLS = 8;
const WARNING_SHARE = 0.7;
const DANGER_SHARE = 0.9;
/** The share of the compaction point that brings the one-time warning. */
export const CONTEXT_WARNING_SHARE = 0.9;

const numbers = new Intl.NumberFormat("en-US");

/** `1M`, `1.5M`, `200k`, `131k`: a window's size in a few characters. */
export function windowSize(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

export function contextGauge(context: ContextUsage): ContextGauge {
	const window = windowSize(context.window);
	if (context.unknown)
		return { bar: "▱".repeat(CELLS), window, level: "normal", text: `${"▱".repeat(CELLS)} ? · ${window}` };
	const share = context.window > 0 ? context.tokens / context.window : 0;
	const filled = Math.min(CELLS, Math.max(0, Math.round(share * CELLS)));
	const bar = "▰".repeat(filled) + "▱".repeat(CELLS - filled);
	const percent = Math.round(share * 100);
	return { bar, percent, window, level: contextLevel(context), text: `${bar} ${percent}% · ${window}` };
}

function contextLevel({ tokens, compactAt }: ContextUsage): ContextLevel {
	if (compactAt <= 0) return "normal";
	if (tokens > compactAt * DANGER_SHARE) return "danger";
	return tokens > compactAt * WARNING_SHARE ? "warning" : "normal";
}

/** Whether a measured context has reached the point of the one-time warning. */
export const nearCompaction = ({ tokens, compactAt, unknown }: ContextUsage): boolean =>
	!unknown && compactAt > 0 && tokens >= compactAt * CONTEXT_WARNING_SHARE;

/** `⚠ context at 18% of the 1M window (182,000 tokens), near where it compacts (200,000)`. */
export function contextWarningText({ tokens, window, compactAt }: Omit<ContextUsage, "unknown">): string {
	const percent = window > 0 ? Math.round((tokens / window) * 100) : 0;
	return `⚠ context at ${percent}% of the ${windowSize(window)} window (${numbers.format(tokens)} tokens), near where it compacts (${numbers.format(compactAt)})`;
}
