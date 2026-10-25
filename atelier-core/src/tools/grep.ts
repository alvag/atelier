import { spawn, spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { matchesGlob, relative, resolve } from "node:path";
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

interface SearchResult {
	matches: string[];
	/** The search stopped before the end: too many matches, timeout or abort. */
	stopped: "limit" | "timeout" | "aborted" | undefined;
	/** Some files could not be read (permissions, broken links...). */
	unreadable: boolean;
}

/**
 * Runs a search command that prints `path:line:text` lines. Both engines run
 * as subprocesses, so a pathological pattern can be killed instead of
 * blocking the event loop. Paths in the output are made relative to `root`.
 */
function runSearch(
	command: string,
	args: string[],
	root: string,
	signal: AbortSignal | undefined,
	/** Keeps only matches whose relative path passes; applied before the match limit. */
	accept: (path: string) => boolean = () => true,
): Promise<SearchResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		const matches: string[] = [];
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

		const toRelative = (line: string) =>
			clip(line.startsWith(`${root}/`) ? line.slice(root.length + 1) : line.replace(/^\.\//, ""));
		const add = (line: string) => {
			const match = toRelative(line);
			const path = /^(.*?):\d+:/.exec(match)?.[1] ?? match;
			if (accept(path)) matches.push(match);
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (stopped) return;
			const lines = (pending + chunk).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				add(line);
				if (matches.length > MAX_GREP_MATCHES) return stop("limit");
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
			if (!stopped && pending) add(pending);
			if (!stopped && code === 2 && matches.length === 0) {
				reject(new Error(stderr.trim() || `${command} failed`));
				return;
			}
			resolve({ matches, stopped, unreadable: code === 2 || stderr.trim() !== "" });
		});
	});
}

function ripgrepArgs(target: string, pattern: string, glob: string | undefined, skipped: string[]): string[] {
	const args = ["--line-number", "--no-heading", "--with-filename", "--color", "never", "--glob", "!node_modules"];
	for (const path of skipped) args.push("--glob", `!/${path}`);
	if (glob !== undefined) args.push("--glob", glob);
	args.push("--", pattern, target);
	return args;
}

/**
 * System grep, extended regular expressions. The target must be absolute (BSD grep
 * excludes "." itself otherwise). --include only sees file names, so a glob with
 * a directory is applied to the relative paths instead (see execute).
 */
function grepArgs(target: string, pattern: string, glob: string | undefined, skipped: string[]): string[] {
	const args = ["-rnHIE", "--exclude-dir=node_modules", "--exclude-dir=.*", "--exclude=.*"];
	for (const path of skipped) args.push(`--exclude-dir=${path}`);
	if (glob !== undefined && !glob.includes("/")) args.push(`--include=${glob}`);
	args.push("-e", pattern, "--", target);
	return args;
}

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
		description: `Search file contents with a regular expression${options.outside ? "" : " inside the working directory"}. Returns path:line:text, at most ${MAX_GREP_MATCHES} matches. Skips hidden files and node_modules.${options.outside ? " The path may be absolute or outside the working directory; the user's secret directories are protected." : ""}`,
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
		},
		async execute({ pattern, path, glob }, { cwd, signal }) {
			try {
				if (signal?.aborted) return failure("Search aborted.");
				const secrets = options.outside ? await protectedReadPaths(cwd, options.home ?? homedir()) : [];
				const target = options.outside
					? await resolveOutside(cwd, path ?? ".", secrets)
					: await resolveInside(cwd, path ?? ".");
				const root = await realpath(cwd);
				// The engines are told to skip the secrets inside the target; the filter below is what guarantees none is returned.
				const skipped = secrets.filter((secret) => secret !== target && isInside(target, secret));
				const notSecret = (match: string) => !isProtected(resolve(root, match), secrets);
				const byGlob = glob?.includes("/") ? (match: string) => matchesGlob(match, glob) : undefined;
				const accept = (match: string) => notSecret(match) && (byGlob?.(match) ?? true);
				if (signal?.aborted) return failure("Search aborted.");
				const useRipgrep = options.useRipgrep ?? hasRipgrep();
				const result = useRipgrep
					? await runSearch(
							"rg",
							ripgrepArgs(
								relative(root, target) || ".",
								pattern,
								glob,
								skipped.map((secret) => relative(root, secret)),
							),
							root,
							signal,
							accept,
						)
					: await runSearch("grep", grepArgs(target, pattern, glob, skipped), root, signal, accept);
				if (result.stopped === "aborted") return failure("Search aborted.");

				const limited = result.matches.slice(0, MAX_GREP_MATCHES);
				const shown = takeHead(limited).lines;
				const truncated = result.stopped !== undefined || shown.length < limited.length;
				const notes: string[] = [];
				if (result.stopped === "limit" || shown.length < limited.length)
					notes.push(`[Showing the first ${shown.length} matches. Narrow the pattern, path or glob.]`);
				if (result.stopped === "timeout") notes.push("[Search timed out; results are partial.]");
				if (result.unreadable) notes.push("[Some files could not be read.]");
				const body = shown.length > 0 ? shown.join("\n") : "No matches.";
				return {
					ok: true,
					output: notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body,
					summary:
						shown.length > 0 ? `${pattern}: ${shown.length}${truncated ? "+" : ""} matches` : `${pattern}: no matches`,
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
