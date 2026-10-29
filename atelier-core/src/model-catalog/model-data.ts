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
	/** Its long name, as "Claude Opus 5.5". */
	name?: string;
	/** When it came out, `YYYY-MM` or `YYYY-MM-DD`: the lists offer the newest first. */
	released?: string;
	contextWindow?: number;
	/** USD per million tokens, ordered as `pricing.ts` orders them. */
	prices?: readonly PriceTier[];
	/** The levels the model takes, of the ones Atelier sends. */
	efforts?: readonly Effort[];
	/** How its thinking is turned off, as `pricing.ts` sends it; `disabled` also stands for OpenCode Go's `none`. */
	off?: ThinkingOff;
	/** Whether it takes images in its input. */
	images?: boolean;
	/** The names Claude Code also takes for it, as `opus` for the model that alias stands for now, in its order. */
	aliases?: readonly string[];
}

/** A window as a person reads it: `1M`, `1.05M`, `200K`. */
function windowSize(tokens: number): string {
	const thousands = +(tokens / 1_000).toFixed(1);
	// A window that rounds to a thousand thousands is a million: 999950 is 1M, not 1000K.
	if (thousands >= 1_000) return `${+(tokens / 1_000_000).toFixed(2)}M`;
	return `${thousands}K`;
}

/**
 * What is known of a model for a person, `Claude Opus 5.5 · 1M context · images`, each part left out when no source
 * said it; undefined when none did. Pure: the TUI and `atelier models` show it.
 */
export function modelDetail(model: Pick<CatalogModel, "name" | "contextWindow" | "images">): string | undefined {
	const parts = [
		...(model.name === undefined ? [] : [model.name]),
		...(model.contextWindow === undefined ? [] : [`${windowSize(model.contextWindow)} context`]),
		...(model.images === undefined ? [] : [model.images ? "images" : "text only"]),
	];
	return parts.length === 0 ? undefined : parts.join(" · ");
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
	readonly #resolved: ReadonlySet<CatalogBackend>;

	/** `resolved`: the backends whose provider's list was kept with its aliases resolved (Claude Code's). */
	constructor(models: CatalogModels = {}, listed: CatalogListing = {}, resolved: readonly CatalogBackend[] = []) {
		for (const backend of CATALOG_BACKENDS)
			this.#byBackend.set(backend, new Map((models[backend] ?? []).map((model) => [model.id, model])));
		this.#listed = listed;
		this.#resolved = new Set(resolved);
	}

	/** Whether the provider's list was kept with what its aliases stand for resolved. */
	resolved(backend: CatalogBackend): boolean {
		return this.#resolved.has(backend) && this.#listed[backend] !== undefined;
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
/** A release date as models.dev writes it: `YYYY-MM` or `YYYY-MM-DD`. */
export const isReleaseDate = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(value);
const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

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
	if (isName(value.name)) model.name = value.name;
	if (isReleaseDate(value.released)) model.released = value.released;
	if (isSize(value.contextWindow)) model.contextWindow = value.contextWindow;
	if (Array.isArray(value.prices) && value.prices.length > 0) {
		const tiers = value.prices.map(priceTier);
		if (tiers.every((tier) => tier !== undefined)) model.prices = tiers;
	}
	if (Array.isArray(value.efforts)) model.efforts = value.efforts.filter(isEffort);
	if (value.off === "disabled" || value.off === "between_tools") model.off = value.off;
	if (typeof value.images === "boolean") model.images = value.images;
	if (Array.isArray(value.aliases)) model.aliases = value.aliases.filter(isName);
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
