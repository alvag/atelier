import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How many distinct prompts a project keeps. */
export const PROMPT_HISTORY_LIMIT = 100;
/** The longest prompt kept, in UTF-8 bytes; a longer one stays in the session's memory history only. */
export const PROMPT_HISTORY_MAX_BYTES = 64 * 1024;

const RECORD = /^\d{15}-[0-9a-f-]{36}\.json$/;
const TEMPORARY = /^\.tmp-([1-9]\d*)-[0-9a-f-]{36}$/;
const TEMP_MIN_AGE = 24 * 60 * 60 * 1000;
/** A record is a small JSON wrapper around the text, so its file cannot be much larger than the text. */
const MAX_RECORD_BYTES = PROMPT_HISTORY_MAX_BYTES * 6 + 256;

type WarningOperation = "save" | "read" | "delete";

interface StoredPrompt {
	name: string;
	createdAt: number;
	text: string;
}

/** A reused PID, EPERM or any uncertain probe keeps the temporary; only ESRCH proves its owner gone. */
function ownerIsDead(pid: number): boolean {
	if (!Number.isSafeInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
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
async function readRecord(
	dir: string,
	name: string,
	readOnly: boolean,
	onError: (error: unknown) => void,
): Promise<StoredPrompt | undefined> {
	const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") onError(error);
			return undefined;
		},
	);
	if (file === undefined) return undefined;
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
		if (!readOnly) await file.chmod(0o600);
		const data: unknown = JSON.parse(await file.readFile("utf8"));
		if (typeof data !== "object" || data === null) return undefined;
		const { version, createdAt, text } = data as { version?: unknown; createdAt?: unknown; text?: unknown };
		if (version !== 1 || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
		if (typeof text !== "string" || text !== text.trim() || text === "") return undefined;
		if (Buffer.byteLength(text) > PROMPT_HISTORY_MAX_BYTES) return undefined;
		return { name, createdAt, text };
	} catch (error) {
		if (!(error instanceof SyntaxError)) onError(error);
		return undefined;
	} finally {
		await file.close().catch(onError);
	}
}

/**
 * The prompts typed in one project, kept across runs under `<home>/.atelier/prompt-history/<sha256 of the real cwd>/`
 * as one immutable file per prompt. Nothing is locked or rewritten: writers publish unique files by rename, and a
 * prune deletes only the records it read that are old or repeated. The caller passes the final expanded text of a
 * prompt (pasted text and file references already in), never a placeholder; attachments are not stored.
 * A read-only store (for `--no-session`) reads what exists but never creates, chmods, prunes or writes anything.
 * Every failure is non-fatal: history carries on in memory, with independent once-only save, access and cleanup warnings.
 */
export class PromptHistory {
	readonly #dir: string | undefined;
	readonly #onWarning: ((message: string) => void) | undefined;
	readonly #readOnly: boolean;
	readonly #warned = new Set<WarningOperation>();
	#last = 0;
	#entries: string[];

	private constructor(
		dir: string | undefined,
		entries: string[],
		onWarning?: (message: string) => void,
		readOnly = false,
	) {
		this.#dir = dir;
		this.#readOnly = readOnly;
		this.#entries = entries;
		this.#onWarning = onWarning;
	}

	/** Open the history of `cwd` under `home`, the same home a `SessionStore` takes. Never rejects. */
	static async open(
		home: string,
		cwd: string,
		onWarning?: (message: string) => void,
		options: { readOnly?: boolean } = {},
	): Promise<PromptHistory> {
		const readOnly = options.readOnly === true;
		const history = new PromptHistory(undefined, [], onWarning, readOnly);
		try {
			const real = await realpath(cwd);
			const base = join(home, ".atelier");
			if (readOnly) return await PromptHistory.#openReadOnly(base, real, onWarning);
			await mkdir(base, { recursive: true, mode: 0o700 });
			await requireDir(base);
			const root = join(base, "prompt-history");
			await privateDir(root);
			const dir = join(root, createHash("sha256").update(real).digest("hex"));
			await privateDir(dir);
			const opened = new PromptHistory(dir, [], onWarning, false);
			opened.#entries = await opened.#load();
			await opened.#cleanTemporaries();
			return opened;
		} catch (error) {
			history.#warn(error, "read");
			return history;
		}
	}

	/** Load the records of `real` under `base` without touching the disk; missing storage is just an empty history. */
	static async #openReadOnly(base: string, real: string, onWarning?: (message: string) => void) {
		const dir = join(base, "prompt-history", createHash("sha256").update(real).digest("hex"));
		const history = new PromptHistory(dir, [], onWarning, true);
		try {
			await history.#directory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new PromptHistory(undefined, [], onWarning, true);
			throw error;
		}
		history.#entries = await history.#load();
		return history;
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
		if (this.#dir === undefined || this.#readOnly) return;
		try {
			await this.#directory();
		} catch (error) {
			this.#warn(error, "read");
			return;
		}
		try {
			// Strictly increasing within this process, so records written in one millisecond keep their order.
			const createdAt = Math.max(Date.now(), this.#last + 1);
			this.#last = createdAt;
			const name = `${String(createdAt).padStart(15, "0")}-${randomUUID()}.json`;
			const temp = join(this.#dir, `.tmp-${process.pid}-${randomUUID()}`);
			const file = await open(temp, "wx", 0o600);
			try {
				try {
					await file.writeFile(JSON.stringify({ version: 1, createdAt, text: trimmed }));
				} finally {
					await file.close();
				}
				await rename(temp, join(this.#dir, name));
			} catch (error) {
				// Exclusive open owns this name only until publication; a successful rename consumes it.
				await this.#removeFile(temp);
				throw error;
			}
			this.#entries = await this.#load().catch((error) => {
				this.#warn(error, "read");
				return this.#entries;
			});
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

	/** Reclaim only old, regular temporaries with a provably dead owner; never called by read-only opens. */
	async #cleanTemporaries(): Promise<void> {
		try {
			const dir = await this.#directory();
			const cutoff = Date.now() - TEMP_MIN_AGE;
			for (const name of await readdir(dir)) {
				const match = TEMPORARY.exec(name);
				if (match === null) continue;
				try {
					const path = join(dir, name);
					const info = await lstat(path);
					if (!info.isFile() || info.mtimeMs >= cutoff || !ownerIsDead(Number(match[1]))) continue;
					await this.#removeFile(path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#warn(error, "read");
				}
			}
		} catch (error) {
			this.#warn(error, "read");
		}
	}

	/** The kept texts oldest first; unless read-only, it also deletes the old and repeated records. */
	async #load(): Promise<string[]> {
		const dir = await this.#directory();
		const names = (await readdir(dir)).filter((name) => RECORD.test(name));
		const read = await Promise.all(
			names.map((name) => readRecord(dir, name, this.#readOnly, (error) => this.#warn(error, "read"))),
		);
		const records = read.filter((record): record is StoredPrompt => record !== undefined);
		records.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
		this.#last = Math.max(this.#last, records[0]?.createdAt ?? 0);
		const kept = new Set<string>();
		const stale: string[] = [];
		for (const record of records) {
			if (kept.size < PROMPT_HISTORY_LIMIT && !kept.has(record.text)) kept.add(record.text);
			else stale.push(record.name);
		}
		if (!this.#readOnly) await Promise.all(stale.map((name) => this.#removeFile(join(dir, name))));
		return [...kept].reverse();
	}

	/** Only a failed unlink warrants deletion advice; another writer may already have removed the file. */
	async #removeFile(path: string): Promise<void> {
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#warn(error, "delete");
		}
	}

	#warn(error: unknown, operation: WarningOperation = "save"): void {
		if (this.#warned.has(operation)) return;
		this.#warned.add(operation);
		const reason = error instanceof Error ? error.message : String(error);
		const messages = {
			save: "prompt history is not saved",
			read: "prompt history storage is unavailable",
			delete: `could not delete old prompt history entries or temporary files in ${JSON.stringify(this.#dir)}; close this project's TUIs and delete them manually`,
		};
		try {
			this.#onWarning?.(`${messages[operation]}: ${reason}`);
		} catch {
			// Reporting unavailable history must never make it a startup or submission failure.
		}
	}
}
