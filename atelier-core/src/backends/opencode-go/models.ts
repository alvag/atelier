import type { Effort } from "../../events.ts";
import type { PriceTier } from "../../pricing.ts";

/**
 * OpenCode Go's one base URL: the Messages API answers at `<base>/v1/messages`, Chat Completions at
 * `<base>/v1/chat/completions`. The URL pi-ai 1.4.0 uses for OpenCode Go (`providers/data/opencode-go.json`).
 */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go";

/** The model the backend runs without --model: native Messages API, cheap, and a 1M window. */
export const DEFAULT_OPENCODE_GO_MODEL = "minimax-m3";

/** The protocol a model is served with natively; a model not in the table goes through Chat Completions. */
export type OpenCodeGoProtocol = "anthropic-messages" | "openai-completions";

export interface OpenCodeGoModel {
	protocol: OpenCodeGoProtocol;
	contextWindow: number;
	/** The levels the model takes; any other level is not sent. */
	efforts: readonly Effort[];
	/** The `reasoning_effort` that turns its thinking off, on Chat Completions; absent when it cannot. */
	off?: string;
	/** USD per million tokens, as OpenCode bills them against the plan; absent when the price depends on the hour. */
	prices?: readonly PriceTier[];
}

const flat = (input: number, output: number, cacheRead: number, cacheWrite = 0): readonly PriceTier[] => [
	{ input, output, cacheRead, cacheWrite },
];

/**
 * The models of https://opencode.ai/docs/go (2026-10-28), with their prices from its table, and the windows and
 * levels from pi-ai 1.4.0's `opencode-go.json`. Update it when that page changes: add or remove the model, its
 * protocol (the page's endpoint) and its price, and the test that lists the models.
 */
export const OPENCODE_GO_MODELS: Readonly<Record<string, OpenCodeGoModel>> = Object.freeze({
	"minimax-m3": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		prices: flat(0.3, 1.2, 0.06),
	},
	"qwen3.8-max": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		prices: flat(2, 6, 0.25, 2.5),
	},
	"qwen3.8-flash": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		prices: flat(0.15, 0.47, 0.016, 0.2),
	},
	"qwen3.7-plus": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		prices: [
			{ upToPromptTokens: 256_000, input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
			{ input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 },
		],
	},
	"claude-haiku-5-5": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		prices: [
			{ upToPromptTokens: 100_000, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
			{ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
		],
	},
});

/** A model OpenCode Go serves but the table does not know: the console translates Chat Completions for it. */
export const UNKNOWN_OPENCODE_GO_MODEL: OpenCodeGoModel = Object.freeze({
	protocol: "openai-completions",
	contextWindow: 200_000,
	efforts: [],
});

export function openCodeGoModel(id: string): OpenCodeGoModel {
	return OPENCODE_GO_MODELS[id] ?? UNKNOWN_OPENCODE_GO_MODEL;
}
