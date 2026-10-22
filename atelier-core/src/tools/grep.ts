import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { errorMessage, failure, MAX_GREP_MATCHES, MAX_LINE_CHARS } from "./limits.ts";
import { resolveInside } from "./paths.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

let ripgrepAvailable: boolean | undefined;
function hasRipgrep(): boolean {
	ripgrepAvailable ??= spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
	return ripgrepAvailable;
}

function clip(line: string): string {
	return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}

/** Minimal glob: `*`, `?`, `**` and `{a,b}`. Globs without "/" match the file name, like ripgrep. */
function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i] as string;
		if (char === "*" && glob[i + 1] === "*") {
			source += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "{") source += "(?:";
		else if (char === "}") source += ")";
		else if (char === ",") source += "|";
		else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.isFile()) yield path;
	}
}

async function searchFallback(
	cwd: string,
	target: string,
	pattern: string,
	glob: string | undefined,
): Promise<string[]> {
	const regex = new RegExp(pattern);
	const globRegex = glob === undefined ? undefined : globToRegExp(glob);
	const matches: string[] = [];
	const files = (await stat(target)).isDirectory() ? walk(target) : [target];
	for await (const file of files) {
		const rel = relative(cwd, file);
		if (globRegex && !globRegex.test(glob?.includes("/") ? rel : (rel.split("/").pop() as string))) continue;
		const content = await readFile(file, "utf8").catch(() => "");
		if (content.includes("\u0000")) continue;
		for (const [i, line] of content.split("\n").entries()) {
			if (!regex.test(line)) continue;
			matches.push(`${rel}:${i + 1}:${clip(line)}`);
			if (matches.length > MAX_GREP_MATCHES) return matches;
		}
	}
	return matches;
}

function searchRipgrep(cwd: string, target: string, pattern: string, glob: string | undefined): Promise<string[]> {
	const args = ["--line-number", "--no-heading", "--with-filename", "--color", "never", "--glob", "!node_modules"];
	if (glob !== undefined) args.push("--glob", glob);
	args.push("--", pattern, relative(cwd, target) || ".");
	return new Promise((resolve, reject) => {
		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const matches: string[] = [];
		let pending = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			const lines = (pending + chunk).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (matches.length > MAX_GREP_MATCHES) break;
				matches.push(clip(line.replace(/^\.\//, "")));
			}
			if (matches.length > MAX_GREP_MATCHES) child.kill();
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (pending && matches.length <= MAX_GREP_MATCHES) matches.push(clip(pending.replace(/^\.\//, "")));
			if (code === 2 && matches.length === 0) reject(new Error(stderr.trim() || "ripgrep failed"));
			else resolve(matches);
		});
	});
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
		async execute({ pattern, path, glob }, { cwd }) {
			try {
				const target = await resolveInside(cwd, path ?? ".");
				const root = await realpath(cwd);
				const useRipgrep = options.useRipgrep ?? hasRipgrep();
				const found = await (useRipgrep ? searchRipgrep : searchFallback)(root, target, pattern, glob);
				if (found.length === 0)
					return { ok: true, output: "No matches.", summary: `${pattern}: no matches`, truncated: false };
				const truncated = found.length > MAX_GREP_MATCHES;
				const shown = found.slice(0, MAX_GREP_MATCHES);
				const note = truncated
					? `\n\n[Showing the first ${MAX_GREP_MATCHES} matches. Narrow the pattern, path or glob.]`
					: "";
				return {
					ok: true,
					output: shown.join("\n") + note,
					summary: `${pattern}: ${shown.length}${truncated ? "+" : ""} matches`,
					truncated,
				};
			} catch (error) {
				return failure(errorMessage(error));
			}
		},
	});
}

export const grepTool = createGrepTool();
