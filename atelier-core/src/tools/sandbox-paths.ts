import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SECRET_TEMP_FOLDER } from "../secret-file.ts";

/** Files that hold secrets in a project: no command may write them, wherever they sit under `dir`. */
export function secretFilePatterns(dir: string): string[] {
	return [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"].map((pattern) => join(dir, pattern));
}

/**
 * Every `.git` below `dir`, not `dir/.git` itself: a directory, a file or a link of that name, existing or not, and
 * everything in one. A new or changed one points git at another repository, whose configuration and hooks git runs
 * when someone runs it there; the library denies the subtree a pattern names and keeps the name from being created,
 * moved or replaced. The top `.git` keeps its own, narrower protections.
 */
export function nestedGitPattern(dir: string): string {
	return join(dir, "*/**/.git");
}

/**
 * What the library protects by itself (git hooks and configuration, shell
 * start-up files, editor and tool configuration), but only in the directory the
 * process was started in, which is not the session's working directory when
 * `--cwd` or a desktop client sets another. So the policy repeats it for the
 * working directory and every directory the configuration adds.
 */
export function libraryProtectedPaths(dir: string): string[] {
	return [
		".git/hooks",
		".git/config",
		".gitconfig",
		".gitmodules",
		".bashrc",
		".bash_profile",
		".zshrc",
		".zprofile",
		".profile",
		".ripgreprc",
		".mcp.json",
		".vscode",
		".idea",
		".claude/commands",
		".claude/agents",
	].map((path) => join(dir, path));
}

/** What the user keeps private: no command of the main agent may read it. */
export function secretDirectories(home: string): string[] {
	return [".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains", ".claude"].map((path) => join(home, path));
}

/**
 * Atelier's own credentials: the sign-ins and API keys of `atelier login`, the MCP servers' OAuth tokens, and the
 * folder where they are written before replacing the files, so what a crash leaves there stays hidden. The rest
 * of `~/.atelier` stays readable; none of it is writable (see `protectedWritePaths`).
 */
export function secretFiles(home: string): string[] {
	return [".atelier/auth.json", ".atelier/mcp-auth.json", `.atelier/${SECRET_TEMP_FOLDER}`].map((path) =>
		join(home, path),
	);
}

/**
 * The credentials other command-line tools keep in the home: the Codex CLI's sign-in, OpenCode's API keys, and the
 * passwords curl and git read (`~/.netrc`, and git's `store` helper in both its places). Only the files: the rest of
 * their folders stays readable. The tool that owns one still uses it from a command run outside the sandbox.
 */
export function cliCredentialFiles(home: string): string[] {
	return [
		".codex/auth.json",
		".local/share/opencode/auth.json",
		".netrc",
		".git-credentials",
		".config/git/credentials",
	].map((path) => join(home, path));
}

/** Everything no tool or command of the main agent may read: the secret directories and every credential file. */
export function secretReadPaths(home: string): string[] {
	return [...secretDirectories(home), ...secretFiles(home), ...cliCredentialFiles(home)];
}

/**
 * The per-user caches and stores of the package managers and build tools, which
 * the agent's commands write so that installing and building keep working:
 * npm, pnpm (its store and cache, on macOS and by XDG), yarn, `~/.cache` and
 * `~/Library/Caches` (which hold the corepack, node-gyp, pip and Yarn caches
 * too) and node-gyp's own `~/.node-gyp`. Never home itself, never a secret.
 */
export function packageCacheDirectories(home: string): string[] {
	return [
		".npm",
		"Library/pnpm",
		".local/share/pnpm",
		".pnpm-store",
		".yarn",
		".node-gyp",
		".cache",
		"Library/Caches",
	].map((path) => join(home, path));
}

/**
 * What one git configuration file names: its `core.hooksPath` (every reading of it when only the fallback parser
 * could read it), its include paths, and whether git could not read it.
 */
export interface ConfigFile {
	hooksPaths: string[];
	includes: string[];
	malformed: boolean;
}

const CONFIG_BUFFER_LIMIT = 1024 * 1024;
const COMBINED_CONFIG_BUFFER_LIMIT = 3 * CONFIG_BUFFER_LIMIT + 64 * 1024;

function gitConfig(file: string, args: string[], maxBuffer = CONFIG_BUFFER_LIMIT): SpawnSyncReturns<Buffer> {
	return spawnSync("git", ["config", "--file", file, "--no-includes", "-z", ...args], {
		timeout: 5000,
		maxBuffer,
	});
}

/** Raw NUL-delimited records: decoding first would expand invalid UTF-8 bytes when measuring the old query sizes. */
function configRecords(run: SpawnSyncReturns<Buffer>): Buffer[] | undefined {
	if (run.status === 1) return [];
	// As before, status 0 is accepted even if Node also reports ENOBUFS after git has exited.
	if (run.status !== 0) return undefined;
	const records: Buffer[] = [];
	let start = 0;
	for (let end = run.stdout.indexOf(0); end !== -1; end = run.stdout.indexOf(0, start)) {
		records.push(run.stdout.subarray(start, end));
		start = end + 1;
	}
	return records;
}

/**
 * The `core.hooksPath` and the include paths of one git configuration file,
 * read by git itself, alone and without following includes, so a broken file
 * elsewhere does not matter and git's whole syntax (quotes, escapes,
 * continuation lines) is honored. A missing file names nothing. When git cannot
 * read the file, its own parser answers instead and `malformed` is set.
 */
export function configFilePaths(file: string): ConfigFile {
	if (!existsSync(file)) return { hooksPaths: [], includes: [], malformed: false };
	const run = gitConfig(
		file,
		["--get-regexp", "^(include\\.path|includeif\\..*\\.path|core\\.hookspath)$"],
		COMBINED_CONFIG_BUFFER_LIMIT,
	);
	// Even status 0 with ENOBUFS can leave truncated combined records; only the old queries decide their results.
	if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") return separateConfigFilePaths(file);
	const records = configRecords(run);
	if (records === undefined) return { ...parseConfigFile(file), malformed: true };
	const plain: string[] = [];
	const conditional: string[] = [];
	let hooksPath: string | undefined;
	let plainBytes = 0;
	let conditionalBytes = 0;
	let hooksBytes = 0;
	for (const record of records) {
		const separator = record.indexOf(10);
		const key = record.subarray(0, separator === -1 ? record.length : separator).toString("utf8");
		const value = record.subarray(separator === -1 ? record.length : separator + 1);
		if (key === "include.path") {
			plain.push(value.toString("utf8"));
			plainBytes += value.length + 1;
		} else if (key.startsWith("includeif.")) {
			// Preserve the old get-regexp handling, even for a valueless conditional entry.
			conditional.push(record.subarray(separator + 1).toString("utf8"));
			conditionalBytes += record.length + 1;
		} else if (key === "core.hookspath") {
			hooksPath = value.toString("utf8");
			hooksBytes = value.length + 1;
		}
	}
	// Above the old buffer bound, only the original queries can tell whether git exited before Node could kill it.
	if (Math.max(plainBytes, conditionalBytes, hooksBytes) > CONFIG_BUFFER_LIMIT) return separateConfigFilePaths(file);
	return {
		hooksPaths: hooksPath === undefined ? [] : [hooksPath],
		includes: [...plain, ...conditional],
		malformed: false,
	};
}

/** Preserve the original commands and their actual exit/overflow behavior for large individual query outputs. */
function separateConfigFilePaths(file: string): ConfigFile {
	const plain = configRecords(gitConfig(file, ["--get-all", "include.path"]));
	const conditional = configRecords(gitConfig(file, ["--get-regexp", "^includeif\\..*\\.path$"]));
	const hooks = configRecords(gitConfig(file, ["--get", "core.hooksPath"]));
	if (plain === undefined || conditional === undefined || hooks === undefined)
		return { ...parseConfigFile(file), malformed: true };
	const includes = [
		...plain.map((record) => record.toString("utf8")),
		...conditional.map((record) => record.subarray(record.indexOf(10) + 1).toString("utf8")),
	];
	const hooksPath = hooks[0]?.toString("utf8");
	return { hooksPaths: hooksPath === undefined ? [] : [hooksPath], includes, malformed: false };
}

const HEADER = /\[[ \t]*([A-Za-z0-9.-]+)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[ \t]*\]/y;
const BROKEN_HEADER = /\[[ \t]*([A-Za-z0-9.-]*)/y;
const KEY = /([A-Za-z][A-Za-z0-9-]*)[ \t]*(=?)/y;
const ESCAPES: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", t: "\t", b: "\b" };

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
	pattern.lastIndex = index;
	return pattern.exec(text);
}

function lineEnd(text: string, index: number): number {
	const end = text.indexOf("\n", index);
	return end === -1 ? text.length : end;
}

/**
 * The value that starts at `start`, read as git reads it: quotes open and close anywhere, a `#` or `;` outside them
 * starts a comment, `\"`, `\\`, `\n`, `\t` and `\b` are escapes, a backslash before a newline continues the line, and
 * unquoted space at either end is dropped. `malformed` when git would reject it (an open quote, an unknown escape),
 * read on to the end of the line; `end` is where its last line ends.
 */
function readValue(text: string, start: number): { value: string; malformed: boolean; end: number } {
	let value = "";
	let quoted = false;
	let comment = false;
	let malformed = false;
	// Where the unquoted space at the end began, or -1.
	let trim = -1;
	let index = start;
	for (; index < text.length && text[index] !== "\n"; index++) {
		const char = text[index] as string;
		if (comment) continue;
		if (!quoted && (char === " " || char === "\t" || char === "\r")) {
			if (trim === -1) trim = value.length;
			if (value !== "") value += char;
			continue;
		}
		if (!quoted && (char === "#" || char === ";")) {
			comment = true;
			continue;
		}
		trim = -1;
		if (char === "\\") {
			const next = text[index + 1];
			if (next === undefined) continue;
			index++;
			if (next === "\n") continue;
			const escaped = ESCAPES[next];
			if (escaped === undefined) malformed = true;
			value += escaped ?? next;
		} else if (char === '"') quoted = !quoted;
		else value += char;
	}
	return { value: trim === -1 ? value : value.slice(0, trim), malformed: malformed || quoted, end: index };
}

/**
 * Every way the value at `start` can be read: the one git reads, or for a value git rejects, also its text to the
 * end of the line and cut where a comment would start, each with and without its quotes.
 */
function valueReadings(text: string, start: number): { readings: string[]; end: number } {
	const read = readValue(text, start);
	if (!read.malformed) return { readings: [read.value], end: read.end };
	const line = text.slice(start, read.end).trim();
	const cut = line.replace(/[#;][\s\S]*$/, "").trim();
	const readings = [read.value, line, cut].flatMap((value) => [value, value.replaceAll('"', "").trim()]);
	return { readings: [...new Set(readings)].filter((value) => value !== ""), end: read.end };
}

/**
 * The same answer read by a parser of git's syntax, for a file git rejects: sections and subsections, comments, an
 * entry on its header's line, and values as `readValue` reads them. An include counts in any `include` or
 * `includeIf` section; `core.hooksPath` only in `[core]` itself, as git reads it. A header git rejects counts as
 * its name without a subsection.
 */
function parseConfigFile(file: string): { hooksPaths: string[]; includes: string[] } {
	const found: { hooksPaths: string[]; includes: string[] } = { hooksPaths: [], includes: [] };
	let text: string;
	try {
		text = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
	} catch {
		return found;
	}
	let section = "";
	let subsection = false;
	for (let index = 0; index < text.length; ) {
		const char = text[index];
		if (char === " " || char === "\t" || char === "\r" || char === "\n") index++;
		else if (char === "#" || char === ";") index = lineEnd(text, index);
		else if (char === "[") {
			const header = matchAt(HEADER, text, index);
			const name = header ?? matchAt(BROKEN_HEADER, text, index);
			section = (name?.[1] ?? "").toLowerCase();
			subsection = header?.[2] !== undefined;
			index = header ? HEADER.lastIndex : lineEnd(text, index);
		} else {
			const entry = matchAt(KEY, text, index);
			if (entry?.[2] !== "=") {
				// A key without a value names no path; anything else is a line git rejects.
				index = lineEnd(text, index);
				continue;
			}
			const key = (entry[1] ?? "").toLowerCase();
			const { readings, end } = valueReadings(text, KEY.lastIndex);
			if (key === "path" && (section === "include" || section === "includeif")) found.includes.push(...readings);
			else if (key === "hookspath" && section === "core" && !subsection) found.hooksPaths = readings;
			index = end;
		}
	}
	return found;
}

/** A path from a git configuration file, as git resolves it: `~/` is the home, a relative one is relative to `base`. */
export function configPath(value: string, base: string, home: string): string {
	if (value.startsWith("~/")) return join(home, value.slice(2));
	return isAbsolute(value) ? value : resolve(base, value);
}

const MAX_INCLUDE_DEPTH = 10;

/**
 * The files the given git configuration files include (`include.path`,
 * `includeIf.<condition>.path`), whatever the condition, through the included
 * files that can be read, down to a fixed depth. They run code the same way the
 * configuration does (`core.hooksPath`, `core.fsmonitor`), so they are listed
 * whether they exist or not.
 */
export function includedConfigFiles(files: string[], home: string): string[] {
	const found = new Set<string>();
	const visit = (file: string, depth: number) => {
		if (depth > MAX_INCLUDE_DEPTH) return;
		const config = configFilePaths(file);
		// A file git cannot read may be hiding anything: its directory's conventional places are protected too.
		if (config.malformed)
			for (const name of ["hooks", "config", "config.worktree"]) found.add(join(dirname(file), name));
		for (const include of config.includes) {
			const path = configPath(include, dirname(file), home);
			if (found.has(path)) continue;
			found.add(path);
			visit(path, depth + 1);
		}
	};
	for (const file of files) visit(file, 0);
	return [...found];
}
