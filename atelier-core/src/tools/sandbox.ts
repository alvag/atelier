import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
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
export const INSIDE_SANDBOX =
	"already inside a sandbox, and macOS cannot nest them: commands stay confined by the outer one";

/**
 * Whether this process already runs inside a macOS sandbox, as when Atelier
 * runs its own tests from a sandboxed command: macOS refuses to apply a second
 * profile. Probed with the smallest profile there is, never trusted from the
 * environment, so nothing outside a sandbox can claim to be inside one. Only
 * macOS's own refusal (`sandbox_apply: Operation not permitted`) counts: any
 * other failure leaves the question to the library's dependency check.
 */
export function isInsideSandbox(): boolean {
	if (process.platform !== "darwin") return false;
	const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
		encoding: "utf8",
		stdio: ["ignore", "ignore", "pipe"],
		timeout: 5000,
	});
	return probe.status !== 0 && /sandbox_apply: Operation not permitted/.test(probe.stderr ?? "");
}
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

/**
 * A denial the library recorded: `command` is the text of the command that was
 * wrapped, `encodedCommand` the key of the run it came from (absent when the
 * library could not tell).
 */
export interface SandboxViolation {
	line: string;
	command?: string;
	encodedCommand?: string;
	timestamp: Date;
}

/** The key the library records a run's denials under: the first 100 characters of its id, in base64. */
function runKey(runId: string): string {
	return Buffer.from(runId.slice(0, 100)).toString("base64");
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
		options?: { commandId?: string; commandText?: string },
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
	/** The git data of a linked worktree that lives in the main checkout; absent anywhere else. */
	worktreeGit?: WorktreeGit;
}

/** Where a linked worktree's git data lives: its own directory and the repository's shared one. */
export interface WorktreeGit {
	/** `<common>/worktrees/<name>`: the worktree's HEAD, index and logs. */
	gitDir: string;
	/** The main checkout's `.git`, shared by every worktree. */
	commonDir: string;
}

/**
 * The git data a linked worktree needs to write, which lives outside it, in
 * the main checkout's `.git`: its own directory there and the repository's
 * objects, refs and their logs. The shared hooks and configuration stay
 * protected, as in the working directory itself.
 */
function worktreeGitPaths(worktreeGit: WorktreeGit | undefined): { allowWrite: string[]; denyWrite: string[] } {
	if (worktreeGit === undefined) return { allowWrite: [], denyWrite: [] };
	const { gitDir, commonDir } = worktreeGit;
	return {
		allowWrite: [
			gitDir,
			join(commonDir, "objects"),
			join(commonDir, "refs"),
			join(commonDir, "logs"),
			join(commonDir, "packed-refs"),
			// Taken while refs are updated or packed.
			join(commonDir, "packed-refs.lock"),
		],
		denyWrite: [join(commonDir, "hooks"), join(commonDir, "config")],
	};
}

const worktreeGitCache = new Map<string, WorktreeGit | null>();

/** The git directories of `cwd` when it is a linked worktree whose shared `.git` is outside it; asked once per folder. */
export function linkedWorktreeGit(cwd: string): WorktreeGit | undefined {
	if (!worktreeGitCache.has(cwd)) {
		const found = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			timeout: 5000,
		});
		const [gitDir, commonDir] = found.status === 0 ? found.stdout.trim().split("\n") : [];
		const linked =
			gitDir !== undefined &&
			commonDir !== undefined &&
			gitDir !== commonDir &&
			commonDir !== join(cwd, ".git") &&
			!commonDir.startsWith(`${cwd}/`);
		worktreeGitCache.set(cwd, linked ? { gitDir, commonDir } : null);
	}
	return worktreeGitCache.get(cwd) ?? undefined;
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
export function agentPolicy({
	cwd,
	scratchDir,
	tempDir,
	home,
	additions,
	worktreeGit,
}: AgentPolicyInput): SandboxPolicy {
	const writable = additions?.allowWrite ?? [];
	const worktree = worktreeGitPaths(worktreeGit);
	return {
		filesystem: {
			denyRead: [...secretDirectories(home), ...(additions?.denyRead ?? [])],
			allowWrite: [
				cwd,
				tempDir,
				...(scratchDir === undefined ? [] : [scratchDir]),
				...packageCacheDirectories(home),
				...worktree.allowWrite,
				...writable,
			],
			denyWrite: [
				...worktree.denyWrite,
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
	/** The developer directory's `usr/`, where the real `git` lives; absent when there is none. */
	toolchain?: string;
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** `{ [key]: value }`, or nothing when the value is absent. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** The readable toolchain directory for a `git` at `<dev>/usr/bin/git`. */
function toolchainOf(git: string | undefined): { toolchain?: string } {
	return git === undefined ? {} : { toolchain: dirname(dirname(git)) };
}

/** Where the real `git` of the active developer directory is, found once outside any sandbox; undefined without one. */
let developerGitCache: string | null | undefined;
export function developerGit(): string | undefined {
	if (developerGitCache === undefined) {
		developerGitCache = null;
		if (process.platform === "darwin") {
			const found = spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8", timeout: 5000 });
			const path = found.status === 0 ? found.stdout.trim() : "";
			if (path.startsWith("/") && path !== "/usr/bin/git" && existsSync(path)) developerGitCache = path;
		}
	}
	return developerGitCache ?? undefined;
}

/**
 * What the verifier's commands run with: the real `git` first on the PATH, a
 * home and a temporary directory inside its own (the user's home is not
 * readable, and tools such as git read their configuration from home even when
 * a caller clears the GIT_* variables), and no system or global git configuration.
 */
export function verifierEnvironment(dir: string, git: string | undefined = developerGit()): Record<string, string> {
	const tmp = join(dir, ".tmp");
	const home = join(dir, ".home");
	mkdirSync(tmp, { recursive: true });
	mkdirSync(home, { recursive: true });
	return {
		...(git === undefined ? {} : { PATH: `${dirname(git)}:${process.env.PATH ?? ""}` }),
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		TMPDIR: tmp,
	};
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
 * The `/usr/bin/git` shim does not work here (it reads /var/select and writes a
 * cache in the per-user /var/folders directory), so the verifier runs the real
 * `git` of the active developer directory instead: `toolchain` is that
 * directory's `usr/`, readable, and `verifierEnvironment` puts its `bin/` first
 * on the PATH.
 */
export function verifierPolicy({ dir, nodePrefix, toolchain }: VerifierPolicyInput): SandboxPolicy {
	return {
		network: { allowedDomains: [], deniedDomains: ["*"] },
		filesystem: {
			denyRead: ["/"],
			allowRead: [dir, nodePrefix, ...(toolchain === undefined ? [] : [toolchain]), ...SYSTEM_READ_PATHS],
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
	// The system's choice of shell and developer directory (`sh`, `developer_dir`): /bin/sh reads it on every start.
	"/private/var/select",
];

export interface SandboxOptions {
	/** Never starts: the sandbox is unavailable with this reason (the user turned it off). */
	disabled?: string;
	/** Defaults to the current platform; tests set it to exercise the unavailable path. */
	platform?: NodeJS.Platform;
	/** Defaults to probing macOS, unless a manager is given (tests); tests set it to exercise the nested path. */
	insideSandbox?: () => boolean;
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
	/** A unique id for this run: the library records its denials under it, so `blocks` can tell them from another run's. */
	runId?: string;
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
		const inside = this.#options.insideSandbox ?? (this.#options.manager ? () => false : isInsideSandbox);
		if (inside()) return { available: false, reason: INSIDE_SANDBOX };
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
	async wrap(command: string, { policy, cwd, scratchDir, signal, runId }: WrapOptions): Promise<string> {
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
						...(this.#options.manager ? {} : optional("worktreeGit", linkedWorktreeGit(cwd))),
					})
				: verifierPolicy({
						dir: cwd,
						nodePrefix: this.#options.nodePrefix ?? nodeInstallation(),
						...toolchainOf(this.#options.manager ? undefined : developerGit()),
					});
		// The library hands every command TMPDIR=/tmp/claude, which the verifier cannot even look up (it does not read
		// /tmp): its commands get a temporary directory inside its own, set in the command so it wins.
		const script = policy === "verifier" ? `export TMPDIR=${shellQuote(join(cwd, ".tmp"))}\n${command}` : command;
		return this.#manager.wrapWithSandbox(
			script,
			"bash",
			config,
			signal,
			runId === undefined ? undefined : { commandId: runId, commandText: command },
		);
	}

	/**
	 * What the sandbox blocked in the run wrapped with `runId`: the library's
	 * denials recorded under that run's key, described as causes. A denial the
	 * library could not attribute to a run, or attributed to another one (an
	 * overlapping run of the same text included), is not taken. The log the
	 * file denials come from can lag (or miss the first seconds after the
	 * start), so this is best effort: it never reports a cause the library did
	 * not see for this run. Waits up to `graceMs` for the first one to arrive.
	 */
	async blocks(
		runId: string,
		{ policy, graceMs = 0 }: { policy: SandboxPolicyName; graceMs?: number },
	): Promise<string[]> {
		const store = this.#manager?.getSandboxViolationStore?.();
		if (!store) return [];
		const key = runKey(runId);
		const deadline = Date.now() + graceMs;
		for (;;) {
			const mine = store.getViolations().filter((v) => v.encodedCommand === key);
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
