import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { hostname, uptime } from "node:os";
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
	/**
	 * A lock that names no process (one written by an older Atelier) and is older than this is taken over. The holder
	 * renews the lock's time three times within it while it holds it.
	 */
	staleLockMs?: number;
	/** How long a refresh waits for another process's lock at least (default 30 s); `lockTimeoutMs` when longer. */
	refreshLockTimeoutMs?: number;
}

const LOCK_TIMEOUT_MS = 5_000;
/** A refresh waits longer: another process may be refreshing, which takes a request to the provider. */
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 10_000;
/**
 * A lock whose process is alive is only taken over once it has not been renewed for this long: by then its id belongs
 * to another process, or the holder was stopped long enough that the sign-in it refreshes is better asked again.
 */
const ABANDONED_LOCK_MS = 10 * 60_000;
/** What a lock that exists but cannot be read holds, for the takeover to compare: no lock written by Atelier holds it. */
const UNREADABLE_LOCK = "\u0000unreadable";
/** How much the clock's idea of when this machine started may be off. */
const BOOT_MARGIN_MS = 5_000;
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
	readonly #refreshLockTimeoutMs: number;

	constructor(file: string, options: AuthStoreOptions = {}) {
		this.#file = file;
		this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
		this.#staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
		this.#refreshLockTimeoutMs = options.refreshLockTimeoutMs ?? REFRESH_LOCK_TIMEOUT_MS;
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

	/** Every key and token stored, to hide wherever it could show (what MCP servers answer). */
	secrets(): string[] {
		return Object.values(this.#read()).flatMap((entry) => {
			if (!isCredential(entry)) return [];
			// Trimmed as the keys are used (resolveApiKey trims), so a padded key is found as it is sent.
			const values = entry.type === "api_key" ? [entry.key] : [entry.access, entry.refresh];
			return values.map((value) => value.trim()).filter((value) => value !== "");
		});
	}

	async set(provider: string, credential: Credential): Promise<void> {
		await this.#change((all) => {
			all[provider] = credential;
		});
	}

	/**
	 * The provider's credential, refreshed first when `stale` says it must be. The refresh runs holding the lock, after
	 * reading the file again: a process that finds it refreshed by another one takes that credential instead, so a
	 * refresh token that the provider replaces on each use is used once. A failed refresh leaves the file as it was.
	 */
	async refreshed(
		provider: string,
		stale: (credential: Credential) => boolean,
		refresh: (credential: Credential) => Promise<Credential>,
	): Promise<Credential | undefined> {
		const current = this.get(provider);
		if (current === undefined || !stale(current)) return current;
		ensureSecretFolder(dirname(this.#file));
		const release = await this.#lock(Math.max(this.#lockTimeoutMs, this.#refreshLockTimeoutMs));
		try {
			const all = this.#read();
			const entry = all[provider];
			if (!isCredential(entry) || !stale(entry)) return isCredential(entry) ? entry : undefined;
			const next = await refresh(entry);
			all[provider] = next;
			writeSecretFile(this.#file, `${JSON.stringify(all, null, "\t")}\n`);
			return next;
		} finally {
			await release();
		}
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

	/**
	 * Creates `<file>.lock`, which only one process can create, naming this process in it; waits while another holds
	 * it. A holder that is alive keeps its lock however slow it is (a refresh waiting on the provider, a stopped
	 * process): taking it over would send the same refresh token twice. The lock of a process that died is taken at
	 * once. While held, the lock's time is renewed, so its age says how long its holder has not run.
	 */
	async #lock(timeoutMs = this.#lockTimeoutMs): Promise<() => Promise<void>> {
		const lock = `${this.#file}.lock`;
		const deadline = Date.now() + timeoutMs;
		// The machine too: a home shared between machines (NFS) holds locks of processes this one cannot see.
		const owner = JSON.stringify({ pid: process.pid, host: hostname(), id: randomUUID() });
		for (;;) {
			try {
				const handle = await open(lock, "wx", 0o600);
				try {
					await handle.writeFile(owner);
				} finally {
					await handle.close();
				}
				const heartbeat = setInterval(() => {
					const now = new Date();
					utimes(lock, now, now).catch(() => {});
				}, this.#staleLockMs / 3);
				heartbeat.unref();
				return async () => {
					clearInterval(heartbeat);
					// Only this holder's own lock: one taken over meanwhile belongs to another process now.
					if ((await readFile(lock, "utf8").catch(() => "")) === owner) await unlink(lock).catch(() => {});
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const seen = await this.#abandoned(lock);
			if (seen !== undefined) {
				await this.#takeOver(lock, seen, owner);
				continue;
			}
			if (Date.now() >= deadline)
				throw new AuthStoreError(`${this.#file} is locked by another Atelier (${lock}); try again`);
			await sleep(LOCK_RETRY_MS);
		}
	}

	/**
	 * What an abandoned lock holds, or undefined while its holder may still run: a process that no longer runs, or no
	 * process named and an old lock.
	 */
	async #abandoned(lock: string): Promise<string | undefined> {
		const [content, age] = await Promise.all([
			readLock(lock),
			stat(lock).then(
				(stats) => Date.now() - stats.mtimeMs,
				() => 0,
			),
		]);
		// Gone meanwhile: the next try creates it.
		if (content === undefined) return undefined;
		const holder = holderOf(content);
		// Empty, of a format this version does not read, or another machine's, whose processes cannot be asked: its holder
		// renews its time, so only its age tells. An empty one may also be a lock created a moment ago, which is not old.
		if (holder === undefined || holder.host !== hostname()) return age > this.#staleLockMs ? content : undefined;
		const { pid } = holder;
		// Older than this machine's start, its holder ended with it, whatever process has its id now.
		const up = upTimeMs();
		if (up !== undefined && age > up + BOOT_MARGIN_MS) return content;
		return !isRunning(pid) || age > ABANDONED_LOCK_MS ? content : undefined;
	}

	/**
	 * Removes the abandoned lock that held `seen`, one waiter at a time: without that, a waiter that judged the old lock
	 * could remove the new one another waiter just took, and both would hold it. `<lock>.break` lets one waiter remove
	 * it, and only while the lock still holds what was judged; the others try again. A breaker that died leaves its
	 * own file, which is judged the same way.
	 */
	async #takeOver(lock: string, seen: string, owner: string): Promise<void> {
		const breaker = `${lock}.break`;
		try {
			const handle = await open(breaker, "wx", 0o600);
			try {
				await handle.writeFile(owner);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stuck = await this.#abandoned(breaker);
			if (stuck !== undefined && (await readLock(breaker)) === stuck) await unlink(breaker).catch(() => {});
			return;
		}
		try {
			if ((await this.#abandoned(lock)) === seen) await unlink(lock).catch(() => {});
		} finally {
			await unlink(breaker).catch(() => {});
		}
	}
}

/** The process and machine a lock names, read by field name; undefined for any other content. */
function holderOf(content: string): { pid: number; host: string } | undefined {
	let fields: unknown;
	try {
		fields = JSON.parse(content);
	} catch {
		return undefined;
	}
	const { pid, host } = (typeof fields === "object" && fields !== null ? fields : {}) as Record<string, unknown>;
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof host === "string"
		? { pid, host }
		: undefined;
}

/**
 * What a lock holds; undefined once it is gone. One that is there but cannot be read (another user's) holds
 * `UNREADABLE_LOCK`, an unknown format whose age alone counts.
 */
function readLock(path: string): Promise<string | undefined> {
	return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? undefined : UNREADABLE_LOCK,
	);
}

/** How long this machine has run; undefined where it cannot be asked (a sandbox may refuse it). */
function upTimeMs(): number | undefined {
	try {
		return uptime() * 1000;
	} catch {
		return undefined;
	}
}

/** Whether a process with this id runs on this machine; one of another user's still runs. */
function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
