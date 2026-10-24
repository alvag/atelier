import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

/**
 * The operating-system sandbox for `bash` commands (macOS Seatbelt, through
 * `@anthropic-ai/sandbox-runtime`). It is built for macOS only: elsewhere it
 * reports itself unavailable and the caller decides what that means.
 */

export const NOT_AVAILABLE_ON_PLATFORM = "sandbox not available on this platform";

export type SandboxStatus = { available: true } | { available: false; reason: string };

/** The two kinds of caller: the main agent and its workers, or the independent verifier. */
export type SandboxPolicyName = "agent" | "verifier";

/** What the library takes per command: the parts of its configuration that differ from the session-wide one. */
export type SandboxPolicy = Pick<SandboxRuntimeConfig, "filesystem"> & Partial<Pick<SandboxRuntimeConfig, "network">>;

/** The part of the library's `SandboxManager` this module uses; tests pass a fake. */
export interface SandboxManagerLike {
	isSupportedPlatform(): boolean;
	checkDependencies(): { errors: string[]; warnings: string[] };
	initialize(config: SandboxRuntimeConfig): Promise<void>;
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
	): Promise<string>;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
}

export interface AgentPolicyInput {
	cwd: string;
	/** The session's temporary directory, when it has one. */
	scratchDir?: string;
	/** The system temporary directory. */
	tempDir: string;
	home: string;
}

/** Files that hold secrets in a project: no command may write them, wherever they sit under the working directory. */
function secretFilePatterns(cwd: string): string[] {
	return [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"].map((pattern) => join(cwd, pattern));
}

/** What the user keeps private: no command of the main agent may read it. */
function secretDirectories(home: string): string[] {
	return [".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains", ".claude"].map((path) => join(home, path));
}

/**
 * The main agent and its workers: they write the working directory, the
 * temporary directories and nothing else (the library adds its own fixed
 * protections, such as git hooks and shell start-up files), read everything
 * but the user's secrets, and have the network. The network is left out of the
 * policy on purpose: the library filters it only when `allowedDomains` is set.
 */
export function agentPolicy({ cwd, scratchDir, tempDir, home }: AgentPolicyInput): SandboxPolicy {
	return {
		filesystem: {
			denyRead: secretDirectories(home),
			allowWrite: [cwd, tempDir, ...(scratchDir === undefined ? [] : [scratchDir])],
			denyWrite: secretFilePatterns(cwd),
		},
	};
}

export interface VerifierPolicyInput {
	/** The verifier's temporary directory, also its working directory. */
	dir: string;
	/** The Node installation that runs the project's tools: the directory above `bin/`. */
	nodePrefix: string;
}

/**
 * The independent verifier: it writes only its own temporary directory and
 * has no network (an empty allow list routes every connection to the
 * library's proxy, which refuses all of them; the Seatbelt profile allows no
 * other socket). It reads nothing but:
 * - its directory, where the copies and their dependencies live;
 * - the Node installation that runs the project's tools;
 * - the system toolchain and configuration: /usr, /bin, /sbin, /System,
 *   /Library, /etc, /private/etc, /dev and Homebrew's /opt/homebrew, which is
 *   where `bash` itself lives on Apple Silicon.
 * The user's home directory is not readable, nor is /Users, /tmp or /private/var.
 */
export function verifierPolicy({ dir, nodePrefix }: VerifierPolicyInput): SandboxPolicy {
	return {
		network: { allowedDomains: [], deniedDomains: ["*"] },
		filesystem: {
			denyRead: ["/"],
			allowRead: [dir, nodePrefix, ...SYSTEM_READ_PATHS],
			allowWrite: [dir],
			denyWrite: [],
		},
	};
}

const SYSTEM_READ_PATHS = [
	"/usr",
	"/bin",
	"/sbin",
	"/System",
	"/Library",
	"/etc",
	"/private/etc",
	"/dev",
	"/opt/homebrew",
];

export interface SandboxOptions {
	/** Defaults to the current platform; tests set it to exercise the unavailable path. */
	platform?: NodeJS.Platform;
	manager?: SandboxManagerLike;
	/** Defaults to the user's home directory; tests point it at a fake one. */
	home?: string;
	/** Defaults to the system temporary directory. */
	tempDir?: string;
	/** Defaults to the Node installation that runs this process. */
	nodePrefix?: string;
}

export interface WrapOptions {
	policy: SandboxPolicyName;
	cwd: string;
	scratchDir?: string;
	signal?: AbortSignal;
}

async function defaultManager(): Promise<SandboxManagerLike> {
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	return SandboxManager;
}

/** What the library is started with: no `allowedDomains`, so the network is not filtered unless a policy says so. */
const SESSION_CONFIG = {
	network: { deniedDomains: ["*"] },
	filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
} as unknown as SandboxRuntimeConfig;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the library once, on first use, and wraps commands with the policy of
 * their caller. A failure to start is remembered: the sandbox stays
 * unavailable, with the library's reason, until `reset()`.
 */
export class Sandbox {
	readonly #options: SandboxOptions;
	#ready: Promise<SandboxStatus> | undefined;
	#manager: SandboxManagerLike | undefined;

	constructor(options: SandboxOptions = {}) {
		this.#options = options;
	}

	status(): Promise<SandboxStatus> {
		this.#ready ??= this.#start();
		return this.#ready;
	}

	async #start(): Promise<SandboxStatus> {
		const platform = this.#options.platform ?? process.platform;
		if (platform !== "darwin") return { available: false, reason: NOT_AVAILABLE_ON_PLATFORM };
		try {
			const manager = this.#options.manager ?? (await defaultManager());
			if (!manager.isSupportedPlatform()) return { available: false, reason: NOT_AVAILABLE_ON_PLATFORM };
			const { errors } = manager.checkDependencies();
			if (errors.length > 0) return { available: false, reason: errors.join(", ") };
			await manager.initialize(SESSION_CONFIG);
			this.#manager = manager;
			return { available: true };
		} catch (error) {
			return { available: false, reason: errorMessage(error) };
		}
	}

	/** The command line that runs `command` under the policy; throws when the sandbox is unavailable. */
	async wrap(command: string, { policy, cwd, scratchDir, signal }: WrapOptions): Promise<string> {
		const status = await this.status();
		if (!status.available || !this.#manager) throw new Error(status.available ? "sandbox not started" : status.reason);
		const config =
			policy === "agent"
				? agentPolicy({
						cwd,
						...(scratchDir === undefined ? {} : { scratchDir }),
						tempDir: this.#options.tempDir ?? tmpdir(),
						home: this.#options.home ?? homedir(),
					})
				: verifierPolicy({ dir: cwd, nodePrefix: this.#options.nodePrefix ?? nodeInstallation() });
		return this.#manager.wrapWithSandbox(command, "bash", config, signal);
	}

	/** Call after each wrapped command has finished. */
	cleanup(): void {
		this.#manager?.cleanupAfterCommand();
	}

	/** Stops the library's proxies; the next command starts it again. */
	async reset(): Promise<void> {
		const manager = this.#manager;
		this.#ready = undefined;
		this.#manager = undefined;
		await manager?.reset();
	}
}

/** The directory above `bin/node`, with symbolic links resolved (nvm and Homebrew both link it). */
function nodeInstallation(): string {
	return dirname(dirname(realpathSync(process.execPath)));
}

/** The one the tools share: the library is process-wide, so is this. */
export const sandbox = new Sandbox();
