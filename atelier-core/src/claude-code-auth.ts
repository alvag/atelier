import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

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
}

const STATUS_TIMEOUT_MS = 15_000;

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
	if (executable === undefined)
		throw new ClaudeCodeAuthError(
			`Claude Code is not installed for ${process.platform}-${process.arch}; reinstall Atelier.`,
		);
	return executable;
}

/** The environment Claude Code runs with: without ANTHROPIC_API_KEY, as the `claude-code` backend runs it. */
function envOf(options: ClaudeCodeRunOptions): Record<string, string | undefined> {
	const env = { ...(options.env ?? process.env) };
	delete env.ANTHROPIC_API_KEY;
	return env;
}

/** Asks the binary which account it is logged in with; it answers from its own files, without the network. */
export function claudeCodeAuthStatus(options: ClaudeCodeRunOptions = {}): Promise<ClaudeCodeAuthStatus> {
	const executable = executableOf(options);
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			["auth", "status", "--json"],
			{ env: envOf(options), timeout: STATUS_TIMEOUT_MS },
			(error, stdout) => {
				// Not logged in exits with 1 and still prints the status.
				if (error !== null && typeof error.code !== "number") {
					reject(new ClaudeCodeAuthError(`Claude Code could not be run (${executable}): ${error.message}`));
					return;
				}
				const status = parseStatus(stdout);
				if (status === undefined) reject(new ClaudeCodeAuthError("Claude Code's auth status could not be read."));
				else resolve(status);
			},
		);
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
		child.on("error", (error) =>
			reject(new ClaudeCodeAuthError(`Claude Code could not be run (${executable}): ${error.message}`)),
		);
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
