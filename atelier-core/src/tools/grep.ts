import { spawn, spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { z } from "zod";
import { errorMessage, failure, MAX_GREP_MATCHES, MAX_LINE_CHARS, takeHead } from "./limits.ts";
import {
	isInside,
	isProtected,
	isSecretFileFolded,
	PathProtectedError,
	protectedReadPaths,
	resolveInside,
	resolveOutside,
} from "./paths.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

const SEARCH_TIMEOUT_MS = 30_000;

let ripgrepAvailable: boolean | undefined;
function hasRipgrep(): boolean {
	ripgrepAvailable ??= spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
	return ripgrepAvailable;
}

function clip(line: string): string {
	return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}

const NOTICE = /^(.*)(: binary file matches \(found "\\0" byte around offset \d+\))$/s;
const WARNING = /^(?:.*: )?WARNING:/;

/** The most matches one call may ask for, and the most context lines around each. */
const MAX_LIMIT = 1000;
const MAX_CONTEXT = 20;

/** One line of output: a match (`path:N:text`), a context line (`path-N-text`) or a binary-file notice. */
interface Hit {
	path: string;
	/** Absent for a binary-file notice. */
	line: number | undefined;
	match: boolean;
	text: string;
}

interface SearchResult {
	hits: Hit[];
	/** The search stopped before the end: more matches than the limit, timeout or abort. */
	stopped: "limit" | "timeout" | "aborted" | undefined;
	/** Some files could not be read (permissions, broken links...). */
	unreadable: boolean;
}

/**
 * Runs a search command that prints `path NUL line:text` records (`--null`),
 * so a file name with colons or newlines never blurs where the path ends. Both
 * engines run as subprocesses, so a pathological pattern can be killed instead
 * of blocking the event loop. Paths in the output are made relative to `root`.
 */
function runSearch(
	command: string,
	args: string[],
	root: string,
	signal: AbortSignal | undefined,
	scan: {
		/** Stops after one match more than this, so the caller knows there are more. */
		limit: number;
		/** Context lines around each match; the ones after the last match within the limit are still read. */
		context: number;
		/** System grep prints `--` between context blocks and cannot be told not to; these lines are dropped. */
		dropSeparators: boolean;
		/** Only ripgrep prints stdout notices; system grep skips binary files (`-I`), so its output has none. */
		notices: boolean;
	},
	/** Keeps only matches whose relative path passes; applied before the match limit. */
	accept: (path: string) => boolean = () => true,
): Promise<SearchResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		const hits: Hit[] = [];
		let found = 0;
		/** The match that reached the limit, and whether a line past its trailing context has come. */
		let boundary: Hit | undefined;
		let over = false;
		let stopped: SearchResult["stopped"];
		/** An error while reading the output; the search is stopped and fails with it. */
		let failed: unknown;
		let pending = "";
		let stderr = "";

		const stop = (reason: NonNullable<SearchResult["stopped"]>) => {
			if (stopped) return;
			stopped = reason;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop("timeout"), SEARCH_TIMEOUT_MS);
		const onAbort = () => stop("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) stop("aborted");

		const toRelative = (path: string) =>
			path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\.\//, "");
		const push = (hit: Hit) => {
			hits.push(hit);
			if (boundary === undefined) {
				if (hit.match && ++found === scan.limit) boundary = hit;
			} else if (!trails(boundary, hit, scan.context)) over = true;
		};
		const add = (record: string, nul: number) => {
			const path = toRelative(record.slice(0, nul));
			if (!accept(path)) return;
			const rest = record.slice(nul + 1);
			// `N:text` is a match and `N-text` a context line.
			const kind = /^(\d+)([:-])/.exec(rest);
			const separator = kind?.[2] ?? ":";
			push({
				path,
				line: kind ? Number(kind[1]) : undefined,
				match: separator === ":",
				text: clip(`${path}${separator}${rest}`),
			});
		};
		/**
		 * ripgrep's binary-match notice has no NUL: `<path>: binary file matches (found "\0" byte around offset N)`.
		 * It counts as a notice only when the path before the final suffix passes `accept` (which, for the open
		 * tools, means it exists and is not protected); otherwise it is the start of a file name that holds a
		 * newline, and stays part of the next record's path, which is then checked as a whole. A name that holds
		 * a forged notice and a newline is told apart by the text up to the next NUL: when that is an existing
		 * file, the line is the start of its name. Until that NUL arrives (or the output ends), nothing is decided.
		 * Stdout WARNING lines (with or without a path) use the same name check, but are discarded, not counted.
		 * They need no `accept` check: even a warning about an unreadable or protected file must be consumed.
		 */
		const takeNotice = (ended: boolean): boolean => {
			if (!scan.notices) return false;
			const nl = pending.indexOf("\n");
			const nul = pending.indexOf("\0");
			if (nl === -1 || (nul !== -1 && nul < nl)) return false;
			const line = pending.slice(0, nl);
			const warning = WARNING.test(line);
			const found = NOTICE.exec(line);
			if (!warning && !found) return false;
			const path = toRelative(found?.[1] ?? "");
			if (!warning && !accept(path)) return false;
			if (nul === -1 ? !ended : exists(root, toRelative(pending.slice(0, nul)))) return false;
			if (!warning) push({ path, line: undefined, match: true, text: clip(`${path}${found?.[2] ?? ""}`) });
			pending = pending.slice(nl + 1);
			return true;
		};
		const consume = (chunk: string) => {
			pending += chunk;
			// A record is `path NUL rest NL`; the path may hold newlines, the rest never does.
			while (true) {
				if (scan.dropSeparators && pending.startsWith("--\n")) {
					pending = pending.slice(3);
					continue;
				}
				const notice = takeNotice(false);
				if (notice) {
					if (over) return stop("limit");
					continue;
				}
				const nul = pending.indexOf("\0");
				const end = nul === -1 ? -1 : pending.indexOf("\n", nul);
				if (end === -1) break;
				add(pending.slice(0, end), nul);
				pending = pending.slice(end + 1);
				if (over) return stop("limit");
			}
		};
		// An exception must not escape the stream callback, where nothing catches it and it ends the process.
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (stopped) return;
			try {
				consume(chunk);
			} catch (error) {
				failed = error;
				stop("aborted");
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			if (stderr.length < 4096) stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (failed !== undefined) {
				reject(failed);
				return;
			}
			// A partial last line only counts when the command finished on its own.
			try {
				if (!stopped) while (takeNotice(true));
				const nul = pending.indexOf("\0");
				if (!stopped && nul !== -1) add(pending, nul);
			} catch (error) {
				reject(error);
				return;
			}
			if (!stopped && code === 2 && hits.length === 0) {
				reject(new Error(stderr.trim() || `${command} failed`));
				return;
			}
			resolve({ hits, stopped, unreadable: code === 2 || stderr.trim() !== "" });
		});
	});
}

/**
 * Whether something is at `path` (relative to `root`), without following a final symbolic link. It never
 * throws: a name too long or through a non-directory cannot be a file, and any other failure counts as one,
 * so the line stays part of a name that the filter then checks whole.
 */
function exists(root: string, path: string): boolean {
	try {
		return lstatSync(resolve(root, path), { throwIfNoEntry: false }) !== undefined;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENAMETOOLONG" && code !== "ENOTDIR";
	}
}

/** `path` as a literal ripgrep glob. */
const escapeGlob = (path: string) => path.replace(/[\\*?[\]{}!]/g, "\\$&");

/** What the caller asked of the search besides the pattern and where. */
interface SearchFlags {
	ignoreCase: boolean;
	literal: boolean;
	context: number;
}

function ripgrepArgs(
	target: string,
	pattern: string,
	glob: string | undefined,
	skipped: string[],
	flags: SearchFlags,
): string[] {
	const args = [
		// The user's RIPGREP_CONFIG_PATH must not change what the tool returns.
		"--no-config",
		"--line-number",
		"--no-heading",
		"--with-filename",
		"--null",
		"--color",
		"never",
		"--glob",
		"!node_modules",
	];
	if (flags.ignoreCase) args.push("--ignore-case");
	if (flags.literal) args.push("--fixed-strings");
	if (flags.context > 0) args.push("--context", String(flags.context), "--no-context-separator");
	if (glob !== undefined) args.push("--glob", glob);
	// Last, so they win over the user's glob: a later ripgrep glob overrides an earlier one.
	for (const path of skipped) args.push("--glob", `!**/${escapeGlob(path)}`);
	args.push("--", pattern, target);
	return args;
}

/**
 * System grep, extended regular expressions. The target must be absolute (BSD grep
 * excludes "." itself otherwise). --include only sees file names, so a glob with
 * a directory is applied to the relative paths instead (see execute).
 */
function grepArgs(
	target: string,
	pattern: string,
	glob: string | undefined,
	skipped: string[],
	flags: SearchFlags,
	targetIsFile: boolean,
): string[] {
	const args = [
		`-rnHI${flags.literal ? "F" : "E"}${flags.ignoreCase ? "i" : ""}`,
		"--null",
		"--exclude-dir=node_modules",
		"--exclude-dir=.*",
	];
	// Like ripgrep, search an explicitly named file even when its name starts with a dot.
	if (!targetIsFile) args.push("--exclude=.*");
	for (const path of skipped) args.push(`--exclude-dir=${path}`);
	if (flags.context > 0) args.push("-C", String(flags.context));
	if (glob !== undefined && !glob.includes("/"))
		args.push(glob.startsWith("!") ? `--exclude=${glob.slice(1)}` : `--include=${glob}`);
	args.push("-e", pattern, "--", target);
	return args;
}

/** Whether `path` is a file (following links); a missing path is not. */
async function isFile(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

/**
 * Refuses a target that is a protected place, or a file named like a secret file by the path as
 * written or by its real path: the engines search the real path, so the filter would never see
 * the name the caller gave (a link `alias.pem` to an ordinary file).
 */
async function refuseSecretTarget(
	cwd: string,
	path: string,
	target: string,
	secrets: readonly string[],
): Promise<void> {
	const written = resolve(cwd, path);
	const named = (await isFile(target)) && (isSecretFileFolded(written) || isSecretFileFolded(target));
	if (named || isProtected(written, secrets) || isProtected(target, secrets)) throw new PathProtectedError(path);
}

/** Applies a glob that has a directory to a relative path; a leading `!` negates it. */
function globFilter(glob: string): (path: string) => boolean {
	return glob.startsWith("!") ? (path) => !matchesGlob(path, glob.slice(1)) : (path) => matchesGlob(path, glob);
}

/** Whether `path` is in a protected place or is a secret file (`.env`, `.env.*`, `*.pem`, `*.key`). */
const isSecret = (path: string, secrets: readonly string[]) => isProtected(path, secrets) || isSecretFileFolded(path);

/**
 * Whether a match or context line may be returned: its real path, and the path as written, are
 * outside every protected place and are not secret files. A path that cannot be resolved is dropped.
 */
function isReadable(path: string, root: string, secrets: readonly string[]): boolean {
	const absolute = resolve(root, path);
	if (isSecret(absolute, secrets)) return false;
	try {
		return !isSecret(realpathSync(absolute), secrets);
	} catch {
		return false;
	}
}

/** Whether `hit` is within the `context` lines after `match`, in the same file. */
function trails(match: Hit, hit: Hit, context: number): boolean {
	return (
		hit.path === match.path && hit.line !== undefined && match.line !== undefined && hit.line <= match.line + context
	);
}

/**
 * The hits up to the `limit`-th match and the context after it, where a later match shows as a context
 * line; `more` says whether there were matches past the limit.
 */
function cutAtLimit(hits: Hit[], limit: number, context: number): { hits: Hit[]; more: boolean } {
	const kept: Hit[] = [];
	let seen = 0;
	let last: Hit | undefined;
	for (const hit of hits) {
		if (last === undefined) {
			kept.push(hit);
			if (hit.match && ++seen === limit) last = hit;
		} else if (trails(last, hit, context)) {
			kept.push(hit.match ? asContext(hit) : hit);
		} else break;
	}
	return { hits: kept, more: countMatches(hits) > limit };
}

/** A match shown as a context line: `path-N-text` instead of `path:N:text`. */
function asContext(hit: Hit): Hit {
	const prefix = `${hit.path}:${hit.line}:`;
	return { ...hit, match: false, text: `${hit.path}-${hit.line}-${hit.text.slice(prefix.length)}` };
}

/** The output lines; with context, a `--` line separates blocks that are not consecutive lines of one file. */
function render(hits: Hit[], context: number): { text: string; match: boolean }[] {
	const lines: { text: string; match: boolean }[] = [];
	let previous: Hit | undefined;
	for (const hit of hits) {
		const follows =
			previous !== undefined &&
			previous.path === hit.path &&
			previous.line !== undefined &&
			hit.line === previous.line + 1;
		if (context > 0 && previous !== undefined && !follows) lines.push({ text: "--", match: false });
		lines.push({ text: hit.text, match: hit.match });
		previous = hit;
	}
	return lines;
}

const countMatches = (lines: readonly { match: boolean }[]) => lines.filter((line) => line.match).length;

export interface GrepOptions {
	useRipgrep?: boolean;
	/** Searches any path except the protected secret locations; without it the tool stays inside the working directory. */
	outside?: boolean;
	/** The home whose secret directories stay closed; defaults to the user's. */
	home?: string;
}

export function createGrepTool(options: GrepOptions = {}): ToolDefinition {
	return defineTool({
		name: "grep",
		description: `Search file contents with a regular expression${options.outside ? "" : " inside the working directory"}. Returns path:line:text, at most ${MAX_GREP_MATCHES} matches unless limit says otherwise. Skips hidden files when searching directories, and node_modules.${options.outside ? " The path may be absolute or outside the working directory; the user's secret directories are protected." : ""}`,
		inputShape: {
			pattern: z.string().min(1).describe("Regular expression"),
			path: z
				.string()
				.optional()
				.describe(
					options.outside
						? "File or directory to search, absolute or relative to the working directory"
						: "File or directory to search, relative to the working directory",
				),
			glob: z.string().optional().describe('File name filter, e.g. "*.ts"'),
			ignoreCase: z.boolean().optional().describe("Match regardless of letter case"),
			literal: z.boolean().optional().describe("Treat the pattern as a fixed string, not a regular expression"),
			context: z
				.number()
				.int()
				.min(0)
				.max(MAX_CONTEXT)
				.optional()
				.describe("Lines to show before and after each match; they come as path-line-text"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_LIMIT)
				.optional()
				.describe(`Most matches to return (default ${MAX_GREP_MATCHES})`),
		},
		async execute(
			{ pattern, path, glob, ignoreCase, literal, context = 0, limit = MAX_GREP_MATCHES },
			{ cwd, signal },
		) {
			try {
				if (signal?.aborted) return failure("Search aborted.");
				const secrets = await protectedReadPaths(cwd, options.home ?? homedir());
				const target = options.outside
					? await resolveOutside(cwd, path ?? ".", secrets)
					: await resolveInside(cwd, path ?? ".");
				await refuseSecretTarget(cwd, path ?? ".", target, secrets);
				const root = await realpath(cwd);
				// The engines are told to skip the secrets inside the target; the filter below is what guarantees none is returned.
				const skipped = secrets.filter((secret) => secret !== target && isInside(target, secret));
				if (signal?.aborted) return failure("Search aborted.");
				const useRipgrep = options.useRipgrep ?? hasRipgrep();
				// ripgrep never filters a file given as the target by a glob; the fallback drops the glob there too.
				const targetIsFile = await isFile(target);
				const searchedGlob = targetIsFile ? undefined : glob;
				// Only the fallback applies a glob with a directory itself; ripgrep takes it as given.
				const byGlob = searchedGlob?.includes("/") ? globFilter(searchedGlob) : undefined;
				// A match outside the working directory comes back absolute; its glob sees it from the searched folder, so
				// the folders above (which may be hidden, and `**` skips hidden ones) never decide.
				const globPath = (match: string) =>
					isAbsolute(match) && isInside(target, match) ? relative(target, match) : match;
				const accept = (match: string) =>
					isReadable(match, root, secrets) && (useRipgrep || (byGlob?.(globPath(match)) ?? true));
				const flags = { ignoreCase: ignoreCase ?? false, literal: literal ?? false, context };
				const scan = { limit, context, dropSeparators: !useRipgrep && context > 0, notices: useRipgrep };
				const result = useRipgrep
					? await runSearch(
							"rg",
							ripgrepArgs(
								relative(root, target) || ".",
								pattern,
								glob,
								skipped.map((secret) => relative(root, secret)),
								flags,
							),
							root,
							signal,
							scan,
							accept,
						)
					: await runSearch(
							"grep",
							grepArgs(target, pattern, searchedGlob, skipped, flags, targetIsFile),
							root,
							signal,
							scan,
							accept,
						);
				if (result.stopped === "aborted") return failure("Search aborted.");

				const cut = cutAtLimit(result.hits, limit, context);
				const limited = render(cut.hits, context);
				let shown = takeHead(limited.map((line) => line.text)).lines;
				// A cut right after a block leaves its `--` last.
				if (shown.length < limited.length && limited[shown.length - 1]?.text === "--") shown = shown.slice(0, -1);
				const matches = countMatches(limited.slice(0, shown.length));
				const clipped = shown.length < limited.length;
				const truncated = result.stopped !== undefined || cut.more || clipped;
				const notes: string[] = [];
				if (result.stopped === "limit" || cut.more || clipped) {
					const next =
						clipped || limit >= MAX_LIMIT ? "" : `, or call grep again with limit: ${Math.min(limit * 2, MAX_LIMIT)}`;
					notes.push(`[Showing the first ${matches} matches. Narrow the pattern, path or glob${next}.]`);
				}
				if (result.stopped === "timeout") notes.push("[Search timed out; results are partial.]");
				if (result.unreadable) notes.push("[Some files could not be read.]");
				const body = shown.length > 0 ? shown.join("\n") : "No matches.";
				return {
					ok: true,
					output: notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body,
					summary: matches > 0 ? `${pattern}: ${matches}${truncated ? "+" : ""} matches` : `${pattern}: no matches`,
					truncated,
				};
			} catch (error) {
				return failure(errorMessage(error));
			}
		},
	});
}

export const grepTool = createGrepTool();

/** The `grep` of the main agent and its workers: any path except the secrets. */
export const openGrepTool = createGrepTool({ outside: true });
