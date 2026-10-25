import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describeError } from "../events.ts";
import { gitText, runGit, streamGitLines } from "./git.ts";
import {
	contentSignals,
	FENCE,
	importsProcessModule,
	isDocumentationPath,
	isMemberProcessCall,
	isPassiveDocumentContent,
	isScannedPath,
	opensBlockComment,
	SCAN_LIMIT_BYTES,
} from "./signals.ts";

/** package.json files larger than this are kept out of the dependency check, which then treats them as unreadable. */
const MANIFEST_LIMIT_BYTES = 1024 * 1024;
/** Documentation larger than this is not searched for code fences and counts as having one. */
const DOC_LIMIT_BYTES = 1024 * 1024;

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
	/** The line's number in the candidate's file, from 1. */
	line: number;
	/** The file imports the process module, so a member process call on the line spawns one. */
	processModule?: boolean;
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
	/** The tree of the base commit: HEAD, the commit the turn started at, or the ref asked for; the empty tree without one. */
	base: string;
	/** The base commit, in full; absent when the turn started without commits and the base is the empty tree. */
	baseCommit?: string;
	/** The base commit's short id, present when the base is not the current HEAD. */
	since?: string;
	/** Why the base is the current HEAD when it was meant to be an earlier commit. */
	baseNote?: string;
	/** The worktree as a tree: tracked and untracked files, without ignored ones. */
	tree: string;
	files: ChangedFile[];
	changedLines: number;
	/** The first added line per file and kind of content signal (process or dangerous sink); the whole patch is scanned, whatever its size. */
	signalLines: AddedLine[];
	/** The file where the added bytes of scanned files passed the scan limit; the content cannot be trusted to have been read. */
	scanLimit?: string;
	manifests: Manifest[];
	/** Changed documentation files whose new text has a code fence (or is too large to tell). */
	fencedDocs: string[];
	/** Changed documentation files that content does not prove inert: an interpreter line, a script tag, runtime MDX, bytes that are not text. */
	activeDocs: string[];
}

export type FreezeResult = { ok: true; candidate: Candidate } | { ok: false; reason: string };

export interface FreezeOptions {
	/** Freeze against this ref's commit instead of HEAD; an unknown ref is refused. */
	ref?: string;
	/** The commit a turn started at: the base while HEAD still descends from it, the current HEAD (with a note) otherwise. */
	turnStart?: string;
	/** The turn started without a commit: the base is the empty tree, so the turn's first commit is part of the candidate. */
	fromEmpty?: boolean;
}

const EMPTY_BASE_NOTE =
	"The repository had no commits when the turn started: the base is the empty tree, so the turn's commits are part of the candidate";

/** HEAD reflog messages of commits made in the repository itself; anything else (pull, merge, checkout, reset...) moved HEAD onto other history. */
const OWN_COMMIT = /^commit( \((initial|amend)\))?: /;

/** HEAD's reflog, oldest first: where each entry moved HEAD from and to, and why; empty without a reflog or a repository. */
async function headReflog(cwd: string): Promise<{ from: string; to: string; message: string }[]> {
	const path = await runGit(["rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"], { cwd });
	if (path.code !== 0) return [];
	const text = await readFile(withoutNewline(path.stdout.toString("utf8")), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [from = "", to = ""] = line.split(" ");
			return { from, to, message: tab < 0 ? "" : line.slice(tab + 1) };
		});
}

/**
 * The base of a turn that started without commits. HEAD left that state with the last reflog entry that moved
 * it from nothing (all zeros), so that entry and the ones after it are the turn's: the empty tree when all of
 * them are its own commits; where HEAD landed after the last one that was not (a pull, a checkout of existing
 * history), so history the turn did not write is never its candidate; the current HEAD when the reflog cannot tell.
 */
export async function emptyStartBase(cwd: string): Promise<FreezeOptions> {
	const reflog = await headReflog(cwd);
	const born = reflog.findLastIndex((entry) => /^0+$/.test(entry.from));
	if (born < 0) return {};
	const foreign = reflog.slice(born).findLast((entry) => !OWN_COMMIT.test(entry.message));
	return foreign === undefined ? { fromEmpty: true } : { turnStart: foreign.to };
}

/** The candidate's base is an earlier commit than HEAD, or the empty tree under a first commit: some of its work is committed. */
export function holdsCommits(candidate: Candidate): boolean {
	return candidate.since !== undefined || candidate.baseCommit === undefined;
}

/**
 * Freezes the worktree under `cwd`'s repository against HEAD (or the base the
 * options name), so commits made since that base are part of the candidate. The
 * worktree is written into a temporary index, never the user's: their index,
 * staged changes and files stay exactly as they were. Only new git objects are
 * added to the repository, which `git gc` cleans up like any other.
 */
export async function freezeCandidate(cwd: string, options: FreezeOptions = {}): Promise<FreezeResult> {
	let scratch: string | undefined;
	try {
		const top = await runGit(["rev-parse", "--show-toplevel"], { cwd });
		if (top.code !== 0) return { ok: false, reason: "The folder is not inside a git repository." };
		const root = withoutNewline(top.stdout.toString("utf8"));
		const head = await commitOf(root, "HEAD");
		if (head === undefined)
			return { ok: false, reason: "The repository has no commits yet, so there is no HEAD to compare with." };
		const chosen = await chooseBase(root, head, options);
		if (!chosen.ok) return chosen;
		const base = (
			chosen.commit === undefined
				? await gitText(["hash-object", "-w", "-t", "tree", "--stdin"], { cwd: root })
				: await gitText(["rev-parse", `${chosen.commit}^{tree}`], { cwd: root })
		).trim();
		const gitDir = withoutNewline(
			await gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root }),
		);
		scratch = await mkdtemp(join(tmpdir(), "atelier-freeze-"));
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		// write-tree re-hashes racily clean entries through the filters too, so every step gets the overrides.
		const safe = await withoutUserCommands(root);
		await gitText([...safe, "read-tree", base], { cwd: root, env });
		await gitText([...safe, "add", "--all"], { cwd: root, env });
		const tree = (await gitText([...safe, "write-tree"], { cwd: root, env })).trim();
		const candidate = await describeCandidate(root, gitDir, chosen.commit, base, tree);
		return {
			ok: true,
			candidate: {
				...candidate,
				...(chosen.commit === undefined || chosen.commit === head ? {} : { since: chosen.commit.slice(0, SHORT_ID) }),
				...(chosen.note === undefined ? {} : { baseNote: chosen.note }),
			},
		};
	} catch (error) {
		return { ok: false, reason: `Could not freeze the changes: ${describeError(error)}` };
	} finally {
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
	}
}

const SHORT_ID = 7;
/** Commits listed in the turn's git state; the rest are counted. */
const TURN_COMMITS = 50;

/** What the repository shows about the turn's work, which a copy without `.git` cannot. */
export interface TurnGit {
	/** The current branch; absent on a detached HEAD. */
	branch?: string;
	/** `<short id> <subject>` of each commit from the base to HEAD, oldest first. */
	commits: string[];
	/** The worktree differs from HEAD. */
	uncommitted: boolean;
}

/** The branch, the commits since the candidate's base and whether the worktree holds more than HEAD. */
export async function readTurnGit(candidate: Candidate): Promise<TurnGit> {
	const cwd = candidate.root;
	const symbolic = await runGit(["symbolic-ref", "--short", "--quiet", "HEAD"], { cwd });
	const branch = symbolic.code === 0 ? withoutNewline(symbolic.stdout.toString("utf8")) : undefined;
	const range = candidate.baseCommit === undefined ? "HEAD" : `${candidate.baseCommit}..HEAD`;
	const log = await gitText(["log", "--reverse", `--format=%h %s`, range], { cwd });
	const all = log.split("\n").filter((line) => line !== "");
	const commits = all.slice(0, TURN_COMMITS);
	if (all.length > commits.length) commits.push(`... and ${all.length - commits.length} more commits`);
	const headTree = (await gitText(["rev-parse", "HEAD^{tree}"], { cwd })).trim();
	return { ...(branch ? { branch } : {}), commits, uncommitted: headTree !== candidate.tree };
}

/** The commit a revision names, or undefined when there is none. A revision starting with `-` is never passed to git. */
async function commitOf(root: string, revision: string): Promise<string | undefined> {
	if (revision.startsWith("-")) return undefined;
	const found = await runGit(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { cwd: root });
	return found.code === 0 ? found.stdout.toString("utf8").trim() : undefined;
}

/** `commit` is absent for the empty tree. */
type Base = { ok: true; commit?: string; note?: string } | { ok: false; reason: string };

async function chooseBase(root: string, head: string, options: FreezeOptions): Promise<Base> {
	if (options.ref !== undefined) {
		const commit = await commitOf(root, options.ref);
		if (commit === undefined)
			return { ok: false, reason: `Unknown git ref "${options.ref}": there is nothing to review against.` };
		return { ok: true, commit };
	}
	if (options.fromEmpty) return { ok: true, note: EMPTY_BASE_NOTE };
	const start = options.turnStart;
	if (start === undefined || start === head) return { ok: true, commit: head };
	const ancestor = await runGit(["merge-base", "--is-ancestor", start, head], { cwd: root });
	if (ancestor.code === 0) return { ok: true, commit: start };
	return {
		ok: true,
		commit: head,
		note: `HEAD no longer descends from ${start.slice(0, SHORT_ID)}, where the turn started: the base is the current HEAD`,
	};
}

/** git ends a printed path with one newline; a path may itself end in spaces or newlines. */
function withoutNewline(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * Config overrides so `git add` runs none of the user's commands: every
 * configured filter driver is emptied (a clean filter could rewrite the files
 * it is given) and fsmonitor is off. The frozen tree then holds the files' bytes
 * as they are on disk.
 */
async function withoutUserCommands(root: string): Promise<string[]> {
	const listed = await runGit(["config", "--name-only", "-z", "--get-regexp", "^filter\\."], { cwd: root });
	const drivers = new Set<string>();
	for (const key of listed.stdout.toString("utf8").split("\0")) {
		const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
		if (match) drivers.add(match[1] as string);
	}
	const args = ["-c", "core.fsmonitor=false"];
	for (const driver of drivers)
		for (const key of ["clean", "smudge", "process"]) args.push("-c", `filter.${driver}.${key}=`);
	for (const driver of drivers) args.push("-c", `filter.${driver}.required=false`);
	return args;
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
	baseCommit: string | undefined,
	base: string,
	tree: string,
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
	const { lines: signalLines, limitPath: scanLimit } = await scanPatch(root, base, tree);
	const fencedDocs: string[] = [];
	const activeDocs: string[] = [];
	for (const entry of raw) {
		const file = files.find((candidate) => candidate.path === entry.path);
		if (entry.status === "D" || file?.binary || !isDocumentationPath(entry.path)) continue;
		const text = await readBlob(root, entry.newSha, DOC_LIMIT_BYTES);
		if (text === undefined || FENCE.test(text)) fencedDocs.push(entry.path);
		if (text === undefined || !isPassiveDocumentContent(entry.path, text)) activeDocs.push(entry.path);
	}
	const manifests: Manifest[] = [];
	for (const entry of raw) {
		if (basename(entry.path) !== "package.json") continue;
		const manifest: Manifest = { path: entry.path };
		const before = entry.status === "A" ? undefined : await readBlob(root, entry.oldSha, MANIFEST_LIMIT_BYTES);
		const after = entry.status === "D" ? undefined : await readBlob(root, entry.newSha, MANIFEST_LIMIT_BYTES);
		if (before !== undefined) manifest.before = before;
		if (after !== undefined) manifest.after = after;
		manifests.push(manifest);
	}
	return {
		root,
		gitDir,
		base,
		...(baseCommit === undefined ? {} : { baseCommit }),
		tree,
		files,
		changedLines: files.reduce((sum, file) => sum + file.added + file.deleted, 0),
		signalLines,
		...(scanLimit === undefined ? {} : { scanLimit }),
		manifests,
		fencedDocs,
		activeDocs,
	};
}

async function readBlob(root: string, sha: string, limitBytes: number): Promise<string | undefined> {
	const result = await runGit(["cat-file", "blob", sha], { cwd: root, limitBytes });
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
 * Streams the whole -U0 patch and keeps, per file, the first added line of each
 * kind of content signal. It also counts the added bytes of scanned files and
 * names the file where they pass the scan limit. File headers are recognised
 * only before a file's first hunk, so an added line that itself starts with
 * `++` is never taken for a header.
 */
async function scanPatch(
	root: string,
	base: string,
	tree: string,
): Promise<{ lines: AddedLine[]; limitPath: string | undefined }> {
	const found: AddedLine[] = [];
	const seen = new Set<string>();
	let path: string | undefined;
	let inHunk = false;
	let line = 0;
	let scanned = 0;
	let limitPath: string | undefined;
	/** Inside a block comment opened by an earlier added line of the same hunk. */
	let inBlock = false;
	/** Per file, the first added line with a member process call, checked against the file's imports afterwards. */
	const memberCalls = new Map<string, AddedLine>();
	const result = await streamGitLines([...DIFF, "-p", "-U0", "--no-color", base, tree], { cwd: root }, (bytes) => {
		const first = bytes[0];
		if (first === 0x2b /* + */ && inHunk) {
			line++;
			if (path === undefined) return;
			if (limitPath === undefined && isScannedPath(path)) {
				scanned += bytes.length;
				if (scanned > SCAN_LIMIT_BYTES) limitPath = path;
			}
			let text = bytes.subarray(1).toString("utf8");
			if (inBlock) {
				const close = text.indexOf("*/");
				if (close < 0) return;
				inBlock = false;
				text = text.slice(close + 2);
			} else if (opensBlockComment(path, text)) {
				inBlock = true;
				return;
			}
			const signals = contentSignals(path, text);
			if (
				!signals.some(({ kind }) => kind === "shell_process") &&
				!memberCalls.has(path) &&
				isMemberProcessCall(path, text)
			)
				memberCalls.set(path, { path, text, line });
			for (const { kind } of signals) {
				const key = `${kind}\0${path}`;
				if (seen.has(key)) continue;
				seen.add(key);
				found.push({ path, text, line });
			}
			return;
		}
		if (first !== 0x2b && first !== 0x2d && first !== 0x40 && first !== 0x64) return;
		const header = bytes.toString("utf8");
		if (header.startsWith("diff --git ")) {
			path = undefined;
			inHunk = false;
			inBlock = false;
		} else if (!inHunk && header.startsWith("+++ ")) {
			path = header === "+++ /dev/null" ? undefined : headerPath(header.slice(4));
		} else if (header.startsWith("@@")) {
			inHunk = true;
			inBlock = false;
			line = Number(/^@@ -\S+ \+(\d+)/.exec(header)?.[1] ?? 1) - 1;
		}
	});
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git diff-tree exited with ${result.code}`);
	for (const call of memberCalls.values()) {
		if (seen.has(`shell_process\0${call.path}`)) continue;
		const file = await readTreeFile(root, tree, call.path);
		if (file !== undefined && importsProcessModule(file)) found.push({ ...call, processModule: true });
	}
	return { lines: found, limitPath };
}

/**
 * The path of a `+++ b/<path>` header. git C-quotes unusual paths (octal bytes
 * for non-ASCII, \\t, \\", ...) and ends an unquoted path that has a space with
 * a tab; an unquoted path can never itself end in a tab, which would be quoted.
 */
function headerPath(text: string): string {
	const name = text.startsWith('"') ? unquoteC(text) : text.replace(/\t$/, "");
	return name.replace(/^b\//, "");
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

function unquoteC(text: string): string {
	const body = Buffer.from(text.slice(1, text.lastIndexOf('"')), "utf8");
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i++) {
		const byte = body[i] as number;
		if (byte !== 92) {
			bytes.push(byte);
			continue;
		}
		const next = String.fromCharCode(body[i + 1] ?? 0);
		const octal = body.subarray(i + 1, i + 4).toString("latin1");
		if (/^[0-7]{3}$/.test(octal)) {
			bytes.push(Number.parseInt(octal, 8));
			i += 3;
		} else {
			bytes.push(C_ESCAPES[next] ?? (body[i + 1] as number));
			i += 1;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}
