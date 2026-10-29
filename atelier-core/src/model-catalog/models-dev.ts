import type { PriceTier } from "../pricing.ts";
import {
	type CatalogBackend,
	type CatalogModel,
	type CatalogModels,
	isEffort,
	isPrice,
	isRecord,
	isSize,
} from "./model-data.ts";
import type { CatalogSource } from "./store.ts";

/** models.dev's open catalog of providers and models (MIT, github.com/sst/models.dev): no account, no credential. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * The models.dev provider each backend's models are read from. Codex serves its own windows, not those of OpenAI's
 * API, and Claude Code reports its own: neither is read here.
 */
const PROVIDERS: Readonly<Partial<Record<CatalogBackend, string>>> = Object.freeze({
	"anthropic-api": "anthropic",
	"opencode-go": "opencode-go",
});

/** A models.dev price, without its limit; a missing cache price is 0, as OpenCode's own table counts it. */
function tierOf(cost: Record<string, unknown>): PriceTier | undefined {
	const { input, output, cache_read = 0, cache_write = 0 } = cost;
	if (![input, output, cache_read, cache_write].every(isPrice)) return undefined;
	return {
		input: input as number,
		output: output as number,
		cacheRead: cache_read as number,
		cacheWrite: cache_write as number,
	};
}

/**
 * models.dev's `cost` as Atelier's tiers: its `tiers` each start above a prompt size, Atelier's each end at one.
 * Undefined when a tier depends on something else than the prompt's size, or a price is not one.
 */
function pricesOf(cost: unknown): readonly PriceTier[] | undefined {
	if (!isRecord(cost)) return undefined;
	const first = tierOf(cost);
	if (!first) return undefined;
	const above = Array.isArray(cost.tiers) ? cost.tiers : [];
	const steps: { size: number; tier: PriceTier }[] = [];
	for (const entry of above) {
		if (!isRecord(entry) || !isRecord(entry.tier) || entry.tier.type !== "context" || !isSize(entry.tier.size))
			return undefined;
		const tier = tierOf(entry);
		if (!tier) return undefined;
		steps.push({ size: entry.tier.size, tier });
	}
	steps.sort((a, b) => a.size - b.size);
	const tiers: PriceTier[] = [];
	let current = first;
	for (const step of steps) {
		tiers.push({ upToPromptTokens: step.size, ...current });
		current = step.tier;
	}
	tiers.push(current);
	return tiers;
}

function modelOf(value: unknown): CatalogModel | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
	const model: CatalogModel = { id: value.id };
	if (isRecord(value.limit) && isSize(value.limit.context)) model.contextWindow = value.limit.context;
	const prices = pricesOf(value.cost);
	if (prices) model.prices = prices;
	const levels = Array.isArray(value.reasoning_options)
		? value.reasoning_options.flatMap((option) =>
				isRecord(option) && option.type === "effort" && Array.isArray(option.values) ? option.values : [],
			)
		: [];
	if (levels.length > 0) model.efforts = levels.filter(isEffort);
	if (levels.includes("none")) model.off = "disabled";
	if (isRecord(value.modalities) && Array.isArray(value.modalities.input))
		model.images = value.modalities.input.includes("image");
	return model;
}

/**
 * The models of the backends' providers in models.dev's `api.json`; throws when it is not that file, or holds no valid
 * model of them: an answer like that is broken, and the cached one stays.
 */
export function parseModelsDev(body: unknown): CatalogModels {
	if (!isRecord(body)) throw new Error("models.dev answered something else than its catalog");
	const models: CatalogModels = {};
	for (const [backend, provider] of Object.entries(PROVIDERS) as [CatalogBackend, string][]) {
		const entry = body[provider];
		if (!isRecord(entry) || !isRecord(entry.models)) continue;
		models[backend] = Object.values(entry.models)
			.map(modelOf)
			.filter((model) => model !== undefined);
	}
	if (!Object.values(models).some((list) => list.length > 0))
		throw new Error("models.dev answered no model of Atelier's providers");
	return models;
}

export interface ModelsDevOptions {
	url?: string;
	/** Injected in tests; defaults to the global `fetch`. */
	fetch?: typeof globalThis.fetch;
}

/** models.dev as a catalog source: one public request, revalidated with its etag. */
export function modelsDevSource(options: ModelsDevOptions = {}): CatalogSource {
	const url = options.url ?? MODELS_DEV_URL;
	const fetch = options.fetch ?? globalThis.fetch;
	return {
		name: "models.dev",
		async fetch(previous, signal) {
			const headers: Record<string, string> = { accept: "application/json" };
			if (previous?.etag !== undefined) headers["if-none-match"] = previous.etag;
			const response = await fetch(url, { headers, signal });
			if (response.status === 304 && previous) return { kind: "unchanged" };
			if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
			const etag = response.headers.get("etag") ?? undefined;
			return { kind: "changed", models: parseModelsDev(await response.json()), ...(etag ? { etag } : {}) };
		},
	};
}
