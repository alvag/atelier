import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** The most the instruction files may add to the system prompt, headers included. */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export interface ProjectInstructions {
	/** What goes at the end of the system prompt; empty when no file was loaded. */
	text: string;
	/** Paths loaded, outermost first. */
	files: string[];
	/** Paths left out because of the cap, outermost first. */
	dropped: string[];
}

/** Folders from the outermost one down to `cwd`, stopping before `home` or at the disk root. */
function folders(cwd: string, home: string): string[] {
	const found: string[] = [];
	let dir = resolve(cwd);
	const stop = resolve(home);
	while (dir !== stop) {
		found.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

/** `AGENTS.md`, or `CLAUDE.md` when there is none; anything unreadable counts as absent. */
async function readInstructions(dir: string): Promise<{ path: string; text: string } | undefined> {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = join(dir, name);
		try {
			return { path, text: (await readFile(path, "utf8")).trim() };
		} catch {}
	}
	return undefined;
}

/**
 * Reads the instruction files from `cwd` up to `home` (excluded), once. The closest comes last so it wins
 * a contradiction; over the cap, the outermost files are dropped first.
 */
export async function loadProjectInstructions(cwd: string, home: string): Promise<ProjectInstructions> {
	const read = await Promise.all(folders(cwd, home).map(readInstructions));
	const blocks = read.flatMap((file) =>
		file && file.text !== ""
			? [{ path: file.path, block: `Project instructions from ${file.path}:\n\n${file.text}` }]
			: [],
	);
	const joiner = "\n\n";
	let first = 0;
	let size = blocks.reduce((sum, { block }) => sum + Buffer.byteLength(block) + joiner.length, -joiner.length);
	while (first < blocks.length && size > MAX_INSTRUCTIONS_BYTES) {
		size -= Buffer.byteLength(blocks[first]?.block ?? "") + joiner.length;
		first++;
	}
	const kept = blocks.slice(first);
	return {
		text: kept.map(({ block }) => block).join(joiner),
		files: kept.map(({ path }) => path),
		dropped: blocks.slice(0, first).map(({ path }) => path),
	};
}
