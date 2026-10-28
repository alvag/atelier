import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CatalogModels, catalogModels, isRecord, ModelData } from "./model-data.ts";

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

/**
 * Replaces one source's entry: reads the file again, then writes it whole to a temporary next to it and renames it
 * over, so a reader never sees half a file. Two processes writing at once can lose one's answer, never the file:
 * it is asked again at the next refresh.
 */
async function saveSource(file: string, name: string, entry: SourceEntry): Promise<void> {
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
		result = await source.fetch(previous, AbortSignal.timeout(options.timeoutMs ?? CATALOG_REQUEST_TIMEOUT_MS));
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

/** What the catalog's sources say, for the backends' lookups. */
export function modelDataOf(catalog: CatalogFile): ModelData {
	return new ModelData(catalog.sources["models.dev"]?.models ?? {});
}
