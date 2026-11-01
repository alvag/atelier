import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How many distinct prompts a project keeps. */
export const PROMPT_HISTORY_LIMIT = 100;
/** The longest prompt kept, in UTF-8 bytes; a longer one stays in the session's memory history only. */
export const PROMPT_HISTORY_MAX_BYTES = 64 * 1024;

const RECORD = /^\d{15}-[0-9a-f-]{36}\.json$/;
/** A record is a small JSON wrapper around the text, so its file cannot be much larger than the text. */
const MAX_RECORD_BYTES = PROMPT_HISTORY_MAX_BYTES * 6 + 256;

interface StoredPrompt {
	name: string;
	createdAt: number;
	text: string;
}

async function requireDir(path: string): Promise<void> {
	if (!(await lstat(path)).isDirectory()) throw new Error(`${path} is not a directory (symbolic links are refused)`);
}

async function privateDir(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	await requireDir(path);
	await chmod(path, 0o700);
}

/** The record in `name`, or undefined when it is missing, not a plain file, or not a version 1 record within bounds. */
async function readRecord(dir: string, name: string): Promise<StoredPrompt | undefined> {
	const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
		() => undefined,
	);
	if (file === undefined) return undefined;
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
		await file.chmod(0o600);
		const data: unknown = JSON.parse(await file.readFile("utf8"));
		if (typeof data !== "object" || data === null) return undefined;
		const { version, createdAt, text } = data as { version?: unknown; createdAt?: unknown; text?: unknown };
		if (version !== 1 || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
		if (typeof text !== "string" || text !== text.trim() || text === "") return undefined;
		if (Buffer.byteLength(text) > PROMPT_HISTORY_MAX_BYTES) return undefined;
		return { name, createdAt, text };
	} catch {
		return undefined;
	} finally {
		await file.close();
	}
}

/**
 * The prompts typed in one project, kept across runs under `<home>/.atelier/prompt-history/<sha256 of the real cwd>/`
 * as one immutable file per prompt. Nothing is locked or rewritten: writers publish unique files by rename, and a
 * prune deletes only the records it read that are old or repeated. The caller passes the final expanded text of a
 * prompt (pasted text and file references already in), never a placeholder; attachments are not stored.
 * Every failure is non-fatal: the history carries on in memory and `onWarning` hears of the first one.
 */
export class PromptHistory {
	readonly #dir: string | undefined;
	readonly #onWarning: ((message: string) => void) | undefined;
	#warned = false;
	#last = 0;
	#entries: string[];

	private constructor(dir: string | undefined, entries: string[], onWarning?: (message: string) => void) {
		this.#dir = dir;
		this.#entries = entries;
		this.#onWarning = onWarning;
	}

	/** Open the history of `cwd` under `home`, the same home a `SessionStore` takes. Never rejects. */
	static async open(home: string, cwd: string, onWarning?: (message: string) => void): Promise<PromptHistory> {
		const history = new PromptHistory(undefined, [], onWarning);
		try {
			const real = await realpath(cwd);
			const base = join(home, ".atelier");
			await mkdir(base, { recursive: true, mode: 0o700 });
			await requireDir(base);
			const root = join(base, "prompt-history");
			await privateDir(root);
			const dir = join(root, createHash("sha256").update(real).digest("hex"));
			await privateDir(dir);
			const opened = new PromptHistory(dir, [], onWarning);
			opened.#entries = await opened.#prune();
			return opened;
		} catch (error) {
			history.#warn(error);
			return history;
		}
	}

	/** The remembered prompts, oldest first. */
	get entries(): readonly string[] {
		return this.#entries;
	}

	/** Remember `text` (trimmed); blank and oversized prompts are ignored. Never rejects. */
	async add(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed === "" || Buffer.byteLength(trimmed) > PROMPT_HISTORY_MAX_BYTES) return;
		this.#entries = [...this.#entries.filter((entry) => entry !== trimmed), trimmed].slice(-PROMPT_HISTORY_LIMIT);
		if (this.#dir === undefined) return;
		try {
			await this.#directory();
			// Strictly increasing within this process, so records written in one millisecond keep their order.
			const createdAt = Math.max(Date.now(), this.#last + 1);
			this.#last = createdAt;
			const name = `${String(createdAt).padStart(15, "0")}-${randomUUID()}.json`;
			const temp = join(this.#dir, `.tmp-${randomUUID()}`);
			await writeFile(temp, JSON.stringify({ version: 1, createdAt, text: trimmed }), { flag: "wx", mode: 0o600 });
			await rename(temp, join(this.#dir, name)).catch(async (error) => {
				await rm(temp, { force: true });
				throw error;
			});
			this.#entries = await this.#prune();
		} catch (error) {
			this.#warn(error);
		}
	}

	/** Recheck ancestors before each operation: an opened store must not follow a later replacement link. */
	async #directory(): Promise<string> {
		const dir = this.#dir as string;
		for (const path of [dirname(dirname(dir)), dirname(dir), dir]) await requireDir(path);
		return dir;
	}

	/** Read the records, delete the old and repeated ones, and return the kept texts oldest first. */
	async #prune(): Promise<string[]> {
		const dir = await this.#directory();
		const names = (await readdir(dir)).filter((name) => RECORD.test(name));
		const read = await Promise.all(names.map((name) => readRecord(dir, name)));
		const records = read.filter((record): record is StoredPrompt => record !== undefined);
		records.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
		this.#last = Math.max(this.#last, records[0]?.createdAt ?? 0);
		const kept = new Set<string>();
		const stale: string[] = [];
		for (const record of records) {
			if (kept.size < PROMPT_HISTORY_LIMIT && !kept.has(record.text)) kept.add(record.text);
			else stale.push(record.name);
		}
		await Promise.all(stale.map((name) => rm(join(dir, name), { force: true }).catch(() => undefined)));
		return [...kept].reverse();
	}

	#warn(error: unknown): void {
		if (this.#warned) return;
		this.#warned = true;
		const reason = error instanceof Error ? error.message : String(error);
		try {
			this.#onWarning?.(`prompt history is not saved: ${reason}`);
		} catch {
			// Reporting unavailable history must never make it a startup or submission failure.
		}
	}
}
