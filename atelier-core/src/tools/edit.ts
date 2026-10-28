import { randomBytes } from "node:crypto";
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage, failure } from "./limits.ts";
import {
	isInside,
	isProtectedFolded,
	isSecretFileFolded,
	PathProtectedError,
	protectedWritePlaces,
	realpathAllowMissing,
} from "./paths.ts";
import { approvalMismatch, projectRefusal, rememberApproval } from "./protection.ts";
import { loadSandboxAdditions } from "./sandbox-config.ts";
import { defineTool, type ToolContext, type ToolDefinition } from "./types.ts";

function occurrences(content: string, text: string): number[] {
	const found: number[] = [];
	for (let i = content.indexOf(text); i !== -1; i = content.indexOf(text, i + 1)) found.push(i);
	return found;
}

/** How many line breaks `text` has. */
function breaks(text: string): number {
	let count = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
	return count;
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
	const protectedPlaces = protectedWritePlaces(home);
	if (isProtectedFolded(absolute, protectedPlaces) || isProtectedFolded(real, protectedPlaces))
		throw new PathProtectedError(path);
	if (isInside(cwd, absolute) && isInside(await realpath(cwd), real)) return { real, allowed: true };
	if (isSecretFileFolded(absolute) || isSecretFileFolded(real)) throw new PathProtectedError(path);
	if (context.scratchDir !== undefined) {
		const scratch = await realpath(context.scratchDir).catch(() => context.scratchDir as string);
		if (isInside(scratch, real)) return { real, allowed: true };
	}
	const { allowWrite } = loadSandboxAdditions({ cwd, home });
	if (allowWrite.some((directory) => isInside(directory, real))) return { real, allowed: true };
	if (context.pathRules?.some((folder) => isInside(folder, real))) return { real, allowed: true };
	return { real, allowed: context.approvedPaths?.has(real) === true };
}

/** What an answer about a file outside may remember: its folder, or the file alone when that folder is or holds the home. */
export function folderOffer(real: string, home: string): { rules: string[]; always: boolean } {
	const folder = dirname(real);
	return { rules: [isInside(folder, home) ? real : folder], always: true };
}

const notApproved = (real: string) =>
	`Not edited: ${real} is outside the working directory and the user did not approve editing it.`;

/** What the model is told when the path it named leads somewhere else than where the user was asked. */
export const changedSinceAsked = (verb: string, path: string, asked: string, now: string) =>
	`Not ${verb}: ${path} led to ${asked} when the user was asked, but now leads to ${now}.`;

export interface EditOptions {
	/** The home whose secret directories stay closed and whose configuration lists writable directories; defaults to the user's. */
	home?: string;
}

export function createEditTool(options: EditOptions = {}): ToolDefinition {
	const home = options.home ?? homedir();
	return defineTool({
		name: "edit",
		description:
			"Edit a file by exact text replacement. Each oldText must appear exactly once in the original file and edits must not overlap. If any edit fails, nothing is written. Paths inside the working directory are edited directly; a file anywhere else needs the user's approval, once per file for the session or for a folder the user allows, and the user's secret files are never edited.",
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
				const message = await projectRefusal("edit", context.cwd, path, location.real, home);
				if (message !== undefined) return { refusal: { output: message, summary: message } };
			} catch (error) {
				// Nobody is asked about what is never written; execute says why.
				if (error instanceof PathProtectedError) return { refusal: { output: error.message, summary: error.message } };
				return {};
			}
			rememberApproval(context.callId, undefined);
			if (location.allowed) return {};
			// A missing file or a directory is not worth a question: execute reports it.
			if (
				!(await stat(location.real).then(
					(info) => info.isFile(),
					() => false,
				))
			)
				return {};
			rememberApproval(context.callId, location.real);
			return {
				approval: {
					command: `edit ${location.real}`,
					reason: "outside the working directory",
					tool: "edit",
					grant: location.real,
					denial: notApproved(location.real),
					remember: folderOffer(location.real, home),
				},
			};
		},
		async execute({ path, edits }, context) {
			const { cwd } = context;
			try {
				const { real, allowed } = await locate(cwd, path, context, home);
				const refusal = await projectRefusal("edit", cwd, path, real, home);
				if (refusal !== undefined) return failure(refusal);
				const target = await realpath(real);
				// The approval named one real path: a link retargeted during the question leads to a file nobody was asked about.
				const asked = approvalMismatch(context.callId, target);
				if (asked !== undefined) return failure(changedSinceAsked("edited", path, asked, target));
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
				// Where each edit starts in the file before and after the edits, counted once in the file's order.
				const startLines: number[] = [];
				const newStartLines: number[] = [];
				let oldLine = 1;
				let newLine = 1;
				for (const { start, end, index } of ranges) {
					const kept = content.slice(cursor, start);
					const { newText } = edits[index] as { newText: string };
					oldLine += breaks(kept);
					newLine += breaks(kept);
					startLines[index] = oldLine;
					newStartLines[index] = newLine;
					oldLine += breaks(content.slice(start, end));
					newLine += breaks(newText);
					result += kept + newText;
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
					startLines,
					newStartLines,
				};
			} catch (error) {
				return failure(errorMessage(error));
			}
		},
	});
}

export const editTool = createEditTool();
