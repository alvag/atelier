import { CODEX_URL } from "../backends/openai-codex/access.ts";
import { OPENCODE_GO_BASE_URL } from "../backends/opencode-go/models.ts";
import { EFFORTS } from "../events.ts";
import type { ThinkingOff } from "../pricing.ts";
import { type CatalogBackend, type CatalogModel, isEffort, isRecord, isSize } from "./model-data.ts";
import type { CatalogSource, FetchResult } from "./store.ts";

/** Anthropic's API, where `/v1/models` lists the models the key can use. */
export const ANTHROPIC_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
/** Pages of 1000 models: one is enough today; more is a broken answer. */
const MAX_PAGES = 5;
/**
 * The Codex release Atelier asks the Codex catalog as: it hides the models that need a newer one
 * (`minimal_client_version`). The version of the catalog docs, learn.chatgpt.com/docs/model-catalogs (2026-10-28).
 */
export const CODEX_CLIENT_VERSION = "0.162.1";

const listing = (backend: CatalogBackend, models: CatalogModel[]): FetchResult => ({
	kind: "changed",
	models: { [backend]: models },
});

async function getJson(fetch: typeof globalThis.fetch, url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.json();
}

/** How Anthropic's capabilities say thinking is turned off: `disabled` where it can, else `between_tools`. */
function anthropicOff(capabilities: Record<string, unknown>): ThinkingOff | undefined {
	const types =
		isRecord(capabilities.thinking) && isRecord(capabilities.thinking.types) ? capabilities.thinking.types : {};
	const takes = (type: string) => isRecord(types[type]) && types[type].supported === true;
	if (takes("disabled")) return "disabled";
	if (takes("between_tools")) return "between_tools";
	return undefined;
}

function anthropicModel(value: unknown): CatalogModel | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
	const model: CatalogModel = { id: value.id };
	if (isSize(value.max_input_tokens)) model.contextWindow = value.max_input_tokens;
	if (isRecord(value.capabilities)) {
		const effort = value.capabilities.effort;
		if (isRecord(effort) && effort.supported === true)
			model.efforts = EFFORTS.filter((level) => isRecord(effort[level]) && effort[level].supported === true);
		const off = anthropicOff(value.capabilities);
		if (off) model.off = off;
		const images = value.capabilities.image_input;
		if (isRecord(images) && typeof images.supported === "boolean") model.images = images.supported;
	}
	return model;
}

export interface AnthropicModelsOptions {
	/** The key `anthropic-api` runs with; without one the source is not asked. */
	apiKey: () => Promise<string | undefined>;
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}

/** The models Anthropic's API lists for the key, with their windows, levels and how their thinking is turned off. */
export function anthropicModelsSource(options: AnthropicModelsOptions): CatalogSource {
	const fetch = options.fetch ?? globalThis.fetch;
	return {
		name: "anthropic-api",
		async fetch(_previous, signal) {
			const key = await options.apiKey();
			if (key === undefined) throw new Error("No Anthropic API key");
			const models: CatalogModel[] = [];
			let after: string | undefined;
			for (let page = 0; page < MAX_PAGES; page++) {
				const url = new URL("/v1/models", options.baseUrl ?? ANTHROPIC_URL);
				url.searchParams.set("limit", "1000");
				if (after !== undefined) url.searchParams.set("after_id", after);
				const body = await getJson(fetch, url.href, {
					headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" },
					signal,
				});
				if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Anthropic answered something else");
				const page = body.data.map(anthropicModel).filter((model) => model !== undefined);
				// A page without a valid model, or one that says there is more without saying from where, is broken.
				if (page.length === 0) throw new Error("Anthropic answered a page without models");
				models.push(...page);
				if (body.has_more !== true) return listing("anthropic-api", models);
				if (typeof body.last_id !== "string" || body.last_id === "")
					throw new Error("Anthropic said there were more models without saying from where");
				after = body.last_id;
			}
			throw new Error("Anthropic's model list did not end");
		},
	};
}

export interface OpenCodeGoModelsOptions {
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}

/**
 * The models OpenCode Go serves: its list answers without the key, so none is sent. It says nothing else of them. An
 * answer without a model is broken, as for every provider: the cached list stays.
 */
export function openCodeGoModelsSource(options: OpenCodeGoModelsOptions = {}): CatalogSource {
	const fetch = options.fetch ?? globalThis.fetch;
	return {
		name: "opencode-go",
		async fetch(_previous, signal) {
			const body = await getJson(fetch, `${options.baseUrl ?? OPENCODE_GO_BASE_URL}/v1/models`, {
				headers: { accept: "application/json" },
				signal,
			});
			if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("OpenCode Go answered something else");
			const ids = body.data.flatMap((entry) =>
				isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? [entry.id] : [],
			);
			if (ids.length === 0) throw new Error("OpenCode Go answered no model");
			return listing(
				"opencode-go",
				ids.map((id) => ({ id })),
			);
		},
	};
}

function codexModel(value: unknown): (CatalogModel & { priority: number }) | undefined {
	if (!isRecord(value) || typeof value.slug !== "string" || value.slug === "" || value.visibility !== "list")
		return undefined;
	const model: CatalogModel & { priority: number } = {
		id: value.slug,
		priority: typeof value.priority === "number" ? value.priority : Number.MAX_SAFE_INTEGER,
	};
	if (isSize(value.context_window)) model.contextWindow = value.context_window;
	if (Array.isArray(value.input_modalities)) model.images = value.input_modalities.includes("image");
	if (Array.isArray(value.supported_reasoning_levels) && value.supported_reasoning_levels.length > 0)
		model.efforts = value.supported_reasoning_levels
			.map((level) => (isRecord(level) ? level.effort : undefined))
			.filter(isEffort);
	return model;
}

/** Claude Code's ids are all `claude-...`: a name without that is an alias. */
export const isVersionedClaudeId = (id: string): boolean => id.startsWith("claude-");

/** The model an id is, without the `[1m]` that asks Claude Code for a 1M window. */
const withoutWindow = (id: string) => id.replace(/\[1m\]$/i, "");

/**
 * The models Claude Code offers the subscription, as `supportedModels()` of a running session lists them, by their
 * versioned ids: a row of an alias (`opus`) is the model it stands for now (`resolvedModel`), which keeps the alias, so
 * Atelier can send it. `default` stands for whatever the account starts on, so it is never kept as an alias; an alias
 * Claude Code does not resolve is no model. Claude Code says nothing of windows or prices: it counts them itself.
 */
export function claudeCodeModelsSource(list: () => Promise<readonly unknown[]>): CatalogSource {
	return {
		name: "claude-code",
		async fetch() {
			const listed = await list();
			if (!Array.isArray(listed)) throw new Error("Claude Code answered something else");
			const models = new Map<string, CatalogModel & { aliases: string[] }>();
			for (const entry of listed) {
				if (!isRecord(entry) || typeof entry.value !== "string" || entry.value === "") continue;
				const resolved = typeof entry.resolvedModel === "string" ? entry.resolvedModel : entry.value;
				const id = withoutWindow(resolved);
				if (!isVersionedClaudeId(id)) continue;
				const levels = entry.supportedEffortLevels;
				const model = models.get(id) ?? { id, aliases: [] };
				// The first row that says the levels says them for the model.
				if (model.efforts === undefined && Array.isArray(levels)) model.efforts = levels.filter(isEffort);
				if (entry.value !== id && entry.value !== "default" && !model.aliases.includes(entry.value))
					model.aliases.push(entry.value);
				models.set(id, model);
			}
			if (models.size === 0) throw new Error("Claude Code listed no model");
			return listing(
				"claude-code",
				[...models.values()].map(({ aliases, ...model }) => (aliases.length === 0 ? model : { ...model, aliases })),
			);
		},
	};
}

export interface CodexModelsOptions {
	/** The signed-in account's headers; without them the source is not asked. */
	headers: () => Promise<Record<string, string> | undefined>;
	baseUrl?: string;
	clientVersion?: string;
	fetch?: typeof globalThis.fetch;
}

/**
 * The models the ChatGPT account's Codex picker shows (`visibility: list`), in its order, with their windows and
 * levels: the Codex catalog of learn.chatgpt.com/docs/model-catalogs, asked with the account's own token.
 */
export function codexModelsSource(options: CodexModelsOptions): CatalogSource {
	const fetch = options.fetch ?? globalThis.fetch;
	return {
		name: "openai-codex",
		async fetch(_previous, signal) {
			const headers = await options.headers();
			if (headers === undefined) throw new Error("Not signed in to ChatGPT");
			const url = new URL(`${options.baseUrl ?? CODEX_URL}/codex/models`);
			url.searchParams.set("client_version", options.clientVersion ?? CODEX_CLIENT_VERSION);
			const body = await getJson(fetch, url.href, { headers: { ...headers, accept: "application/json" }, signal });
			if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("The Codex catalog answered something else");
			const models = body.models.map(codexModel).filter((model) => model !== undefined);
			if (models.length === 0) throw new Error("The Codex catalog listed no model");
			models.sort((a, b) => a.priority - b.priority);
			return listing(
				"openai-codex",
				models.map(({ priority: _priority, ...model }) => model),
			);
		},
	};
}
