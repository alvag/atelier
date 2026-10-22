import type { Usage } from "./events.ts";

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
