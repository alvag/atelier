import { isVersionedClaudeId, resolvedClaudeCodeList } from "../backends/claude-code/models.ts";
import { BACKEND_MODELS, type ModelCatalog } from "../options.ts";
import type { BackendName } from "../protocol/types.ts";
import { useModelData } from "./current.ts";
import { type CatalogModel, ModelData } from "./model-data.ts";
import { newestFirst } from "./order.ts";
import { claudeCodeModelsSource } from "./providers.ts";
import {
	type CatalogFile,
	type CatalogSource,
	CLAUDE_CODE_RUNS,
	modelDataOf,
	type RefreshOptions,
	type RefreshOutcome,
	readCatalog,
	refreshCatalog,
	refreshSource,
	updateSource,
} from "./store.ts";

/** Claude Code's aliases are not offered: the versioned id each stands for is. */
const offered = (backend: BackendName, id: string) => backend !== "claude-code" || isVersionedClaudeId(id);

export interface DynamicCatalogOptions {
	/** The catalog file, `catalogFile(home)`. */
	file: string;
	/** What a refresh asks. */
	sources: readonly CatalogSource[];
	/** False (`ATELIER_MODEL_REFRESH=off`): only the cache is read, nothing is asked. */
	network?: boolean;
	refresh?: RefreshOptions;
	/** Injected in tests; defaults to `readCatalog`. */
	read?: (file: string) => Promise<CatalogFile>;
}

/**
 * The model lists of `options.list`: each backend's list in the code and the models its provider listed that the code
 * lacks, newest first; Claude Code's by their versioned ids, without its aliases. It reads the cache once, and makes what it holds the process's model data, so the backends price and
 * size the new models; a refresh replaces both as it lands.
 */
export class DynamicModelCatalog implements ModelCatalog {
	readonly #options: DynamicCatalogOptions;
	#loaded: Promise<ModelData>;
	/** The latest read of the cache: an older one that ends after it does not replace its data. */
	#reads = 0;

	constructor(options: DynamicCatalogOptions) {
		this.#options = options;
		this.#loaded = this.#load();
	}

	/**
	 * Never fails: whatever the cache holds, the code's list stays, but for claude-code once the subscription's list is
	 * resolved: that list alone says what the subscription offers.
	 */
	async models(backend: BackendName): Promise<readonly string[]> {
		const data = await this.#latest();
		const released = (id: string) => data.model(backend, id)?.released;
		const subscription = backend === "claude-code" ? resolvedClaudeCodeList(data) : undefined;
		if (subscription !== undefined) return newestFirst(subscription, released);
		const base = BACKEND_MODELS[backend];
		const listed = (data.listed(backend) ?? []).filter((id) => !base.includes(id) && offered(backend, id));
		return newestFirst([...base, ...listed], released);
	}

	/** What the catalog knows of a model: its window, price, levels and whether it takes images, each when a source said it. */
	async model(backend: BackendName, id: string): Promise<CatalogModel | undefined> {
		return (await this.#latest()).model(backend, id);
	}

	/** The data of the newest read that ended: a newer one published while this waited replaces what it waited for. */
	async #latest(): Promise<ModelData> {
		for (;;) {
			const loaded = this.#loaded;
			const data = await loaded.catch(() => new ModelData());
			if (loaded === this.#loaded) return data;
		}
	}

	/** Asks every source whose answer is older than the interval (all of them with `force`), then reads the cache. */
	async refresh(options: RefreshOptions = {}): Promise<Record<string, RefreshOutcome>> {
		if (this.#options.network === false) return {};
		const outcomes = await refreshCatalog(this.#options.file, this.#options.sources, {
			...this.#options.refresh,
			...options,
		});
		await this.#reload();
		return outcomes;
	}

	/** The refresh of a start: in the background, never failing; the promise is for tests. */
	start(): Promise<Record<string, RefreshOutcome>> {
		return this.refresh().catch(() => ({}));
	}

	/**
	 * Lists Claude Code's models from a session that started, when its list is older than the interval: Claude Code
	 * answers from the process the session already runs. Never fails.
	 */
	async listClaudeCode(list: () => Promise<readonly unknown[]>): Promise<void> {
		if (this.#options.network === false) return;
		try {
			// A list kept without the aliases resolved, as an older Atelier kept it, is asked again, whenever it was kept.
			const data = await this.#latest();
			const force = data.listed("claude-code") !== undefined && resolvedClaudeCodeList(data) === undefined;
			await refreshSource(this.#options.file, claudeCodeModelsSource(list), {
				...this.#options.refresh,
				...(force ? { force } : {}),
			});
			await this.#reload();
		} catch {
			// The list stays as it was.
		}
	}

	/**
	 * Keeps the window Claude Code ran each model with, as a turn's end says it, apart from its list
	 * (`CLAUDE_CODE_RUNS`): a model the list lacks keeps it too, without being offered, and a new list keeps them all.
	 * It is no network request, so it is kept with the refresh off too. Nothing is written when the windows are the
	 * ones kept. Never fails.
	 */
	async noteClaudeCodeWindows(windows: Record<string, number>): Promise<void> {
		const data = await this.#latest();
		const changed = Object.entries(windows).filter(
			([id, window]) => data.model("claude-code", id)?.contextWindow !== window,
		);
		if (changed.length === 0) return;
		const noted = new Map(changed);
		try {
			await updateSource(this.#options.file, CLAUDE_CODE_RUNS, (entry) => {
				const kept = (entry?.models["claude-code"] ?? []).filter((model) => !noted.has(model.id));
				const added = [...noted].map(([id, contextWindow]) => ({ id, contextWindow }));
				return { checkedAt: Date.now(), models: { "claude-code": [...kept, ...added] } };
			});
			await this.#reload();
		} catch {
			// The window is said again at the next turn's end.
		}
	}

	/** Reads the cache again; until the read ends, the lists of the last one are offered. */
	async #reload(): Promise<void> {
		await this.#load();
	}

	/**
	 * The cache's data; a read that fails, or a cache that makes no sense, is no data at all. Only the latest read
	 * publishes it, to the lists and to the backends at once: an older one that ends after it changes neither.
	 */
	async #load(): Promise<ModelData> {
		const read = ++this.#reads;
		let data: ModelData;
		try {
			data = modelDataOf(await (this.#options.read ?? readCatalog)(this.#options.file));
		} catch {
			data = new ModelData();
		}
		if (read === this.#reads) {
			this.#loaded = Promise.resolve(data);
			useModelData(data);
		}
		return data;
	}
}
