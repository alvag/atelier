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

/**
 * The entry that keeps the window Claude Code ran each model with, as its sessions say it: no source asks for it,
 * and no refresh replaces it.
 */
export const CLAUDE_CODE_RUNS = "claude-code-runs";

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
	/**
	 * Whether the user is signed in to the source, checked without reading a credential; without a sign-in `fetch`
	 * is not called. Absent: the source needs none.
	 */
	available?(): Promise<boolean>;
	fetch(previous: SourceEntry | undefined, signal: AbortSignal): Promise<FetchResult>;
}

/** The catalog of `home`: `~/.atelier/models.json`. It holds no credential, and it is rebuilt from the sources. */
export function catalogFile(home: string): string {
	return join(home, ".atelier", "models.json");
}

/** A time a date can hold: a check time out of that range is not one, and its source is dropped. */
const isTime = (value: unknown): value is number =>
	typeof value === "number" && !Number.isNaN(new Date(value).getTime());

/** The catalog in `file`; a missing or broken file, or a source of another shape, reads as no answer. */
export async function readCatalog(file: string): Promise<CatalogFile> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return { sources: {} };
	}
	if (!isRecord(parsed) || !isRecord(parsed.sources)) return { sources: {} };
	// Built from entries, so a source named `__proto__` stays an entry and never becomes the object's prototype.
	const entries = Object.entries(parsed.sources).flatMap(([name, entry]): [string, SourceEntry][] =>
		isRecord(entry) && isTime(entry.checkedAt)
			? [
					[
						name,
						{
							checkedAt: entry.checkedAt,
							...(typeof entry.etag === "string" ? { etag: entry.etag } : {}),
							models: catalogModels(entry.models),
						},
					],
				]
			: [],
	);
	return { sources: Object.fromEntries(entries) };
}

/** The last write to each file in this process: the next one waits for it, so no source's answer is lost here. */
const writing = new Map<string, Promise<void>>();

/**
 * Replaces one source's entry: reads the file again, then writes it whole to a temporary next to it and renames it
 * over, so a reader never sees half a file. Two processes writing at once can lose one's answer, never the file:
 * it is asked again at the next refresh.
 */
function saveSource(file: string, name: string, entry: SourceEntry): Promise<void> {
	return queued(file, () => writeSource(file, name, () => entry));
}

/**
 * Writes one source's entry as `update` makes it from the entry in the file now (undefined when there is none);
 * nothing is written when `update` answers undefined.
 */
export function updateSource(
	file: string,
	name: string,
	update: (entry: SourceEntry | undefined) => SourceEntry | undefined,
): Promise<void> {
	return queued(file, () => writeSource(file, name, update));
}

function queued(file: string, write: () => Promise<void>): Promise<void> {
	const done = (writing.get(file) ?? Promise.resolve()).then(write);
	const settled = done.catch(() => {});
	writing.set(file, settled);
	void settled.then(() => {
		if (writing.get(file) === settled) writing.delete(file);
	});
	return done;
}

async function writeSource(
	file: string,
	name: string,
	next: (current: SourceEntry | undefined) => SourceEntry | undefined,
): Promise<void> {
	const catalog = await readCatalog(file);
	const entry = next(Object.hasOwn(catalog.sources, name) ? catalog.sources[name] : undefined);
	if (entry === undefined) return;
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
 * `failed`: no answer; the cached one stays as it was, and the source is asked again at the next refresh.
 * `skipped`: not signed in to it, so nothing was asked; the cached answer stays.
 */
export type RefreshOutcome = "fresh" | "changed" | "unchanged" | "failed" | "skipped";

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
	let result: FetchResult | "skipped" | undefined;
	try {
		result = await withinTimeout(source, previous, options.timeoutMs ?? CATALOG_REQUEST_TIMEOUT_MS);
	} catch {
		result = undefined;
	}
	// A failure leaves the file as it was, so the next refresh asks again instead of waiting out the interval.
	if (result === undefined) return "failed";
	if (result === "skipped") return "skipped";
	try {
		if (result.kind === "changed")
			await saveSource(file, source.name, {
				checkedAt: now,
				...(result.etag === undefined ? {} : { etag: result.etag }),
				models: result.models,
			});
		else if (previous) await saveSource(file, source.name, { ...previous, checkedAt: now });
	} catch {
		return "failed";
	}
	return result.kind;
}

/**
 * The source's answer, `skipped` when the user is not signed in to it, or a rejection once `timeoutMs` passes: the
 * signal stops its request, and the race covers what it awaits before it (the sign-in check, a key, a token, a
 * Claude Code session), which no signal reaches.
 */
function withinTimeout(
	source: CatalogSource,
	previous: SourceEntry | undefined,
	timeoutMs: number,
): Promise<FetchResult | "skipped"> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${source.name} did not answer within ${timeoutMs} ms`);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	const ask = async (): Promise<FetchResult | "skipped"> => {
		if (source.available && !(await source.available())) return "skipped";
		return source.fetch(previous, controller.signal);
	};
	return Promise.race([ask(), timeout]).finally(() => clearTimeout(timer));
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
		const own = (name: string) => (Object.hasOwn(catalog.sources, name) ? catalog.sources[name] : undefined);
		const listOf = (name: string) => {
			const list = own(name)?.models?.[backend];
			return Array.isArray(list) ? list : undefined;
		};
		for (const model of listOf("models.dev") ?? []) merged.set(model.id, model);
		const provided = listOf(backend);
		// The windows Claude Code ran its models with come after its list, which says none; they list no model.
		for (const model of [...(provided ?? []), ...(listOf(CLAUDE_CODE_RUNS) ?? [])])
			merged.set(model.id, { ...merged.get(model.id), ...model });
		models[backend] = [...merged.values()];
		if (provided) listed[backend] = provided.map((model) => model.id);
	}
	return new ModelData(models, listed);
}
