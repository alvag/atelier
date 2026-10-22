import { isAbsolute, matchesGlob, posix } from "node:path";
import { z } from "zod";
import {
	errorMessage,
	failure,
	MAX_BYTES,
	MAX_GREP_MATCHES,
	MAX_LINE_CHARS,
	MAX_LINES,
	takeHead,
} from "../tools/limits.ts";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import { runGit } from "./git.ts";

/** Files past this are not read whole: a review lens has no use for them. */
const BLOB_LIMIT_BYTES = 8 * 1024 * 1024;
/** git grep output is cut here before filtering; the match limit still applies after. */
const GREP_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

class OutsideError extends Error {
	constructor(path: string) {
		super(`Path is outside the repository: ${path}`);
	}
}

/** Repository-relative path with forward slashes; "" is the root. Absolute paths and `..` escapes throw. */
function normalize(path: string): string {
	if (isAbsolute(path) || path.startsWith("/")) throw new OutsideError(path);
	const clean = posix.normalize(path.replaceAll("\\", "/"));
	if (clean === ".." || clean.startsWith("../")) throw new OutsideError(path);
	return clean === "." ? "" : clean.replace(/\/$/, "");
}

/**
 * `read` and `grep` over a frozen git tree, for the review lenses. They have the
 * shape and the limits of the working-directory tools but read only git objects,
 * so the live worktree (edits, ignored files, anything made after freezing) is
 * invisible. The execution context's cwd is ignored: `root` is the repository.
 */
export function createTreeTools(root: string, tree: string): ToolDefinition[] {
	return [readTool(root, tree), grepTool(root, tree)];
}

function readTool(root: string, tree: string): ToolDefinition {
	return defineTool({
		name: "read",
		description:
			"Read a text file of the frozen change. Lines are numbered. Long files are truncated; use offset and limit to page through them. A directory path lists its entries.",
		inputShape: {
			path: z.string().describe("File path, relative to the repository root"),
			offset: z.number().int().min(1).optional().describe("First line to read, 1-based"),
			limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
		},
		async execute({ path, offset, limit }) {
			try {
				const rel = normalize(path);
				const spec = `${tree}:${rel}`;
				const kind = await runGit(["cat-file", "-t", spec], { cwd: root });
				if (kind.code !== 0) return failure(`Not found in the frozen change: ${path}`);
				if (kind.stdout.toString("utf8").trim() === "tree") {
					const listing = await runGit(["ls-tree", "--name-only", spec.endsWith(":") ? spec : `${spec}/`], {
						cwd: root,
					});
					const names = listing.stdout.toString("utf8").trim().split("\n").filter(Boolean);
					const shown = takeHead(names);
					return {
						ok: true,
						output: shown.lines.join("\n"),
						summary: `${path || "."} (${names.length} entries)`,
						truncated: shown.lines.length < names.length,
					};
				}
				const blob = await runGit(["cat-file", "blob", spec], { cwd: root, limitBytes: BLOB_LIMIT_BYTES });
				if (blob.code !== 0) return failure(`Not found in the frozen change: ${path}`);
				if (blob.stdout.includes(0)) return failure(`Binary file: ${path}`);

				const all = blob.stdout.toString("utf8").split("\n");
				if (all.at(-1) === "") all.pop();
				const total = all.length;
				const start = offset ?? 1;
				if (start > Math.max(total, 1))
					return failure(`Offset ${start} is beyond the end of ${path} (${total} lines).`);
				const wanted = all.slice(start - 1, limit === undefined ? undefined : start - 1 + limit).slice(0, MAX_LINES);
				const shown = takeHead(wanted.map((line, i) => `${start + i}\t${line.slice(0, MAX_BYTES)}`));
				const last = start + shown.lines.length - 1;
				let output = shown.lines.join("\n");
				if (last < total)
					output += `\n\n[Showing lines ${start}-${last} of ${total}. Use offset=${last + 1} to continue.]`;
				else if (shown.clipped) output += `\n\n[Line ${last} is too long and was clipped. Use grep to inspect it.]`;
				return { ok: true, output, summary: `${path} (${total} lines)`, truncated: last < total || shown.clipped };
			} catch (error) {
				return failure(errorMessage(error));
			}
		},
	});
}

function grepTool(root: string, tree: string): ToolDefinition {
	return defineTool({
		name: "grep",
		description: `Search the files of the frozen change with a regular expression. Returns path:line:text, at most ${MAX_GREP_MATCHES} matches. Binary files are skipped.`,
		inputShape: {
			pattern: z.string().min(1).describe("Regular expression"),
			path: z.string().optional().describe("File or directory to search, relative to the repository root"),
			glob: z.string().optional().describe('File name filter, e.g. "*.ts"'),
		},
		async execute({ pattern, path, glob }): Promise<ToolOutcome> {
			try {
				const rel = normalize(path ?? "");
				const args = ["grep", "--no-color", "-n", "-I", "-E", "-e", pattern, tree, "--"];
				if (rel !== "") args.push(`:(literal)${rel}`);
				const result = await runGit(args, { cwd: root, limitBytes: GREP_OUTPUT_LIMIT_BYTES });
				if (result.code > 1) return failure(result.stderr.trim() || `git grep exited with ${result.code}`);

				const prefix = `${tree}:`;
				const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
				if (result.truncated) lines.pop();
				const matches: string[] = [];
				for (const line of lines) {
					const match = line.startsWith(prefix) ? line.slice(prefix.length) : line;
					const file = /^(.*?):\d+:/.exec(match)?.[1] ?? match;
					if (glob !== undefined && !matchesGlob(glob.includes("/") ? file : posix.basename(file), glob)) continue;
					matches.push(match.length > MAX_LINE_CHARS ? `${match.slice(0, MAX_LINE_CHARS)}...` : match);
				}

				const limited = matches.slice(0, MAX_GREP_MATCHES);
				const shown = takeHead(limited).lines;
				const truncated = result.truncated || matches.length > MAX_GREP_MATCHES || shown.length < limited.length;
				const notes: string[] = [];
				if (truncated) notes.push(`[Showing the first ${shown.length} matches. Narrow the pattern, path or glob.]`);
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
