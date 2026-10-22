import { execFile } from "node:child_process";

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
	platform?: NodeJS.Platform;
	runSecurity?: SecurityRunner;
}

/** Runs macOS `security` by absolute path, without a shell. */
export const runSecurity: SecurityRunner = (args) =>
	new Promise((resolve) => {
		execFile("/usr/bin/security", [...args], { timeout: SECURITY_TIMEOUT_MS }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
			resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
		});
	});

/**
 * Finds the Anthropic API key: ANTHROPIC_API_KEY when it is set for this
 * command, otherwise the macOS Keychain. Atelier never stores or logs it.
 */
export async function resolveApiKey(sources: ApiKeySources = {}): Promise<string> {
	const fromEnv = (sources.env ?? process.env).ANTHROPIC_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	if ((sources.platform ?? process.platform) !== "darwin")
		throw new MissingApiKeyError("No Anthropic API key. Set ANTHROPIC_API_KEY for this command.");

	const result = await (sources.runSecurity ?? runSecurity)(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
	const missing = new MissingApiKeyError(`No Anthropic API key in the Keychain. Store it with: ${STORE_KEY_COMMAND}`);
	if (result.code === ITEM_NOT_FOUND) throw missing;
	// stdout may hold the key: only stderr goes into the message.
	if (result.code !== 0)
		throw new KeychainError(`The Keychain could not be read (security exit ${result.code}): ${result.stderr.trim()}`);
	const key = result.stdout.trim();
	if (!key) throw missing;
	return key;
}
