import type { Effort } from "../../events.ts";
import { currentModelData } from "../../model-catalog/current.ts";
import type { PriceTier } from "../../pricing.ts";

/**
 * OpenCode Go's one base URL: the Messages API answers at `<base>/v1/messages`, Chat Completions at
 * `<base>/v1/chat/completions`. It is the URL of pi-ai 1.4.0, the one gentle-shell 4.4.0 runs
 * (`dist/providers/data/opencode-go.json`, line 1: `"baseUrl":"https://opencode.ai/inference/go"` and `.../go/v1`);
 * pi-ai 1.2.0 still had `https://opencode.ai/zen/go`. OpenCode's page (opencode.ai/docs/go) lists the same
 * `inference/go` endpoints.
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
	/** The model reasons with nothing sent and takes no level: any level asked reports `auto`. */
	reasonsOnItsOwn?: true;
	/** Every level sends `thinking: {type: "enabled", budget_tokens}` (a Messages model); the budget turns its thinking on, it does not size it. */
	budgetThinking?: true;
	/** The `reasoning_effort` that turns its thinking off, on Chat Completions; absent when it cannot. */
	off?: string;
	/** Every assistant message must carry `reasoning_content`, even empty (DeepSeek on Chat Completions). */
	replaysReasoning?: true;
	/** USD per million tokens, as OpenCode counts them against the plan; absent when the price depends on the hour. */
	prices?: readonly PriceTier[];
}

/**
 * The `thinking.budget_tokens` each level sends to a budget-thinking model, as pi sends it. Measured on
 * `minimax-m3`: the budget only turns the thinking on, it does not set how much it reasons, so `xhigh` and `max`
 * take `high`'s.
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = Object.freeze({
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 16384,
});

const flat = (input: number, output: number, cacheRead: number, cacheWrite = 0): readonly PriceTier[] => [
	{ input, output, cacheRead, cacheWrite },
];

const LOW_HIGH_MAX: readonly Effort[] = ["low", "high", "max"];

/** A Chat Completions model. */
const chat = (
	contextWindow: number,
	efforts: readonly Effort[],
	prices: readonly PriceTier[] | undefined,
	extra: Partial<OpenCodeGoModel> = {},
): OpenCodeGoModel => ({
	protocol: "openai-completions",
	contextWindow,
	efforts,
	...(prices === undefined ? {} : { prices }),
	...extra,
});

/**
 * The models of https://opencode.ai/docs/go (2026-10-28), with their prices from its table, and the windows and
 * levels from pi-ai 1.4.0's `opencode-go.json`. `mimo-v2.5` and `mimo-v2.5-pro` are gone: OpenCode answers 410
 * that they are deprecated and points to the mimo-v2.6 models (measured 2026-10-29). Update it when that page
 * changes: add or remove the model, its protocol (the page's endpoint) and its price, and the test that lists
 * the models.
 */
export const OPENCODE_GO_MODELS: Readonly<Record<string, OpenCodeGoModel>> = Object.freeze({
	"minimax-m3": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		budgetThinking: true,
		prices: flat(0.3, 1.2, 0.06),
	},
	"qwen3.8-max": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		reasonsOnItsOwn: true,
		prices: flat(2, 6, 0.25, 2.5),
	},
	"qwen3.8-flash": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		reasonsOnItsOwn: true,
		prices: flat(0.15, 0.47, 0.016, 0.2),
	},
	"qwen3.7-plus": {
		protocol: "anthropic-messages",
		contextWindow: 1_000_000,
		efforts: [],
		reasonsOnItsOwn: true,
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
	"glm-5.3": chat(1_000_000, LOW_HIGH_MAX, flat(1.4, 4.4, 0.26)),
	"glm-5.3-flash": chat(1_000_000, LOW_HIGH_MAX, flat(0.15, 0.5, 0.03)),
	"glm-5.2": chat(1_000_000, ["high", "max"], flat(1.4, 4.4, 0.26)),
	"kimi-k3": chat(1_048_576, ["max"], flat(3, 15, 0.3, 3)),
	"kimi-k2.7-code": chat(262_144, [], flat(0.95, 4, 0.19), { reasonsOnItsOwn: true }),
	"minimax-m3.1-flash": chat(1_000_000, ["low", "medium", "high", "xhigh", "max"], flat(0.15, 0.6, 0.015)),
	"mimo-v2.6-pro": chat(1_048_576, [], flat(0.435, 0.87, 0.003625), { reasonsOnItsOwn: true }),
	"mimo-v2.6-flash": chat(1_048_576, [], flat(0.14, 0.28, 0.0028), { reasonsOnItsOwn: true }),
	"longcat-2.0": chat(1_000_000, [], flat(0.3, 1.2, 0.006), { reasonsOnItsOwn: true }),
	"step-5-preview": chat(1_000_000, ["low", "medium", "high"], flat(1, 2.7, 0.1)),
	"hy4-preview": chat(1_024_000, ["high"], flat(0.834, 2.501, 0.042), { off: "none" }),
	hy3: chat(256_000, ["low", "high"], flat(0.14, 0.58, 0.035), { off: "none" }),
	// DeepSeek costs more at peak hours (OpenCode's page): no single price, so its cost is unknown.
	"deepseek-v4.1-flash": chat(1_000_000, LOW_HIGH_MAX, undefined, { replaysReasoning: true }),
	"deepseek-v4-pro": chat(1_000_000, ["high", "max"], undefined, { replaysReasoning: true }),
	"beam-free": chat(1_048_576, ["low", "medium", "high", "xhigh", "max"], flat(0, 0, 0)),
});

/** A model OpenCode Go serves but the table does not know: the console translates Chat Completions for it. */
export const UNKNOWN_OPENCODE_GO_MODEL: OpenCodeGoModel = Object.freeze({
	protocol: "openai-completions",
	contextWindow: 200_000,
	efforts: [],
});

/**
 * A model the table or the model catalog knows. One only the catalog knows goes through Chat Completions, which the
 * console translates for any model; models.dev's `none` level is the `reasoning_effort` that turns it off.
 */
export function knownOpenCodeGoModel(id: string): OpenCodeGoModel | undefined {
	const entry = OPENCODE_GO_MODELS[id];
	if (entry) return entry;
	const listed = currentModelData().model("opencode-go", id);
	if (!listed) return undefined;
	return {
		protocol: "openai-completions",
		contextWindow: listed.contextWindow ?? UNKNOWN_OPENCODE_GO_MODEL.contextWindow,
		efforts: listed.efforts ?? [],
		...(listed.off ? { off: "none" } : {}),
		...(listed.prices === undefined ? {} : { prices: listed.prices }),
	};
}

export function openCodeGoModel(id: string): OpenCodeGoModel {
	return knownOpenCodeGoModel(id) ?? UNKNOWN_OPENCODE_GO_MODEL;
}
