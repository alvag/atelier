import { randomBytes } from "node:crypto";
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { errorMessage, failure } from "./limits.ts";
import { resolveInside } from "./paths.ts";
import { defineTool } from "./types.ts";

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
async function isFeatureDocument(cwd: string, path: string, target: string): Promise<boolean> {
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

export const editTool = defineTool({
	name: "edit",
	description:
		"Edit a file inside the working directory by exact text replacement. Each oldText must appear exactly once in the original file and edits must not overlap. If any edit fails, nothing is written.",
	inputShape: {
		path: z.string().describe("File path, relative to the working directory"),
		edits: z
			.array(
				z.object({
					oldText: z.string().describe("Exact text to replace; must be unique in the file"),
					newText: z.string().describe("Replacement text"),
				}),
			)
			.min(1),
	},
	async execute({ path, edits }, { cwd }) {
		try {
			const target = await realpath(await resolveInside(cwd, path));
			// Feature documents change only through the feature tool, which keeps them well formed.
			if (await isFeatureDocument(cwd, path, target))
				return failure(`${path} is a feature document: change it with the feature tool, not edit.`);
			const info = await stat(target);
			if (!info.isFile()) return failure(`Not a file: ${path}`);
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
			return { ok: true, output: `Edited ${path}: ${count} applied.`, summary: `${path} (${count})`, truncated: false };
		} catch (error) {
			return failure(errorMessage(error));
		}
	},
});
