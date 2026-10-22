import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describeError } from "../events.ts";
import { gitText, runGit } from "./git.ts";

/** Added lines past this many bytes of patch are not scanned; the candidate says so. */
export const SCAN_LIMIT_BYTES = 8 * 1024 * 1024;
/** package.json files larger than this are kept out of the dependency check, which then treats them as unreadable. */
const MANIFEST_LIMIT_BYTES = 1024 * 1024;

export interface ChangedFile {
	/** Relative to the repository root, with forward slashes. */
	path: string;
	/** A added, M modified, D deleted, T type changed. */
	status: "A" | "M" | "D" | "T";
	added: number;
	deleted: number;
	binary: boolean;
	/** The file's mode in the candidate, or in the base when deleted: 100644, 100755, 120000... */
	mode: string;
}

export interface AddedLine {
	path: string;
	text: string;
}

/** The old and new text of a changed package.json; absent on the side where the file does not exist. */
export interface Manifest {
	path: string;
	before?: string;
	after?: string;
}

/**
 * A frozen change: two git trees and what differs between them. The trees are
 * immutable, so whatever happens to the worktree later, a review of this
 * candidate reads exactly these bytes.
 */
export interface Candidate {
	root: string;
	/** The repository's common git directory, absolute. */
	gitDir: string;
	/** HEAD's tree. */
	base: string;
	/** The worktree as a tree: tracked and untracked files, without ignored ones. */
	tree: string;
	files: ChangedFile[];
	changedLines: number;
	addedLines: AddedLine[];
	manifests: Manifest[];
	/** The patch was larger than the scan limit, so not every added line is in addedLines. */
	scanTruncated: boolean;
}

export type FreezeResult = { ok: true; candidate: Candidate } | { ok: false; reason: string };

export interface FreezeOptions {
	scanLimitBytes?: number;
}

/**
 * Freezes the uncommitted changes under `cwd`'s repository against HEAD. The
 * worktree is written into a temporary index, never the user's: their index,
 * staged changes and files stay exactly as they were. Only new git objects are
 * added to the repository, which `git gc` cleans up like any other.
 */
export async function freezeCandidate(cwd: string, options: FreezeOptions = {}): Promise<FreezeResult> {
	const top = await runGit(["rev-parse", "--show-toplevel"], { cwd });
	if (top.code !== 0) return { ok: false, reason: "The folder is not inside a git repository." };
	const root = top.stdout.toString("utf8").trim();
	const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { cwd: root });
	if (head.code !== 0)
		return { ok: false, reason: "The repository has no commits yet, so there is no HEAD to compare with." };
	const base = head.stdout.toString("utf8").trim();

	let scratch: string | undefined;
	try {
		const gitDir = (await gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root })).trim();
		scratch = await mkdtemp(join(tmpdir(), "atelier-freeze-"));
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		await gitText(["read-tree", base], { cwd: root, env });
		await gitText(["add", "--all"], { cwd: root, env });
		const tree = (await gitText(["write-tree"], { cwd: root, env })).trim();
		return { ok: true, candidate: await describeCandidate(root, gitDir, base, tree, options) };
	} catch (error) {
		return { ok: false, reason: `Could not freeze the changes: ${describeError(error)}` };
	} finally {
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
	}
}

/** Reads a file from a frozen tree; undefined when the tree has no such file. */
export async function readTreeFile(root: string, tree: string, path: string): Promise<string | undefined> {
	const result = await runGit(["cat-file", "blob", `${tree}:${path}`], { cwd: root });
	return result.code === 0 ? result.stdout.toString("utf8") : undefined;
}

const DIFF = ["diff-tree", "-r", "--no-renames", "--no-ext-diff", "--no-textconv"];

async function describeCandidate(
	root: string,
	gitDir: string,
	base: string,
	tree: string,
	options: FreezeOptions,
): Promise<Candidate> {
	const raw = parseRaw(await gitText([...DIFF, "-z", "--raw", base, tree], { cwd: root }));
	const counts = parseNumstat(await gitText([...DIFF, "-z", "--numstat", base, tree], { cwd: root }));
	const files: ChangedFile[] = raw.map((entry) => {
		const count = counts.get(entry.path);
		return {
			path: entry.path,
			status: entry.status,
			added: count?.added ?? 0,
			deleted: count?.deleted ?? 0,
			binary: count?.binary ?? false,
			mode: entry.status === "D" ? entry.oldMode : entry.newMode,
		};
	});
	const patch = await runGit([...DIFF, "-p", "-U0", "--no-color", base, tree], {
		cwd: root,
		limitBytes: options.scanLimitBytes ?? SCAN_LIMIT_BYTES,
	});
	const manifests: Manifest[] = [];
	for (const entry of raw) {
		if (basename(entry.path) !== "package.json") continue;
		const manifest: Manifest = { path: entry.path };
		const before = entry.status === "A" ? undefined : await readBlob(root, entry.oldSha);
		const after = entry.status === "D" ? undefined : await readBlob(root, entry.newSha);
		if (before !== undefined) manifest.before = before;
		if (after !== undefined) manifest.after = after;
		manifests.push(manifest);
	}
	return {
		root,
		gitDir,
		base,
		tree,
		files,
		changedLines: files.reduce((sum, file) => sum + file.added + file.deleted, 0),
		addedLines: parseAddedLines(patch.stdout.toString("utf8"), patch.truncated),
		manifests,
		scanTruncated: patch.truncated,
	};
}

async function readBlob(root: string, sha: string): Promise<string | undefined> {
	const result = await runGit(["cat-file", "blob", sha], { cwd: root, limitBytes: MANIFEST_LIMIT_BYTES });
	return result.code === 0 && !result.truncated ? result.stdout.toString("utf8") : undefined;
}

interface RawEntry {
	path: string;
	status: ChangedFile["status"];
	oldMode: string;
	newMode: string;
	oldSha: string;
	newSha: string;
}

/** `:oldmode newmode oldsha newsha status\0path\0`, repeated. */
function parseRaw(text: string): RawEntry[] {
	const parts = text.split("\0");
	const entries: RawEntry[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const [oldMode, newMode, oldSha, newSha, status] = (parts[i] as string).replace(/^:/, "").split(" ");
		const letter = (status ?? "M").charAt(0);
		entries.push({
			path: parts[i + 1] as string,
			status: letter === "A" || letter === "D" || letter === "T" ? letter : "M",
			oldMode: oldMode ?? "",
			newMode: newMode ?? "",
			oldSha: oldSha ?? "",
			newSha: newSha ?? "",
		});
	}
	return entries;
}

/** `added\tdeleted\tpath\0`, with `-` for binary files. */
function parseNumstat(text: string): Map<string, { added: number; deleted: number; binary: boolean }> {
	const counts = new Map<string, { added: number; deleted: number; binary: boolean }>();
	for (const record of text.split("\0")) {
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
		if (!match) continue;
		const binary = match[1] === "-";
		counts.set(match[3] as string, {
			added: binary ? 0 : Number(match[1]),
			deleted: binary ? 0 : Number(match[2]),
			binary,
		});
	}
	return counts;
}

/**
 * The `+` lines of a -U0 patch, by file. File headers are recognised only
 * before a file's first hunk, so an added line that itself starts with `++`
 * is never taken for a header. A patch cut at the scan limit drops its last,
 * possibly partial line.
 */
function parseAddedLines(patch: string, truncated: boolean): AddedLine[] {
	const lines = patch.split("\n");
	if (truncated) lines.pop();
	const added: AddedLine[] = [];
	let path: string | undefined;
	let inHunk = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			path = undefined;
			inHunk = false;
		} else if (!inHunk && line.startsWith("+++ ")) {
			path = line === "+++ /dev/null" ? undefined : unquote(line.slice(4)).replace(/^b\//, "");
		} else if (line.startsWith("@@")) {
			inHunk = true;
		} else if (inHunk && path !== undefined && line.startsWith("+")) {
			added.push({ path, text: line.slice(1) });
		}
	}
	return added;
}

/** git quotes unusual paths C-style; JSON covers the common escapes. */
function unquote(text: string): string {
	if (!text.startsWith('"')) return text;
	try {
		return JSON.parse(text) as string;
	} catch {
		return text.slice(1, -1);
	}
}
