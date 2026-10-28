import { EFFORTS, type Effort } from "../events.ts";
import type { PriceTier, ThinkingOff } from "../pricing.ts";

/** The backends whose models the catalog describes. */
export type CatalogBackend = "anthropic-api" | "opencode-go" | "openai-codex" | "claude-code";
export const CATALOG_BACKENDS: readonly CatalogBackend[] = [
	"anthropic-api",
	"opencode-go",
	"openai-codex",
	"claude-code",
];

/** What a source says of one model; each field is absent when it did not say it, so nothing is invented. */
export interface CatalogModel {
	id: string;
	contextWindow?: number;
	/** USD per million tokens, ordered as `pricing.ts` orders them. */
	prices?: readonly PriceTier[];
	/** The levels the model takes, of the ones Atelier sends. */
	efforts?: readonly Effort[];
	/** How its thinking is turned off, as `pricing.ts` sends it; `disabled` also stands for OpenCode Go's `none`. */
	off?: ThinkingOff;
}

export type CatalogModels = Partial<Record<CatalogBackend, readonly CatalogModel[]>>;
export type CatalogListing = Partial<Record<CatalogBackend, readonly string[]>>;

/**
 * The models the catalog knows, by backend, for the backends to look up the ones their tables lack; and the ones each
 * provider listed, in its order, where it was asked.
 */
export class ModelData {
	readonly #byBackend = new Map<CatalogBackend, Map<string, CatalogModel>>();
	readonly #listed: CatalogListing;

	constructor(models: CatalogModels = {}, listed: CatalogListing = {}) {
		for (const backend of CATALOG_BACKENDS)
			this.#byBackend.set(backend, new Map((models[backend] ?? []).map((model) => [model.id, model])));
		this.#listed = listed;
	}

	model(backend: CatalogBackend, id: string): CatalogModel | undefined {
		return this.#byBackend.get(backend)?.get(id);
	}

	/** The ids the backend's provider listed last; undefined when it was never asked or never answered. */
	listed(backend: CatalogBackend): readonly string[] | undefined {
		return this.#listed[backend];
	}
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A token count: a positive whole number. */
export const isSize = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const isPrice = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

function priceTier(value: unknown): PriceTier | undefined {
	if (!isRecord(value)) return undefined;
	const { upToPromptTokens, input, output, cacheRead, cacheWrite } = value;
	if (![input, output, cacheRead, cacheWrite].every(isPrice)) return undefined;
	if (upToPromptTokens !== undefined && !isSize(upToPromptTokens)) return undefined;
	return {
		...(upToPromptTokens === undefined ? {} : { upToPromptTokens }),
		input: input as number,
		output: output as number,
		cacheRead: cacheRead as number,
		cacheWrite: cacheWrite as number,
	};
}

/** A model as the catalog file keeps it, or undefined when it is not one; a field that is wrong is dropped alone. */
export function catalogModel(value: unknown): CatalogModel | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
	const model: CatalogModel = { id: value.id };
	if (isSize(value.contextWindow)) model.contextWindow = value.contextWindow;
	if (Array.isArray(value.prices) && value.prices.length > 0) {
		const tiers = value.prices.map(priceTier);
		if (tiers.every((tier) => tier !== undefined)) model.prices = tiers;
	}
	if (Array.isArray(value.efforts)) model.efforts = value.efforts.filter(isEffort);
	if (value.off === "disabled" || value.off === "between_tools") model.off = value.off;
	return model;
}

export const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value);

/** The models of each backend in `value`, dropping what is not a model. */
export function catalogModels(value: unknown): CatalogModels {
	if (!isRecord(value)) return {};
	const models: CatalogModels = {};
	for (const backend of CATALOG_BACKENDS) {
		const list = value[backend];
		if (!Array.isArray(list)) continue;
		models[backend] = list.map(catalogModel).filter((model) => model !== undefined);
	}
	return models;
}
