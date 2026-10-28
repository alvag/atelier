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
				models.push(...body.data.map(anthropicModel).filter((model) => model !== undefined));
				if (body.has_more !== true || typeof body.last_id !== "string") return listing("anthropic-api", models);
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

/** The models OpenCode Go serves: its list answers without the key, so none is sent. It says nothing else of them. */
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
	if (Array.isArray(value.supported_reasoning_levels) && value.supported_reasoning_levels.length > 0)
		model.efforts = value.supported_reasoning_levels
			.map((level) => (isRecord(level) ? level.effort : undefined))
			.filter(isEffort);
	return model;
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
			models.sort((a, b) => a.priority - b.priority);
			return listing(
				"openai-codex",
				models.map(({ priority: _priority, ...model }) => model),
			);
		},
	};
}
