import { BACKEND_MODELS, type ModelCatalog } from "../options.ts";
import type { BackendName } from "../protocol/types.ts";
import { useModelData } from "./current.ts";
import { ModelData } from "./model-data.ts";
import { claudeCodeModelsSource } from "./providers.ts";
import {
	type CatalogFile,
	type CatalogSource,
	modelDataOf,
	type RefreshOptions,
	type RefreshOutcome,
	readCatalog,
	refreshCatalog,
	refreshSource,
} from "./store.ts";

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
 * The model lists of `options.list`: each backend's list in the code, then the models its provider listed that the
 * code lacks. It reads the cache once, and makes what it holds the process's model data, so the backends price and
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

	/** Never fails: whatever the cache holds, the code's list stays. */
	async models(backend: BackendName): Promise<readonly string[]> {
		const base = BACKEND_MODELS[backend];
		const listed = (await this.#latest()).listed(backend) ?? [];
		return [...base, ...listed.filter((id) => !base.includes(id))];
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
			await refreshSource(this.#options.file, claudeCodeModelsSource(list), this.#options.refresh);
			await this.#reload();
		} catch {
			// The list stays as it was.
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
