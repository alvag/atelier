import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { z } from "zod";
import { errorMessage, failure, MAX_GREP_MATCHES, MAX_LINE_CHARS, takeHead } from "./limits.ts";
import { isInside, isProtected, protectedReadPaths, resolveInside, resolveOutside } from "./paths.ts";
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
		/** System grep prints `--` between context blocks and cannot be told not to; these lines are dropped. */
		dropSeparators: boolean;
	},
	/** Keeps only matches whose relative path passes; applied before the match limit. */
	accept: (path: string) => boolean = () => true,
): Promise<SearchResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		const hits: Hit[] = [];
		let found = 0;
		let stopped: SearchResult["stopped"];
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
			if (hit.match) found++;
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
		 * newline, and stays part of the next record's path, which is then checked as a whole.
		 */
		const takeNotice = (): boolean => {
			const nl = pending.indexOf("\n");
			const nul = pending.indexOf("\0");
			if (nl === -1 || (nul !== -1 && nul < nl)) return false;
			const found = NOTICE.exec(pending.slice(0, nl));
			if (!found) return false;
			const path = toRelative(found[1] ?? "");
			if (!accept(path)) return false;
			push({ path, line: undefined, match: true, text: clip(`${path}${found[2] ?? ""}`) });
			pending = pending.slice(nl + 1);
			return true;
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (stopped) return;
			pending += chunk;
			// A record is `path NUL rest NL`; the path may hold newlines, the rest never does.
			while (true) {
				if (scan.dropSeparators && pending.startsWith("--\n")) {
					pending = pending.slice(3);
					continue;
				}
				const notice = takeNotice();
				if (notice) {
					if (found > scan.limit) return stop("limit");
					continue;
				}
				const nul = pending.indexOf("\0");
				const end = nul === -1 ? -1 : pending.indexOf("\n", nul);
				if (end === -1) break;
				add(pending.slice(0, end), nul);
				pending = pending.slice(end + 1);
				if (found > scan.limit) return stop("limit");
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
			// A partial last line only counts when the command finished on its own.
			const nul = pending.indexOf("\0");
			if (!stopped && nul !== -1) add(pending, nul);
			if (!stopped && code === 2 && hits.length === 0) {
				reject(new Error(stderr.trim() || `${command} failed`));
				return;
			}
			resolve({ hits, stopped, unreadable: code === 2 || stderr.trim() !== "" });
		});
	});
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
): string[] {
	const args = [
		`-rnHI${flags.literal ? "F" : "E"}${flags.ignoreCase ? "i" : ""}`,
		"--null",
		"--exclude-dir=node_modules",
		"--exclude-dir=.*",
		"--exclude=.*",
	];
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

/** Applies a glob that has a directory to a relative path; a leading `!` negates it. */
function globFilter(glob: string): (path: string) => boolean {
	return glob.startsWith("!") ? (path) => !matchesGlob(path, glob.slice(1)) : (path) => matchesGlob(path, glob);
}

/**
 * Whether a match may be returned: its real path, and the path as written,
 * are outside every protected place. A path that cannot be resolved is dropped.
 */
function isReadable(path: string, root: string, secrets: readonly string[]): boolean {
	const absolute = resolve(root, path);
	if (isProtected(absolute, secrets)) return false;
	try {
		return !isProtected(realpathSync(absolute), secrets);
	} catch {
		return false;
	}
}

/** The hits up to the `limit`-th match, with its context after it but not the context before the next match. */
function cutAtLimit(hits: Hit[], limit: number, context: number): Hit[] {
	let seen = 0;
	const end = hits.findIndex((hit) => hit.match && ++seen > limit);
	if (end === -1) return hits;
	const kept = hits.slice(0, end);
	let last: Hit | undefined;
	for (const hit of kept) if (hit.match) last = hit;
	const after = (hit: Hit) =>
		last !== undefined &&
		hit.path === last.path &&
		hit.line !== undefined &&
		last.line !== undefined &&
		hit.line <= last.line + context;
	while (kept.length > 0) {
		const tail = kept[kept.length - 1] as Hit;
		if (tail.match || after(tail)) break;
		kept.pop();
	}
	return kept;
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
		description: `Search file contents with a regular expression${options.outside ? "" : " inside the working directory"}. Returns path:line:text, at most ${MAX_GREP_MATCHES} matches unless limit says otherwise. Skips hidden files and node_modules.${options.outside ? " The path may be absolute or outside the working directory; the user's secret directories are protected." : ""}`,
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
				const secrets = options.outside ? await protectedReadPaths(cwd, options.home ?? homedir()) : [];
				const target = options.outside
					? await resolveOutside(cwd, path ?? ".", secrets)
					: await resolveInside(cwd, path ?? ".");
				const root = await realpath(cwd);
				// The engines are told to skip the secrets inside the target; the filter below is what guarantees none is returned.
				const skipped = secrets.filter((secret) => secret !== target && isInside(target, secret));
				if (signal?.aborted) return failure("Search aborted.");
				const useRipgrep = options.useRipgrep ?? hasRipgrep();
				// ripgrep never filters a file given as the target by a glob; the fallback drops the glob there too.
				const searchedGlob = (await isFile(target)) ? undefined : glob;
				// Only the fallback applies a glob with a directory itself; ripgrep takes it as given.
				const byGlob = searchedGlob?.includes("/") ? globFilter(searchedGlob) : undefined;
				// A match outside the working directory comes back absolute; its glob sees it from the searched folder, so
				// the folders above (which may be hidden, and `**` skips hidden ones) never decide.
				const globPath = (match: string) =>
					isAbsolute(match) && isInside(target, match) ? relative(target, match) : match;
				const accept = (match: string) =>
					(options.outside ? isReadable(match, root, secrets) : true) &&
					(useRipgrep || (byGlob?.(globPath(match)) ?? true));
				const flags = { ignoreCase: ignoreCase ?? false, literal: literal ?? false, context };
				const scan = { limit, dropSeparators: !useRipgrep && context > 0 };
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
							grepArgs(target, pattern, searchedGlob, skipped, flags),
							root,
							signal,
							scan,
							accept,
						);
				if (result.stopped === "aborted") return failure("Search aborted.");

				const limited = render(cutAtLimit(result.hits, limit, context), context);
				let shown = takeHead(limited.map((line) => line.text)).lines;
				// A cut right after a block leaves its `--` last.
				if (shown.length < limited.length && limited[shown.length - 1]?.text === "--") shown = shown.slice(0, -1);
				const matches = countMatches(limited.slice(0, shown.length));
				const clipped = shown.length < limited.length;
				const truncated = result.stopped !== undefined || clipped;
				const notes: string[] = [];
				if (result.stopped === "limit" || clipped) {
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
