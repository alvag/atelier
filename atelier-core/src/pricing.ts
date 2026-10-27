import type { Effort, Usage } from "./events.ts";
import type { ThinkingLevel } from "./profiles/index.ts";

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

/** How a model's thinking is turned off, as the `thinking` request field takes it. */
export type ThinkingOff = "disabled" | "between_tools";

/**
 * How to turn thinking off, from the same effort docs (2026-10-25). Haiku 5.5 and Opus 5 take
 * `disabled`; Sonnet 5.5 takes `between_tools` instead. Any other model, Opus 5.5 included (it answers 400
 * to `disabled`), gets nothing: Atelier does not guess.
 */
export const THINKING_OFF: Readonly<Record<string, ThinkingOff>> = Object.freeze({
	"claude-haiku-5-5": "disabled",
	"claude-opus-5": "disabled",
	"claude-sonnet-5-5": "between_tools",
});

/**
 * The models whose thinking is on with no `thinking` field and whose `display` defaults to `omitted`, from the
 * thinking docs (2026-10-27). Elsewhere `adaptive` would turn thinking on (Opus 4.6 to 4.8) or answer 400 (Opus 4.5).
 */
const THINKING_ON_BY_DEFAULT: ReadonlySet<string> = new Set([
	"claude-fable-5-1",
	"claude-mythos-5-1",
	"claude-fable-5",
	"claude-mythos-5",
	"claude-mythos-preview",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-haiku-5-5",
]);

/**
 * Whether to ask `model` for its thinking summarized, so clients can show it: where thinking is on by default and
 * `sent` did not turn it off, since `display` is invalid with `disabled` and `between_tools`. It costs the same.
 */
export function summarizesThinking(model: string, sent: ThinkingSend | undefined): boolean {
	return sent?.thinking === undefined && THINKING_ON_BY_DEFAULT.has(ALIASES[model] ?? model);
}

export type ThinkingBackend = "anthropic-api" | "claude-code";

/** What a backend sends for a thinking level, and what `session_started.effort` says about it. */
export interface ThinkingSend {
	/** The effort sent, `off` when thinking was turned off, `unsupported` when the level could not be sent. */
	report: Effort | "off" | "unsupported";
	effort?: Effort;
	thinking?: ThinkingOff;
}

/**
 * What to send to `model` for a profile level: nothing when none was asked. `minimal` is sent as `low`, as pi
 * does. `off` is sent only where the docs say how; the Claude Agent SDK's `ThinkingConfig` has no
 * `between_tools`, so on `claude-code` Sonnet 5.5 cannot turn thinking off.
 */
export function thinkingToSend(
	model: string,
	level: ThinkingLevel | undefined,
	backend: ThinkingBackend,
): ThinkingSend | undefined {
	if (level === undefined) return undefined;
	const id = ALIASES[model] ?? model;
	if (level === "off") {
		const off = THINKING_OFF[id];
		if (off === undefined || (off === "between_tools" && backend === "claude-code")) return { report: "unsupported" };
		return { report: "off", thinking: off };
	}
	const effort = level === "minimal" ? "low" : level;
	return EFFORT_LEVELS[id]?.includes(effort) ? { report: effort, effort } : { report: "unsupported" };
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
