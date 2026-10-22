import { spawn, spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import { errorMessage, failure, MAX_GREP_MATCHES, MAX_LINE_CHARS } from "./limits.ts";
import { resolveInside } from "./paths.ts";
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

		const toRelative = (line: string) => {
			const path = line.startsWith(`${root}/`) ? line.slice(root.length + 1) : line.replace(/^\.\//, "");
			return clip(path);
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (stopped) return;
			const lines = (pending + chunk).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				matches.push(toRelative(line));
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
			if (!stopped && pending) matches.push(toRelative(pending));
			if (!stopped && code === 2 && matches.length === 0) {
				reject(new Error(stderr.trim() || `${command} failed`));
				return;
			}
			resolve({ matches, stopped, unreadable: code === 2 || stderr.trim() !== "" });
		});
	});
}

function ripgrepArgs(target: string, pattern: string, glob: string | undefined): string[] {
	const args = ["--line-number", "--no-heading", "--with-filename", "--color", "never", "--glob", "!node_modules"];
	if (glob !== undefined) args.push("--glob", glob);
	args.push("--", pattern, target);
	return args;
}

/** System grep, extended regular expressions; the target must be absolute (BSD grep excludes "." itself otherwise). */
function grepArgs(target: string, pattern: string, glob: string | undefined): string[] {
	const args = ["-rnHIE", "--exclude-dir=node_modules", "--exclude-dir=.*", "--exclude=.*"];
	if (glob !== undefined) args.push(`--include=${glob}`);
	args.push("-e", pattern, "--", target);
	return args;
}

export function createGrepTool(options: { useRipgrep?: boolean } = {}): ToolDefinition {
	return defineTool({
		name: "grep",
		description: `Search file contents with a regular expression inside the working directory. Returns path:line:text, at most ${MAX_GREP_MATCHES} matches. Skips hidden files and node_modules.`,
		inputShape: {
			pattern: z.string().min(1).describe("Regular expression"),
			path: z.string().optional().describe("File or directory to search, relative to the working directory"),
			glob: z.string().optional().describe('File name filter, e.g. "*.ts"'),
		},
		async execute({ pattern, path, glob }, { cwd, signal }) {
			try {
				if (signal?.aborted) return failure("Search aborted.");
				const target = await resolveInside(cwd, path ?? ".");
				const root = await realpath(cwd);
				const useRipgrep = options.useRipgrep ?? hasRipgrep();
				const result = useRipgrep
					? await runSearch("rg", ripgrepArgs(relative(root, target) || ".", pattern, glob), root, signal)
					: await runSearch("grep", grepArgs(target, pattern, glob), root, signal);
				if (result.stopped === "aborted") return failure("Search aborted.");

				const truncated = result.stopped !== undefined;
				const shown = result.matches.slice(0, MAX_GREP_MATCHES);
				const notes: string[] = [];
				if (result.stopped === "limit")
					notes.push(`[Showing the first ${MAX_GREP_MATCHES} matches. Narrow the pattern, path or glob.]`);
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
