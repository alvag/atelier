import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { AuthStore, authFile } from "./auth-store.ts";

/** Keychain service that holds the Anthropic API key. */
export const KEYCHAIN_SERVICE = "atelier-anthropic";
/** Prompts for the key, so it never lands in the shell history. */
export const STORE_KEY_COMMAND = `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "$USER" -w`;
/** errSecItemNotFound, as `security` reports it. */
const ITEM_NOT_FOUND = 44;
/** Long enough for the user to answer a Keychain access prompt. */
const SECURITY_TIMEOUT_MS = 60_000;

export class MissingApiKeyError extends Error {
	override name = "MissingApiKeyError";
	readonly code = "missing_api_key";
}

export class KeychainError extends Error {
	override name = "KeychainError";
	readonly code = "keychain_error";
}

export interface SecurityResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type SecurityRunner = (args: readonly string[]) => Promise<SecurityResult>;

export interface ApiKeySources {
	env?: Record<string, string | undefined>;
	/** Where `atelier login` keeps the key; defaults to `~/.atelier/auth.json`. */
	store?: AuthStore;
	platform?: NodeJS.Platform;
	runSecurity?: SecurityRunner;
}

/** Where the key comes from: ANTHROPIC_API_KEY, `atelier login`, or the macOS Keychain. */
export type ApiKeySource = "env" | "stored" | "keychain";

/** The provider id of the Anthropic API key in `auth.json`. */
export const ANTHROPIC_PROVIDER = "anthropic";

export const MISSING_API_KEY_MESSAGE =
	"No Anthropic API key. Store one with `atelier login api-key anthropic` (/login in a session), or set ANTHROPIC_API_KEY.";

/** Runs macOS `security` by absolute path, without a shell. */
export const runSecurity: SecurityRunner = (args) =>
	new Promise((resolve) => {
		execFile("/usr/bin/security", [...args], { timeout: SECURITY_TIMEOUT_MS }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
			resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
		});
	});

const fromEnv = (sources: ApiKeySources) => (sources.env ?? process.env).ANTHROPIC_API_KEY?.trim() || undefined;

function storedKey(sources: ApiKeySources): string | undefined {
	const credential = (sources.store ?? new AuthStore(authFile(homedir()))).get(ANTHROPIC_PROVIDER);
	return credential?.type === "api_key" ? credential.key.trim() || undefined : undefined;
}

/**
 * Finds the Anthropic API key: ANTHROPIC_API_KEY when it is set for this command, then the key `atelier login` stored
 * in `~/.atelier/auth.json`, then the macOS Keychain. Atelier never logs it.
 */
export async function resolveApiKey(sources: ApiKeySources = {}): Promise<string> {
	const key = fromEnv(sources) ?? storedKey(sources);
	if (key) return key;

	if ((sources.platform ?? process.platform) !== "darwin") throw new MissingApiKeyError(MISSING_API_KEY_MESSAGE);

	const result = await (sources.runSecurity ?? runSecurity)(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
	const missing = new MissingApiKeyError(MISSING_API_KEY_MESSAGE);
	if (result.code === ITEM_NOT_FOUND) throw missing;
	// stdout may hold the key: only stderr goes into the message.
	if (result.code !== 0)
		throw new KeychainError(`The Keychain could not be read (security exit ${result.code}): ${result.stderr.trim()}`);
	const fromKeychain = result.stdout.trim();
	if (!fromKeychain) throw missing;
	return fromKeychain;
}

/** Where `resolveApiKey` would take the key from, asking the Keychain only whether it has one, never for the key. */
export async function apiKeySource(sources: ApiKeySources = {}): Promise<ApiKeySource | undefined> {
	if (fromEnv(sources)) return "env";
	if (storedKey(sources)) return "stored";
	if ((sources.platform ?? process.platform) !== "darwin") return undefined;
	const result = await (sources.runSecurity ?? runSecurity)(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
	return result.code === 0 ? "keychain" : undefined;
}
