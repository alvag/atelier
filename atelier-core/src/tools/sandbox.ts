import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { borrowTmpdir } from "../scratch.ts";
import { describeViolations } from "./sandbox-blocks.ts";
import { loadSandboxAdditions, type SandboxAdditions } from "./sandbox-config.ts";
import {
	configFilePaths,
	configPath,
	includedConfigFiles,
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
	/** The git places that run code, as `gitProtectedPaths` finds them; none outside a repository. */
	gitPaths?: string[];
}

/** Where a linked worktree's git data lives: its own directory and the repository's shared one. */
export interface WorktreeGit {
	/** `<common>/worktrees/<name>`: the worktree's HEAD, index and logs. */
	gitDir: string;
	/** The main checkout's `.git`, shared by every worktree. */
	commonDir: string;
	/** The hooks directory git runs, `core.hooksPath` included, when it differs from `<common>/hooks`. */
	hooks?: string;
}

/**
 * The git data a linked worktree needs to write, which lives outside it, in
 * the main checkout's `.git`: its own directory there and the repository's
 * objects, refs and their logs. Protected, because writing them would make git
 * run code or work on another repository: the shared hooks and configuration,
 * the worktree's `config.worktree` (a `core.hooksPath` there runs a hook the
 * next time the user commits, outside the sandbox), its `commondir` and
 * `gitdir` (which point git elsewhere) and the objects' alternates. The secret
 * file patterns also hold in every directory added here.
 */
export function worktreeGitPaths(worktreeGit: WorktreeGit | undefined): { allowWrite: string[]; denyWrite: string[] } {
	if (worktreeGit === undefined) return { allowWrite: [], denyWrite: [] };
	const { gitDir, commonDir, hooks } = worktreeGit;
	const directories = [gitDir, join(commonDir, "objects"), join(commonDir, "refs"), join(commonDir, "logs")];
	return {
		allowWrite: [
			...directories,
			join(commonDir, "packed-refs"),
			// Taken and renamed while refs are updated or packed.
			join(commonDir, "packed-refs.lock"),
			join(commonDir, "packed-refs.new"),
		],
		denyWrite: [
			join(commonDir, "hooks"),
			// A configured core.hooksPath may sit in a directory granted above, such as refs/.
			...(hooks === undefined ? [] : [hooks]),
			join(commonDir, "config"),
			join(commonDir, "config.worktree"),
			join(commonDir, "objects", "info"),
			join(gitDir, "config.worktree"),
			join(gitDir, "commondir"),
			join(gitDir, "gitdir"),
			join(gitDir, "hooks"),
			...operationStatePaths(gitDir),
			...directories.flatMap(secretFilePatterns),
		],
	};
}

/**
 * The pending steps of a rebase (`rebase-merge/`, `rebase-apply/`) and of a
 * cherry-pick or revert (`sequencer/`) in a git directory. A command that
 * writes them, such as an `exec` line in `rebase-merge/git-rebase-todo`, makes
 * the `git rebase --continue` or `git cherry-pick --continue` the user runs
 * later, outside the sandbox, run that code. So they are never writable, whether
 * they exist or not: inside the sandbox those git commands fail and are run
 * outside it, with approval. A linked worktree keeps them in its own git
 * directory; the shared one is not writable there, so `<common>/sequencer`
 * (the main checkout's) needs no entry.
 */
export function operationStatePaths(gitDir: string): string[] {
	return ["rebase-merge", "rebase-apply", "sequencer"].map((name) => join(gitDir, name));
}

/**
 * Every place of the repository `cwd` belongs to where git runs code or is
 * pointed elsewhere, as git itself reports it, so it holds whether the git
 * directory is inside `cwd` or not (a subdirectory of a repository, a linked
 * worktree, a `.git` file): the hooks directory git runs (`core.hooksPath`
 * included), the `config` and `config.worktree` of the git directory and of
 * the shared one, every file they include (read from the files, not from git),
 * `info/attributes` (it selects filters), the submodules' git directories
 * (`modules/`), the pending steps of a rebase or cherry-pick, the `.git` file
 * when it is a file, and the linked worktree's own set. Asked at each call,
 * because the configuration can change. Empty outside a repository. When git
 * cannot answer inside one (a broken included file makes `rev-parse` fail), the
 * same set is derived by reading the repository's files, so the agent cannot
 * switch the protection off by breaking the configuration.
 */
export function gitProtectedPaths(cwd: string, home: string = homedir()): string[] {
	const found = spawnSync(
		"git",
		[
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--absolute-git-dir",
			"--git-common-dir",
			"--git-path",
			"hooks",
		],
		{ cwd, encoding: "utf8", timeout: 5000 },
	);
	const [top, gitDir, commonDir, hooks] = found.status === 0 ? found.stdout.trim().split("\n") : [];
	if (found.status === 0 && [top, gitDir, commonDir, hooks].every((path) => path?.startsWith("/")))
		return repositoryPaths(top as string, gitDir as string, commonDir as string, [hooks as string], home, cwd);
	const repository = repositoryFromFiles(cwd);
	if (repository === undefined) return [];
	const { top: root, gitDir: dir, commonDir: common } = repository;
	const hooksPaths = [dir, common]
		.flatMap((d) => [join(d, "config"), join(d, "config.worktree")])
		.flatMap((file) => [file, ...includedConfigFiles([file], home)])
		.map((file) => configFilePaths(file).hooksPath)
		.flatMap((value) => (value === undefined ? [] : [configPath(value, root, home)]));
	return repositoryPaths(root, dir, common, hooksPaths, home, cwd);
}

function repositoryPaths(
	top: string,
	gitDir: string,
	commonDir: string,
	hooks: string[],
	home: string,
	cwd: string,
): string[] {
	const configs = [gitDir, commonDir].flatMap((dir) => [join(dir, "config"), join(dir, "config.worktree")]);
	return [
		...hooks,
		...[gitDir, commonDir].flatMap((dir) => [join(dir, "hooks"), join(dir, "info", "attributes")]),
		join(commonDir, "modules"),
		// The local profile pin: the user's choice of profile, not the agent's.
		join(commonDir, "atelier"),
		...configs,
		...includedConfigFiles(configs, home),
		...operationStatePaths(gitDir),
		// A link to the git directory is not the directory: protecting it whole would be more than a plain `.git` gets.
		...(isRegularFile(join(top, ".git")) ? [join(top, ".git")] : []),
		...worktreeGitPaths(linkedWorktreeGit(cwd)).denyWrite.filter((path) => !path.includes("*")),
	];
}

/** The repository `cwd` is in, found by looking for `.git` upward and reading it, for when git does not answer. */
function repositoryFromFiles(cwd: string): { top: string; gitDir: string; commonDir: string } | undefined {
	for (let top = cwd; ; top = dirname(top)) {
		const dot = join(top, ".git");
		if (existsSync(dot)) {
			let gitDir = dot;
			if (isRegularFile(dot)) {
				const named = /^gitdir:\s*(.+)$/m.exec(readFileOr(dot));
				if (named?.[1] === undefined) return { top, gitDir: dot, commonDir: dot };
				gitDir = resolve(top, named[1].trim());
			}
			const common = readFileOr(join(gitDir, "commondir")).trim();
			return { top, gitDir, commonDir: common === "" ? gitDir : resolve(gitDir, common) };
		}
		if (dirname(top) === top) return undefined;
	}
}

function readFileOr(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Whether `path` is a regular file; not a directory, not a link, not missing. */
function isRegularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

const worktreeGitCache = new Map<string, WorktreeGit | null>();

/**
 * The git directories of `cwd` when it is a linked worktree whose shared
 * `.git` is outside it; asked once per folder. What git answers is checked
 * against the files git keeps for a worktree, so a tampered `commondir` cannot
 * point the grant at another repository: the worktree's directory must be
 * `<common>/worktrees/<name>`, and its `gitdir` file must point back at this
 * worktree's `.git` file.
 */
export function linkedWorktreeGit(cwd: string): WorktreeGit | undefined {
	if (!worktreeGitCache.has(cwd)) {
		const found = spawnSync(
			"git",
			[
				"rev-parse",
				"--path-format=absolute",
				"--git-dir",
				"--git-common-dir",
				"--show-toplevel",
				"--git-path",
				"hooks",
			],
			{ cwd, encoding: "utf8", timeout: 5000 },
		);
		const [gitDir, commonDir, top, hooks] = found.status === 0 ? found.stdout.trim().split("\n") : [];
		const linked =
			gitDir !== undefined &&
			commonDir !== undefined &&
			top !== undefined &&
			gitDir !== commonDir &&
			dirname(gitDir) === join(commonDir, "worktrees") &&
			!commonDir.startsWith(`${top}/`) &&
			pointsBack(gitDir, top);
		worktreeGitCache.set(
			cwd,
			linked ? { gitDir, commonDir, ...(hooks && hooks !== join(commonDir, "hooks") ? { hooks } : {}) } : null,
		);
	}
	return worktreeGitCache.get(cwd) ?? undefined;
}

/** Whether the worktree's `gitdir` file names `<top>/.git`, as `git worktree add` writes it. */
function pointsBack(gitDir: string, top: string): boolean {
	try {
		const named = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
		return realpathSync(named) === realpathSync(join(top, ".git"));
	} catch {
		return false;
	}
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
	gitPaths = [],
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
				...gitPaths,
				...secretFilePatterns(cwd),
				...writable.flatMap(secretFilePatterns),
				...[cwd, ...writable].flatMap(libraryProtectedPaths),
				...[cwd, ...writable].flatMap((dir) => operationStatePaths(join(dir, ".git"))),
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
 * The user's home directory is not readable, nor is /Users, /tmp or /private/var,
 * except for the time zone: /private/var/db/timezone, /private/var/select and
 * the /var link itself, through which /etc/localtime leads.
 * Of the folders above its directory it reads only each one's package.json:
 * Node looks for the nearest one to resolve a module and stops with an error
 * when the read is denied, instead of going on as it does for a missing file.
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
			allowRead: [
				dir,
				nodePrefix,
				...(toolchain === undefined ? [] : [toolchain]),
				...SYSTEM_READ_PATHS,
				...parentPackageFiles(dir),
			],
			allowWrite: [dir],
			denyWrite: [],
		},
	};
}

/** The package.json of every folder above `dir`, nearest first, up to the root. */
function parentPackageFiles(dir: string): string[] {
	const files: string[] = [];
	for (let folder = dirname(dir); ; folder = dirname(folder)) {
		files.push(join(folder, "package.json"));
		if (dirname(folder) === folder) return files;
	}
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
	// The time zone: /etc/localtime leads through the /var link and the links of the time zone database, which
	// tools such as diff resolve one by one. Only the link itself is allowed of /var: the sandbox checks the
	// resolved path of what is opened, so this does not open /private/var.
	"/var",
	"/private/var/db/timezone",
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
	/** Where the short folder for the library's socket goes when TMPDIR is too long; `/tmp` by default. */
	socketRoot?: string;
	/** Defaults to the Node installation that runs this process. */
	nodePrefix?: string;
	/**
	 * Whether the profile for the commands the user's rules cover can run; defaults to trying it once on macOS, or to yes
	 * with a manager (tests), where that profile wraps nothing, like the manager.
	 */
	outside?: () => boolean;
}

/** Whether `sandbox-exec` applies a profile here: not on another platform, nor inside another sandbox. */
function sandboxExecWorks(): boolean {
	if (process.platform !== "darwin") return false;
	const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
		stdio: "ignore",
		timeout: 5000,
	});
	return probe.status === 0;
}

/** A path of a policy as a Seatbelt filter: a glob (with `*` or `**`) as a regular expression, anything else as itself and below. */
function seatbeltFilter(path: string): string {
	if (!path.includes("*")) return `(subpath ${JSON.stringify(path)})`;
	const regex = path
		.split(/(\*\*\/|\*)/)
		.map((part) => (part === "**/" ? "(.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.^$+?()[\]{}|\\"]/g, "\\$&")))
		.join("");
	return `(regex #"^${regex}$")`;
}

/** The real path of `place`, or undefined when it cannot be resolved or is the same. */
function realOther(place: string): string | undefined {
	try {
		const real = realpathSync(place);
		return real === place ? undefined : real;
	} catch {
		return undefined;
	}
}

/**
 * The profile a command the user's rules cover runs under: everything is allowed, as outside the sandbox, except
 * writing `~/.atelier`, where the rules and the default mode live, and what the main sandbox never lets a command
 * write (`denyWrite`: git hooks and configuration, rebase steps, shell start-up and editor files, secret files).
 * Seatbelt compares real paths, so each place under the home or the working directory is denied by its real path too.
 */
export function outsideProfile(home: string, denyWrite: readonly string[] = [], cwd?: string): string {
	const bases = [home, ...(cwd === undefined ? [] : [cwd])].flatMap((base) => {
		const real = realOther(base);
		return real === undefined ? [] : [{ base, real }];
	});
	const atelier = join(home, ".atelier");
	const places = new Set([atelier, ...denyWrite]);
	const linked = realOther(atelier);
	if (linked !== undefined) places.add(linked);
	for (const place of [...places])
		for (const { base, real } of bases)
			if (place === base || place.startsWith(`${base}/`)) places.add(real + place.slice(base.length));
	const denied = [...places].map(seatbeltFilter).join(" ");
	return `(version 1)\n(allow default)\n(deny file-write* ${denied})\n(deny file-write-unlink file-write-create ${moveBlocking(places)})\n`;
}

/**
 * What keeps a denied place from being moved away, written under another name and moved back, as the library does
 * for the main sandbox: the place itself, the folder a glob is bounded by, and every folder above them, by name only.
 */
function moveBlocking(places: Iterable<string>): string {
	const filters = new Set<string>();
	for (const place of places) {
		filters.add(seatbeltFilter(place));
		const star = place.indexOf("*");
		let folder = star < 0 ? place : dirname(place.slice(0, star + 1));
		if (star >= 0) filters.add(`(literal ${JSON.stringify(folder)})`);
		for (folder = dirname(folder); folder !== "/" && folder !== "."; folder = dirname(folder))
			filters.add(`(literal ${JSON.stringify(folder)})`);
	}
	return [...filters].join(" ");
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

/** What macOS allows for the path of a Unix socket, without its final NUL. */
const MAX_SOCKET_PATH = 103;

/**
 * Whether the socket the library makes in the temporary folder for its proxy
 * (`srt-mux-<pid>-<n>.sock`, with no option for another place) fits there.
 */
function socketFits(dir: string): boolean {
	return Buffer.byteLength(join(dir, `srt-mux-${process.pid}-zzzz.sock`)) <= MAX_SOCKET_PATH;
}

/**
 * `<root>/atelier-<uid>`, made 0700 if it is missing; anything else there (a
 * link, a file, a directory of another user or that others can open) is refused.
 */
function ownShortDir(root: string): string {
	const dir = join(root, `atelier-${process.getuid?.() ?? 0}`);
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = lstatSync(dir);
	if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
		throw new Error(`${dir} is not a directory of this user's own (mode 0700)`);
	return dir;
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
			const initialize = () => manager.initialize(SESSION_CONFIG, undefined, true);
			// A socket that does not fit fails with EINVAL: the library starts with TMPDIR in a short folder instead.
			if (socketFits(tmpdir())) await initialize();
			else await borrowTmpdir(ownShortDir(this.#options.socketRoot ?? "/tmp"), initialize);
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
						...(this.#options.manager ? {} : { gitPaths: gitProtectedPaths(cwd, home) }),
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

	#outside: boolean | undefined;

	/** Whether a command the user's rules cover can run under its profile; asked once. */
	outsideAvailable(): boolean {
		this.#outside ??= (this.#options.outside ?? (this.#options.manager ? () => true : sandboxExecWorks))();
		return this.#outside;
	}

	/** The program and arguments that run `command` under the profile for covered commands. */
	outside(command: string, cwd: string): { file: string; args: string[] } {
		if (this.#options.manager) return { file: "bash", args: ["-c", command] };
		const home = this.#options.home ?? homedir();
		// The writes the agent's policy denies, read at each command like `wrap` does; an invalid configuration throws.
		const { denyWrite } = agentPolicy({
			cwd,
			tempDir: this.#options.tempDir ?? tmpdir(),
			home,
			additions: loadSandboxAdditions({ cwd, home }),
			...optional("worktreeGit", linkedWorktreeGit(cwd)),
			gitPaths: gitProtectedPaths(cwd, home),
		}).filesystem;
		const places = denyWrite.map((entry) => (typeof entry === "string" ? entry : entry.path));
		const profile = outsideProfile(home, places, cwd);
		return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, "bash", "-c", command] };
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
