import type { Effort, Usage } from "./events.ts";

/** USD per million tokens. `cacheWrite` is the 5-minute cache write; Atelier writes no 1-hour entries. */
export interface PriceTier {
	/** The tier applies while the prompt (input + cache read + cache write) stays at or below this size. */
	upToPromptTokens?: number;
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
}

/**
 * Anthropic list prices checked on 2026-10-22 (platform.claude.com/docs/en/about-claude/pricing and
 * .../prompt-caching). Cache writes cost 1.25x input; reads cost 0.05x input on Opus 5.5 and Sonnet 5.5
 * and 0.1x on Haiku 5.5. Tiers are ordered; the last one has no limit.
 */
export const PRICES: Readonly<Record<string, readonly PriceTier[]>> = Object.freeze({
	"claude-opus-5-5": [{ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }],
	"claude-sonnet-5-5": [{ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }],
	"claude-haiku-5-5": [
		{ upToPromptTokens: 100_000, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
		{ input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
	],
});

const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: readonly Effort[] = ["low", "medium", "high", "max"];

/**
 * The effort levels each model takes, from https://platform.claude.com/docs/en/build-with-claude/effort
 * (2026-10-25). Not every model that takes `max` takes `xhigh`. Any other model, known or not, gets none.
 */
export const EFFORT_LEVELS: Readonly<Record<string, readonly Effort[]>> = Object.freeze({
	"claude-fable-5-1": ALL_EFFORTS,
	"claude-mythos-5-1": ALL_EFFORTS,
	"claude-fable-5": ALL_EFFORTS,
	"claude-mythos-5": ALL_EFFORTS,
	"claude-mythos-preview": NO_XHIGH,
	"claude-opus-5-5": ALL_EFFORTS,
	"claude-opus-5": ALL_EFFORTS,
	"claude-opus-4-8": ALL_EFFORTS,
	"claude-opus-4-7": ALL_EFFORTS,
	"claude-opus-4-6": NO_XHIGH,
	"claude-opus-4-5-20251101": ["low", "medium", "high"],
	"claude-sonnet-5-5": ALL_EFFORTS,
	"claude-sonnet-5": ALL_EFFORTS,
	"claude-sonnet-4-6": NO_XHIGH,
	"claude-haiku-5-5": ALL_EFFORTS,
});

/** Claude Code's model aliases and undated ids, so a model named either way finds its effort levels. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5-5",
	haiku: "claude-haiku-5-5",
	"claude-opus-4-5": "claude-opus-4-5-20251101",
});

/** The effort to send to `model`: none when none was asked, `unsupported` when the model does not take that level. */
export function effortToSend(model: string, effort: Effort | undefined): Effort | "unsupported" | undefined {
	if (effort === undefined) return undefined;
	return EFFORT_LEVELS[ALIASES[model] ?? model]?.includes(effort) ? effort : "unsupported";
}

/** Cost of one API request, or undefined when the model is not in the table. */
export function costOfRequest(model: string, usage: Usage): number | undefined {
	const tiers = PRICES[model];
	if (!tiers) return undefined;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const tier = tiers.find((t) => t.upToPromptTokens === undefined || promptTokens <= t.upToPromptTokens);
	if (!tier) return undefined;
	return (
		(usage.input * tier.input +
			usage.output * tier.output +
			usage.cacheWrite * tier.cacheWrite +
			usage.cacheRead * tier.cacheRead) /
		1_000_000
	);
}
