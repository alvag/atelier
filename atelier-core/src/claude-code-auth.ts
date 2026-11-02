import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { AuthStore, authFile } from "./auth-store.ts";
import { CodexAccess, codexVariantFrom } from "./backends/openai-codex/access.ts";
import { endApart, spawnApart } from "./claude-apart.ts";
import {
	apiKeySource,
	MISSING_API_KEY_MESSAGE,
	MISSING_OPENCODE_GO_KEY_MESSAGE,
	openCodeGoKeySource,
} from "./credentials.ts";
import { BACKEND_NAMES, type BackendName } from "./protocol/types.ts";

/** What `claude auth status --json` says; `authMethod` is `claude.ai` for a Claude subscription. */
export interface ClaudeCodeAuthStatus {
	loggedIn: boolean;
	authMethod: string;
	email?: string;
	subscriptionType?: string;
}

export class ClaudeCodeAuthError extends Error {
	override name = "ClaudeCodeAuthError";
	readonly code = "claude_code_auth";
}

export interface ClaudeCodeRunOptions {
	/** The binary; defaults to the one of the Agent SDK that Atelier installs, the one the `claude-code` backend runs. */
	executable?: string;
	env?: Record<string, string | undefined>;
	/** Runs the binary in a process group of its own (`spawnApart`): inside a Herdr pane, where it is told to. */
	apart?: boolean;
	/** How long `auth status` may take; STATUS_TIMEOUT_MS when absent. */
	statusTimeoutMs?: number;
}

const STATUS_TIMEOUT_MS = 15_000;
/** The most output `auth status` may print: what execFile keeps by default. */
const STATUS_MAX_BYTES = 1024 * 1024;
const NOT_FOUND = "Claude Code binary not found (reinstall Atelier)";

/** Why the binary could not be started: not there at all, or another failure. */
const runError = (executable: string, error: Error & { code?: string | number | null | undefined }) =>
	new ClaudeCodeAuthError(
		error.code === "ENOENT" ? NOT_FOUND : `Claude Code could not be run (${executable}): ${error.message}`,
	);

/**
 * The Claude Code binary of the Agent SDK's package for this platform, found as the SDK finds it when no
 * `pathToClaudeCodeExecutable` is given; undefined when it is not installed.
 */
export function bundledClaudeCode(): string | undefined {
	const require = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
	const arch = process.arch;
	const packages =
		process.platform === "linux" ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${process.platform}-${arch}`];
	const name = process.platform === "win32" ? "claude.exe" : "claude";
	for (const suffix of packages) {
		try {
			const path = require.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/${name}`);
			if (existsSync(path)) return path;
		} catch {
			// Not this package.
		}
	}
	return undefined;
}

/** The binary to run, or the reason there is none. */
function executableOf(options: ClaudeCodeRunOptions): string {
	const executable = options.executable ?? bundledClaudeCode();
	if (executable === undefined) throw new ClaudeCodeAuthError(NOT_FOUND);
	return executable;
}

/** The environment Claude Code runs with: without ANTHROPIC_API_KEY, as the `claude-code` backend runs it. */
function envOf(options: ClaudeCodeRunOptions): Record<string, string | undefined> {
	const env = { ...(options.env ?? process.env) };
	delete env.ANTHROPIC_API_KEY;
	return env;
}

/** Asks the binary which account it is logged in with; it answers from its own files, without the network. */
export async function claudeCodeAuthStatus(options: ClaudeCodeRunOptions = {}): Promise<ClaudeCodeAuthStatus> {
	const executable = executableOf(options);
	const args = ["auth", "status", "--json"];
	const timeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
	const stdout = await (options.apart === true ? outputApart : output)(executable, args, envOf(options), timeoutMs);
	const status = parseStatus(stdout);
	if (status === undefined) throw new ClaudeCodeAuthError("Claude Code's auth status could not be read.");
	return status;
}

/** What the binary prints, whatever its exit code: not logged in exits with 1 and still prints the status. */
function output(
	executable: string,
	args: string[],
	env: Record<string, string | undefined>,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executable, args, { env, timeout: timeoutMs }, (error, stdout) => {
			if (error !== null && typeof error.code !== "number") reject(runError(executable, error));
			else resolve(stdout);
		});
	});
}

/**
 * As `output`, with the binary in a process group of its own. Output past STATUS_MAX_BYTES, or no answer within
 * `timeoutMs`, fails at once and ends the group as its watcher does (TERM, the grace, then KILL), even for a binary
 * that ignores TERM.
 */
function outputApart(
	executable: string,
	args: string[],
	env: Record<string, string | undefined>,
	timeoutMs: number,
): Promise<string> {
	// The shell that becomes the binary cannot say ENOENT as execFile does: a path that is not there is told first.
	if (executable.includes("/") && !existsSync(executable)) return Promise.reject(new ClaudeCodeAuthError(NOT_FOUND));
	return new Promise((resolve, reject) => {
		const child = spawnApart(executable, args, { env, stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const settle = (error: Error | undefined, stdout = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === undefined) resolve(stdout);
			else reject(error);
		};
		const giveUp = (reason: string) => {
			endApart(child);
			settle(new ClaudeCodeAuthError(`Claude Code could not be run (${executable}): ${reason}`));
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > STATUS_MAX_BYTES) giveUp("stdout maxBuffer length exceeded");
			else chunks.push(chunk);
		});
		const timer = setTimeout(() => giveUp(`no answer within ${timeoutMs} ms`), timeoutMs);
		child.on("error", (error) => settle(runError(executable, error)));
		child.on("close", (code) => {
			// It exits with 127 when there is no such command, with 126 when it cannot run it.
			if (code === 127) settle(new ClaudeCodeAuthError(NOT_FOUND));
			else if (code === 126 || code === null)
				settle(new ClaudeCodeAuthError(`Claude Code could not be run (${executable})`));
			// Decoded whole, so a character that comes in two chunks is read as one.
			else settle(undefined, Buffer.concat(chunks).toString("utf8"));
		});
	});
}

function parseStatus(stdout: string): ClaudeCodeAuthStatus | undefined {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof parsed?.loggedIn !== "boolean" || typeof parsed.authMethod !== "string") return undefined;
	return {
		loggedIn: parsed.loggedIn,
		authMethod: parsed.authMethod,
		...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
		...(typeof parsed.subscriptionType === "string" ? { subscriptionType: parsed.subscriptionType } : {}),
	};
}

/** How a status reads in `/login` and `atelier login`. */
export function describeClaudeCodeAuth(status: ClaudeCodeAuthStatus): string {
	if (!status.loggedIn) return "not logged in";
	if (status.authMethod === "claude.ai") {
		const details = [status.subscriptionType, status.email].filter((detail) => detail !== undefined);
		return `subscription configured${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
	}
	if (status.authMethod === "api_key") return "logged in with an Anthropic Console key (billed to the API)";
	return `logged in (${status.authMethod})`;
}

export interface ClaudeCodeInteractiveOptions extends ClaudeCodeRunOptions {
	/** `inherit` hands the terminal to Claude Code, which opens the browser and may ask to paste a code. */
	stdio?: "inherit" | "ignore";
}

function runInteractive(args: string[], options: ClaudeCodeInteractiveOptions): Promise<number> {
	const executable = executableOf(options);
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { env: envOf(options), stdio: options.stdio ?? "inherit" });
		child.on("error", (error) => reject(runError(executable, error)));
		child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
	});
}

/** Runs Claude Code's own sign-in to a Claude subscription; resolves with its exit code. */
export function claudeCodeLogin(options: ClaudeCodeInteractiveOptions = {}): Promise<number> {
	return runInteractive(["auth", "login", "--claudeai"], options);
}

/** Signs Claude Code out: the same login as the Claude Code installed on this machine, which is signed out too. */
export function claudeCodeLogout(options: ClaudeCodeInteractiveOptions = {}): Promise<number> {
	return runInteractive(["auth", "logout"], options);
}

export interface LoginWarningOptions extends ClaudeCodeRunOptions {
	/** Where `atelier login` keeps keys; `~/.atelier/auth.json` when absent. */
	store?: AuthStore;
	platform?: NodeJS.Platform;
}

/** Why a session on `openai-codex` has no ChatGPT sign-in to use, or undefined when it has one. */
function codexWarning(store: AuthStore, env: Record<string, string | undefined>): string | undefined {
	try {
		const variant = codexVariantFrom(env);
		void new CodexAccess({ store, ...(variant === undefined ? {} : { variant }) }).variant;
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * What a session on `backend` lacks to start working, said before the first prompt: Claude Code's login for
 * `claude-code`, an API key for `anthropic-api` or `opencode-go`, a ChatGPT sign-in for `openai-codex`. Undefined when
 * nothing is missing or the backend needs none of them.
 */
export async function loginWarning(backend: string, options: LoginWarningOptions = {}): Promise<string | undefined> {
	const keys = {
		env: options.env ?? process.env,
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.platform === undefined ? {} : { platform: options.platform }),
	};
	const store = options.store ?? new AuthStore(authFile(homedir()));
	if (backend === "anthropic-api")
		return (await apiKeySource(keys)) === undefined ? MISSING_API_KEY_MESSAGE : undefined;
	if (backend === "opencode-go")
		return openCodeGoKeySource(keys) === undefined ? MISSING_OPENCODE_GO_KEY_MESSAGE : undefined;
	if (backend === "openai-codex") return codexWarning(store, keys.env);
	if (backend !== "claude-code") return undefined;
	let status: ClaudeCodeAuthStatus;
	try {
		status = await claudeCodeAuthStatus(options);
	} catch (error) {
		return `Claude Code's login could not be checked: ${(error as Error).message}`;
	}
	if (status.loggedIn) return undefined;
	const others = [
		...((await apiKeySource(keys)) === undefined ? [] : [", or --backend anthropic-api to use your Anthropic API key"]),
		...(openCodeGoKeySource(keys) === undefined ? [] : [", or --backend opencode-go to use your OpenCode Go key"]),
		...(codexWarning(store, {}) === undefined ? [", or --backend openai-codex to use your ChatGPT sign-in"] : []),
	];
	return `Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account${others.join("")}.`;
}

/** The backends a session could run on now: those `loginWarning` finds nothing missing for, in `BACKEND_NAMES` order. */
export async function signedInBackends(options: LoginWarningOptions = {}): Promise<BackendName[]> {
	const missing = await Promise.all(BACKEND_NAMES.map((backend) => loginWarning(backend, options)));
	return BACKEND_NAMES.filter((_, index) => missing[index] === undefined);
}
