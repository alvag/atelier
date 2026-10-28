import { open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureSecretFolder, readSecretFile, writeSecretFile } from "./secret-file.ts";

/** A key the provider's API takes as it is. */
export interface ApiKeyCredential {
	type: "api_key";
	key: string;
}

/** An account's tokens, refreshed before `expires` (milliseconds since the epoch). */
export interface OAuthCredential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
}

export type Credential = ApiKeyCredential | OAuthCredential;

export class AuthStoreError extends Error {
	override name = "AuthStoreError";
	readonly code = "auth_store_error";
}

export interface AuthStoreOptions {
	/** How long a change waits for another process's lock before it fails. */
	lockTimeoutMs?: number;
	/** A lock older than this was left by a process that died, and is taken over. */
	staleLockMs?: number;
}

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 20;

export function authFile(home: string): string {
	return join(home, ".atelier", "auth.json");
}

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	if (entry.type === "api_key") return typeof entry.key === "string" && entry.key !== "";
	if (entry.type === "oauth")
		return typeof entry.access === "string" && typeof entry.refresh === "string" && typeof entry.expires === "number";
	return false;
}

/**
 * The providers' credentials in `~/.atelier/auth.json`, one entry per provider id (`anthropic`, ...), which only the
 * user can read or write (`0600`, in a `0700` folder; see `secret-file.ts`, which never follows a link). A change locks
 * the file against other processes, reads it again, and replaces it whole with a rename, so a reader never sees half
 * of it and no change is lost.
 */
export class AuthStore {
	readonly #file: string;
	readonly #lockTimeoutMs: number;
	readonly #staleLockMs: number;

	constructor(file: string, options: AuthStoreOptions = {}) {
		this.#file = file;
		this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
		this.#staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
	}

	get file(): string {
		return this.#file;
	}

	get(provider: string): Credential | undefined {
		const entry = this.#read()[provider];
		return isCredential(entry) ? entry : undefined;
	}

	/** The providers that have a credential, in the file's order. */
	providers(): string[] {
		return Object.entries(this.#read()).flatMap(([provider, entry]) => (isCredential(entry) ? [provider] : []));
	}

	async set(provider: string, credential: Credential): Promise<void> {
		await this.#change((all) => {
			all[provider] = credential;
		});
	}

	/** Deletes the provider's credential; says whether there was one. */
	async remove(provider: string): Promise<boolean> {
		let had = false;
		await this.#change((all) => {
			had = isCredential(all[provider]);
			delete all[provider];
		});
		return had;
	}

	/** Every entry as written, those of a shape this version does not know included, so a change keeps them. */
	#read(): Record<string, unknown> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readSecretFile(this.#file) ?? "");
		} catch {
			return {};
		}
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	}

	async #change(apply: (all: Record<string, unknown>) => void): Promise<void> {
		ensureSecretFolder(dirname(this.#file));
		const release = await this.#lock();
		try {
			const all = this.#read();
			apply(all);
			writeSecretFile(this.#file, `${JSON.stringify(all, null, "\t")}\n`);
		} finally {
			await release();
		}
	}

	/** Creates `<file>.lock`, which only one process can create; waits while another holds it. */
	async #lock(): Promise<() => Promise<void>> {
		const lock = `${this.#file}.lock`;
		const deadline = Date.now() + this.#lockTimeoutMs;
		for (;;) {
			try {
				const handle = await open(lock, "wx", 0o600);
				await handle.close();
				return () => unlink(lock).catch(() => {});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const age = await stat(lock).then(
				(stats) => Date.now() - stats.mtimeMs,
				() => 0,
			);
			if (age > this.#staleLockMs) {
				await unlink(lock).catch(() => {});
				continue;
			}
			if (Date.now() >= deadline)
				throw new AuthStoreError(`${this.#file} is locked by another Atelier (${lock}); try again`);
			await sleep(LOCK_RETRY_MS);
		}
	}
}
