import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	CATALOG_BACKENDS,
	type CatalogListing,
	type CatalogModel,
	type CatalogModels,
	catalogModels,
	isRecord,
	ModelData,
} from "./model-data.ts";

/** How long what a source said is used before it is asked again. */
export const CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long one request to a source may take: a refresh never holds anything up for longer. */
export const CATALOG_REQUEST_TIMEOUT_MS = 4_000;
const FILE_VERSION = 1;

/** What one source said last, and when it was last asked. */
export interface SourceEntry {
	checkedAt: number;
	etag?: string;
	models: CatalogModels;
}

/** The catalog file: each source's last answer, by source name. */
export interface CatalogFile {
	sources: Record<string, SourceEntry>;
}

export type FetchResult = { kind: "changed"; models: CatalogModels; etag?: string } | { kind: "unchanged" };

/** Where models come from: `fetch` throws when it cannot say, and the cached answer stays. */
export interface CatalogSource {
	name: string;
	fetch(previous: SourceEntry | undefined, signal: AbortSignal): Promise<FetchResult>;
}

/** The catalog of `home`: `~/.atelier/models.json`. It holds no credential, and it is rebuilt from the sources. */
export function catalogFile(home: string): string {
	return join(home, ".atelier", "models.json");
}

/** The catalog in `file`; a missing or broken file, or a source of another shape, reads as no answer. */
export async function readCatalog(file: string): Promise<CatalogFile> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return { sources: {} };
	}
	const sources: Record<string, SourceEntry> = {};
	if (!isRecord(parsed) || !isRecord(parsed.sources)) return { sources };
	for (const [name, entry] of Object.entries(parsed.sources)) {
		if (!isRecord(entry) || typeof entry.checkedAt !== "number") continue;
		sources[name] = {
			checkedAt: entry.checkedAt,
			...(typeof entry.etag === "string" ? { etag: entry.etag } : {}),
			models: catalogModels(entry.models),
		};
	}
	return { sources };
}

/** The last write to each file in this process: the next one waits for it, so no source's answer is lost here. */
const writing = new Map<string, Promise<void>>();

/**
 * Replaces one source's entry: reads the file again, then writes it whole to a temporary next to it and renames it
 * over, so a reader never sees half a file. Two processes writing at once can lose one's answer, never the file:
 * it is asked again at the next refresh.
 */
function saveSource(file: string, name: string, entry: SourceEntry): Promise<void> {
	const write = (writing.get(file) ?? Promise.resolve()).then(() => writeSource(file, name, entry));
	const settled = write.catch(() => {});
	writing.set(file, settled);
	void settled.then(() => {
		if (writing.get(file) === settled) writing.delete(file);
	});
	return write;
}

async function writeSource(file: string, name: string, entry: SourceEntry): Promise<void> {
	const catalog = await readCatalog(file);
	catalog.sources[name] = entry;
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify({ version: FILE_VERSION, ...catalog }, null, "\t")}\n`);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export interface RefreshOptions {
	/** Ask even when the last answer is newer than the interval. */
	force?: boolean;
	/** Injected in tests; defaults to `Date.now()`. */
	now?: number;
	intervalMs?: number;
	timeoutMs?: number;
}

/**
 * `fresh`: asked within the interval, not asked again. `changed` and `unchanged`: what the source answered.
 * `failed`: no answer; the cached one stays, and it is asked again after the interval.
 */
export type RefreshOutcome = "fresh" | "changed" | "unchanged" | "failed";

/** Asks `source` for its models when its cached answer is older than the interval, and keeps the answer in `file`. */
export async function refreshSource(
	file: string,
	source: CatalogSource,
	options: RefreshOptions = {},
): Promise<RefreshOutcome> {
	const now = options.now ?? Date.now();
	const previous = (await readCatalog(file)).sources[source.name];
	const interval = options.intervalMs ?? CATALOG_REFRESH_INTERVAL_MS;
	if (!options.force && previous !== undefined && now - previous.checkedAt < interval) return "fresh";
	let result: FetchResult | undefined;
	try {
		result = await withinTimeout(source, previous, options.timeoutMs ?? CATALOG_REQUEST_TIMEOUT_MS);
	} catch {
		result = undefined;
	}
	// A first request that failed leaves nothing behind, so the next start asks again.
	if (result === undefined && previous === undefined) return "failed";
	try {
		if (result?.kind === "changed")
			await saveSource(file, source.name, {
				checkedAt: now,
				...(result.etag === undefined ? {} : { etag: result.etag }),
				models: result.models,
			});
		else if (previous) await saveSource(file, source.name, { ...previous, checkedAt: now });
	} catch {
		return "failed";
	}
	return result === undefined ? "failed" : result.kind;
}

/**
 * The source's answer, or a rejection once `timeoutMs` passes: the signal stops its request, and the race covers
 * what it awaits before it (a key, a token, a Claude Code session), which no signal reaches.
 */
function withinTimeout(
	source: CatalogSource,
	previous: SourceEntry | undefined,
	timeoutMs: number,
): Promise<FetchResult> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${source.name} did not answer within ${timeoutMs} ms`);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	return Promise.race([source.fetch(previous, controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Asks every source at once; one that fails or hangs does not hold up the others. */
export async function refreshCatalog(
	file: string,
	sources: readonly CatalogSource[],
	options: RefreshOptions = {},
): Promise<Record<string, RefreshOutcome>> {
	const outcomes = await Promise.all(
		sources.map(async (source) => [source.name, await refreshSource(file, source, options)] as const),
	);
	return Object.fromEntries(outcomes);
}

/**
 * What the catalog's sources say, for the backends' lookups: models.dev's data, under what each backend's provider
 * listed, field by field, since the provider knows its own models best.
 */
export function modelDataOf(catalog: CatalogFile): ModelData {
	const models: CatalogModels = {};
	const listed: CatalogListing = {};
	for (const backend of CATALOG_BACKENDS) {
		const merged = new Map<string, CatalogModel>();
		for (const model of catalog.sources["models.dev"]?.models[backend] ?? []) merged.set(model.id, model);
		const provided = catalog.sources[backend]?.models[backend];
		for (const model of provided ?? []) merged.set(model.id, { ...merged.get(model.id), ...model });
		models[backend] = [...merged.values()];
		if (provided) listed[backend] = provided.map((model) => model.id);
	}
	return new ModelData(models, listed);
}
