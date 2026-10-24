import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { describeViolations } from "./sandbox-blocks.ts";
import { loadSandboxAdditions, type SandboxAdditions } from "./sandbox-config.ts";
import {
	libraryProtectedPaths,
	packageCacheDirectories,
	secretDirectories,
	secretFilePatterns,
} from "./sandbox-paths.ts";

/**
 * The operating-system sandbox for `bash` commands (macOS Seatbelt, through
 * `@anthropic-ai/sandbox-runtime`). It is built for macOS only: elsewhere it
 * reports itself unavailable and the caller decides what that means.
 */

/** What isolates the commands, as clients show it. */
export const SANDBOX_MECHANISM = "macOS seatbelt";
export const NOT_AVAILABLE_ON_PLATFORM = "sandbox not available on this platform";
/** Why there is no sandbox when the user turned it off. */
export const SANDBOX_OFF = "sandbox turned off for this session";

/** The sandbox is on unless `ATELIER_SANDBOX=off`. */
export function sandboxEnabled(env: Record<string, string | undefined>): boolean {
	return env.ATELIER_SANDBOX !== "off";
}

export type SandboxStatus = { available: true } | { available: false; reason: string };

/** The two kinds of caller: the main agent and its workers, or the independent verifier. */
export type SandboxPolicyName = "agent" | "verifier";

/** What the library takes per command: the parts of its configuration that differ from the session-wide one. */
export type SandboxPolicy = Pick<SandboxRuntimeConfig, "filesystem"> & Partial<Pick<SandboxRuntimeConfig, "network">>;

/** A denial the library recorded: `command` is the text of the command that was wrapped. */
export interface SandboxViolation {
	line: string;
	command?: string;
	timestamp: Date;
}

/** The part of the library's `SandboxManager` this module uses; tests pass a fake. */
export interface SandboxManagerLike {
	isSupportedPlatform(): boolean;
	checkDependencies(): { errors: string[]; warnings: string[] };
	initialize(config: SandboxRuntimeConfig, askCallback?: undefined, enableLogMonitor?: boolean): Promise<void>;
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
	): Promise<string>;
	/** Where the library keeps the denials it saw; a fake without it reports none. */
	getSandboxViolationStore?(): { getViolations(): SandboxViolation[] };
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
	/** What the user's and the project's configuration files add; none when absent. */
	additions?: SandboxAdditions;
}

/**
 * The main agent and its workers: they write the working directory, the
 * temporary directories, the package managers' caches and what the
 * configuration files add, and nothing else (the library adds its own fixed
 * protections, such as git hooks and shell start-up files). They read everything
 * but the user's secrets and what the configuration denies, and have the
 * network. The network is left out of the policy on purpose: the library
 * filters it only when `allowedDomains` is set.
 *
 * The configuration only adds. The secret file patterns also hold under every
 * added directory, and `.atelier` of the working directory (the project's
 * configuration) cannot be written by a command.
 */
export function agentPolicy({ cwd, scratchDir, tempDir, home, additions }: AgentPolicyInput): SandboxPolicy {
	const writable = additions?.allowWrite ?? [];
	return {
		filesystem: {
			denyRead: [...secretDirectories(home), ...(additions?.denyRead ?? [])],
			allowWrite: [
				cwd,
				tempDir,
				...(scratchDir === undefined ? [] : [scratchDir]),
				...packageCacheDirectories(home),
				...writable,
			],
			denyWrite: [
				...secretFilePatterns(cwd),
				...writable.flatMap(secretFilePatterns),
				...[cwd, ...writable].flatMap(libraryProtectedPaths),
				join(cwd, ".atelier"),
			],
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
 *   /etc, /private/etc, /dev and Homebrew's /opt/homebrew, which is where
 *   `bash` itself lives on Apple Silicon; and, of /Library, only
 *   /Library/Apple/usr (Rosetta, which x86_64 tools need) and
 *   /Library/Frameworks (third-party frameworks such as Python.framework).
 * The library lets an allowed read win over a denied one, so /Library as a whole
 * cannot be allowed and then narrowed: its Keychains and the rest are left out.
 * The user's home directory is not readable, nor is /Users, /tmp or /private/var.
 * The configuration files add nothing here.
 * `git` does not work here: its Xcode shim reads /var/select (which can be
 * allowed) and then writes a cache in the per-user /var/folders directory, which
 * the verifier must not write; nothing narrow enough opens that.
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
	"/Library/Apple/usr",
	"/Library/Frameworks",
	"/etc",
	"/private/etc",
	"/dev",
	"/opt/homebrew",
];

export interface SandboxOptions {
	/** Never starts: the sandbox is unavailable with this reason (the user turned it off). */
	disabled?: string;
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
		if (this.#options.disabled !== undefined) return { available: false, reason: this.#options.disabled };
		const platform = this.#options.platform ?? process.platform;
		if (platform !== "darwin") return { available: false, reason: NOT_AVAILABLE_ON_PLATFORM };
		try {
			const manager = this.#options.manager ?? (await defaultManager());
			if (!manager.isSupportedPlatform()) return { available: false, reason: NOT_AVAILABLE_ON_PLATFORM };
			const { errors } = manager.checkDependencies();
			if (errors.length > 0) return { available: false, reason: errors.join(", ") };
			// The log monitor is what reports the file denials; the proxy reports the network ones on its own.
			await manager.initialize(SESSION_CONFIG, undefined, true);
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
		const home = this.#options.home ?? homedir();
		const config =
			policy === "agent"
				? agentPolicy({
						cwd,
						...(scratchDir === undefined ? {} : { scratchDir }),
						tempDir: this.#options.tempDir ?? tmpdir(),
						home,
						// Read at each command, so a file that became invalid stops the command instead of being ignored.
						additions: loadSandboxAdditions({ cwd, home }),
					})
				: verifierPolicy({ dir: cwd, nodePrefix: this.#options.nodePrefix ?? nodeInstallation() });
		return this.#manager.wrapWithSandbox(command, "bash", config, signal);
	}

	/**
	 * What the sandbox blocked in `command` since `since`: the library's
	 * denials with that command text, recorded at or after `since`, described
	 * as causes. The library cannot say which of two concurrent runs of the
	 * same text a denial belongs to, and the log it reads the file denials
	 * from can lag (or miss the first seconds after the start), so this is
	 * best effort: it never reports a cause the library did not see.
	 * Waits up to `graceMs` for the first one to arrive.
	 */
	async blocks(
		command: string,
		{ since, policy, graceMs = 0 }: { since: Date; policy: SandboxPolicyName; graceMs?: number },
	): Promise<string[]> {
		const store = this.#manager?.getSandboxViolationStore?.();
		if (!store) return [];
		const deadline = Date.now() + graceMs;
		for (;;) {
			const mine = store.getViolations().filter((v) => v.command === command && v.timestamp >= since);
			const causes = describeViolations(
				mine.map((v) => v.line),
				policy,
			);
			if (causes.length > 0 || Date.now() >= deadline) return causes;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
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
