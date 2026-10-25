import { randomBytes } from "node:crypto";
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { errorMessage, failure } from "./limits.ts";
import {
	isInside,
	isProtected,
	isSecretFile,
	PathProtectedError,
	protectedWriteDirectories,
	realpathAllowMissing,
} from "./paths.ts";
import { loadSandboxAdditions } from "./sandbox-config.ts";
import { defineTool, type ToolContext, type ToolDefinition } from "./types.ts";

function occurrences(content: string, text: string): number[] {
	const found: number[] = [];
	for (let i = content.indexOf(text); i !== -1; i = content.indexOf(text, i + 1)) found.push(i);
	return found;
}

/** Writes through a temporary file in the same directory and renames it, so readers never see a partial file. */
export async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.atelier-tmp`);
	try {
		await writeFile(temporary, content, { flag: "wx" });
		await chmod(temporary, mode);
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

/**
 * True when the path, as written or as resolved, is under odd/tasks/, in any
 * letter case and also when odd/tasks itself is a symlink to somewhere else.
 */
export async function isFeatureDocument(cwd: string, path: string, target: string): Promise<boolean> {
	const under = (base: string, file: string) => {
		const rel = relative(base, file);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	};
	const lexical = relative(cwd, resolve(cwd, path)).split(sep).join("/").toLowerCase();
	if (lexical.startsWith("odd/tasks/")) return true;
	if (
		relative(await realpath(cwd), target)
			.split(sep)
			.join("/")
			.toLowerCase()
			.startsWith("odd/tasks/")
	)
		return true;
	const protectedDir = await realpath(join(cwd, "odd", "tasks")).catch(() => undefined);
	return protectedDir !== undefined && under(protectedDir, target);
}

export interface Location {
	/** The file as it is on disk, symlinks resolved: the only path `edit` writes. */
	real: string;
	/** Whether `edit` may write it without asking. */
	allowed: boolean;
}

/**
 * Where the file really is and whether it is a place `edit` writes without
 * asking: the working directory, the session's scratch directory, the
 * configuration's `allowWrite` directories, or a file the user approved.
 * Throws `PathProtectedError` for what is never written, approved or not.
 */
export async function locate(cwd: string, path: string, context: ToolContext, home: string): Promise<Location> {
	const absolute = resolve(cwd, path);
	const real = await realpathAllowMissing(absolute);
	const secretDirectories = protectedWriteDirectories(home);
	if (isProtected(absolute, secretDirectories) || isProtected(real, secretDirectories))
		throw new PathProtectedError(path);
	if (isInside(cwd, absolute) && isInside(await realpath(cwd), real)) return { real, allowed: true };
	if (isSecretFile(absolute) || isSecretFile(real)) throw new PathProtectedError(path);
	if (context.scratchDir !== undefined) {
		const scratch = await realpath(context.scratchDir).catch(() => context.scratchDir as string);
		if (isInside(scratch, real)) return { real, allowed: true };
	}
	const { allowWrite } = loadSandboxAdditions({ cwd, home });
	if (allowWrite.some((directory) => isInside(directory, real))) return { real, allowed: true };
	return { real, allowed: context.approvedPaths?.has(real) === true };
}

const notApproved = (real: string) =>
	`Not edited: ${real} is outside the working directory and the user did not approve editing it.`;

export interface EditOptions {
	/** The home whose secret directories stay closed and whose configuration lists writable directories; defaults to the user's. */
	home?: string;
}

export function createEditTool(options: EditOptions = {}): ToolDefinition {
	const home = options.home ?? homedir();
	return defineTool({
		name: "edit",
		description:
			"Edit a file by exact text replacement. Each oldText must appear exactly once in the original file and edits must not overlap. If any edit fails, nothing is written. Paths inside the working directory are edited directly; a file anywhere else needs the user's approval, once per file for the session, and the user's secret files are never edited.",
		inputShape: {
			path: z.string().describe("File path, absolute or relative to the working directory"),
			edits: z
				.array(
					z.object({
						oldText: z.string().describe("Exact text to replace; must be unique in the file"),
						newText: z.string().describe("Replacement text"),
					}),
				)
				.min(1),
		},
		async gate({ path }, context) {
			let location: Location;
			try {
				location = await locate(context.cwd, path, context, home);
			} catch (error) {
				// Nobody is asked about what is never written; execute says why.
				if (error instanceof PathProtectedError) return { refusal: { output: error.message, summary: error.message } };
				return {};
			}
			if (location.allowed) return {};
			// A missing file or a directory is not worth a question: execute reports it.
			if (
				!(await stat(location.real).then(
					(info) => info.isFile(),
					() => false,
				))
			)
				return {};
			return {
				approval: {
					command: `edit ${location.real}`,
					reason: "outside the working directory",
					always: true,
					tool: "edit",
					grant: location.real,
					denial: notApproved(location.real),
				},
			};
		},
		async execute({ path, edits }, context) {
			const { cwd } = context;
			try {
				const { real, allowed } = await locate(cwd, path, context, home);
				const target = await realpath(real);
				// Feature documents change only through the feature tool, which keeps them well formed.
				if (await isFeatureDocument(cwd, path, target))
					return failure(`${path} is a feature document: change it with the feature tool, not edit.`);
				const info = await stat(target);
				if (!info.isFile()) return failure(`Not a file: ${path}`);
				// The approval covers one real path: a link swapped since the question leads to a file nobody approved.
				if (!allowed) return failure(notApproved(target));
				const content = await readFile(target, "utf8");

				const ranges: { start: number; end: number; index: number }[] = [];
				for (const [index, { oldText }] of edits.entries()) {
					if (oldText === "") return failure(`edits[${index}]: oldText is empty.`);
					const found = occurrences(content, oldText);
					if (found.length === 0) return failure(`edits[${index}]: oldText not found in ${path}.`);
					if (found.length > 1)
						return failure(
							`edits[${index}]: oldText appears ${found.length} times in ${path}; add context to make it unique.`,
						);
					const start = found[0] as number;
					ranges.push({ start, end: start + oldText.length, index });
				}
				ranges.sort((a, b) => a.start - b.start);
				for (let i = 1; i < ranges.length; i++) {
					const previous = ranges[i - 1] as (typeof ranges)[number];
					const current = ranges[i] as (typeof ranges)[number];
					if (current.start < previous.end)
						return failure(`edits[${previous.index}] and edits[${current.index}] overlap; merge them into one edit.`);
				}

				let result = "";
				let cursor = 0;
				for (const { start, end, index } of ranges) {
					result += content.slice(cursor, start) + (edits[index] as { newText: string }).newText;
					cursor = end;
				}
				result += content.slice(cursor);

				await writeAtomic(target, result, info.mode & 0o7777);
				const count = `${edits.length} ${edits.length === 1 ? "edit" : "edits"}`;
				return {
					ok: true,
					output: `Edited ${path}: ${count} applied.`,
					summary: `${path} (${count})`,
					truncated: false,
				};
			} catch (error) {
				return failure(errorMessage(error));
			}
		},
	});
}

export const editTool = createEditTool();
