import { chmod, lstat, mkdir, readFile, readlink, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { describeError } from "../events.ts";
import { freezeCandidate } from "./candidate.ts";
import { gitText, runGit } from "./git.ts";

export type UndoResult =
	| { ok: true; restored: string[]; removed: string[] }
	| {
			ok: false;
			code: "correction_changed" | "correction_committed" | "no_correction" | "undo_failed";
			message: string;
	  };

/**
 * A file the correction changed, as it was in the candidate (`sha` absent when the correction created it) and as
 * the correction left it (`correctedSha` absent when it deleted it).
 */
interface Changed {
	path: string;
	mode?: string;
	sha?: string;
	correctedMode?: string;
	correctedSha?: string;
}

const DIFF = ["diff-tree", "-r", "--no-renames", "-z"];
const NO_FILE = /^0+$/;
const SYMLINK = "120000";
const EXECUTABLE = "100755";

/**
 * Puts the files a correction changed back to what they held in the candidate tree: modified and deleted
 * files get the candidate's bytes and mode, created ones are removed. It fails closed before writing
 * anything: when HEAD moved since the review (`headAtReview`, its tree then) to the corrected version of one
 * of those files, or the worktree no longer holds the corrected version of one of them. When writing fails midway,
 * the files it reached are put back as the correction left them. Other files, the index and the commits are never
 * touched.
 */
export async function undoCorrection(
	root: string,
	candidate: string,
	corrected: string,
	headAtReview: string,
): Promise<UndoResult> {
	try {
		const changed = await changedFiles(root, candidate, corrected);
		if (changed.length === 0) return { ok: false, code: "no_correction", message: "The correction changed no file." };
		const paths = changed.map((file) => file.path);
		const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { cwd: root });
		if (head.code === 0) {
			const now = head.stdout.toString("utf8").trim();
			// A file HEAD already held as corrected (one the correction reverted or deleted) proves nothing: only a commit since the review does.
			const moved = await differingPaths(root, headAtReview, now);
			const differs = await differingPaths(root, corrected, now);
			const committed = paths.filter((path) => moved.has(path) && !differs.has(path));
			if (committed.length > 0)
				return {
					ok: false,
					code: "correction_committed",
					message: `The correction is already committed (${committed.join(", ")}); nothing was undone.`,
				};
		}
		const now = await freezeCandidate(root);
		if (!now.ok) return { ok: false, code: "undo_failed", message: now.reason };
		const differs = await differingPaths(root, corrected, now.candidate.tree);
		const touched = paths.filter((path) => differs.has(path));
		if (touched.length > 0)
			return {
				ok: false,
				code: "correction_changed",
				message: `Changed since the correction: ${touched.join(", ")}; nothing was undone.`,
			};
		const blobs = new Map<string, Buffer>();
		const correctedBlobs = new Map<string, Buffer>();
		for (const file of changed) {
			for (const [sha, mode, into] of [
				[file.sha, file.mode, blobs],
				[file.correctedSha, file.correctedMode, correctedBlobs],
			] as const) {
				if (sha === undefined) continue;
				if (!isFileMode(mode))
					return { ok: false, code: "undo_failed", message: `${file.path} is not a file; nothing was undone.` };
				into.set(file.path, (await runGitOk(["cat-file", "blob", sha], root)).stdout);
			}
		}
		return await restore(root, changed, blobs, correctedBlobs);
	} catch (error) {
		return { ok: false, code: "undo_failed", message: `The correction could not be undone: ${describeError(error)}` };
	}
}

/** Writes the candidate's files: removals first, so a path the correction turned into a directory is free again. */
async function restore(
	root: string,
	changed: Changed[],
	blobs: Map<string, Buffer>,
	correctedBlobs: Map<string, Buffer>,
): Promise<UndoResult> {
	const removed: string[] = [];
	const restored: string[] = [];
	const reached: Changed[] = [];
	const top = await realpath(root);
	try {
		for (const file of changed) {
			if (file.sha !== undefined) continue;
			reached.push(file);
			const path = await inside(top, file.path);
			await rm(path, { force: true });
			await pruneEmpty(top, dirname(path));
			removed.push(file.path);
		}
		for (const file of changed) {
			const bytes = blobs.get(file.path);
			if (bytes === undefined) continue;
			reached.push(file);
			await put(await inside(top, file.path), file.mode, bytes);
			restored.push(file.path);
		}
	} catch (error) {
		return rollBack(top, reached, correctedBlobs, error);
	}
	return { ok: true, restored, removed };
}

/**
 * Puts the files a failed restore reached back as the correction left them, which the worktree held before it
 * began: the ones the correction deleted are removed first, so a folder it made is free again. Then reports the
 * failure, and which files are in doubt when putting one back failed too.
 */
async function rollBack(
	top: string,
	reached: Changed[],
	correctedBlobs: Map<string, Buffer>,
	error: unknown,
): Promise<UndoResult> {
	const back: string[] = [];
	const stuck: string[] = [];
	let failure: unknown;
	const deleted = reached.filter((file) => !correctedBlobs.has(file.path));
	const written = reached.filter((file) => correctedBlobs.has(file.path));
	for (const file of [...deleted, ...written]) {
		try {
			const path = await inside(top, file.path);
			const bytes = correctedBlobs.get(file.path);
			if (bytes === undefined) {
				await rm(path, { force: true });
				await pruneEmpty(top, dirname(path));
			} else if (!(await holds(path, file.correctedMode, bytes))) await put(path, file.correctedMode, bytes);
			back.push(file.path);
		} catch (again) {
			failure ??= again;
			stuck.push(file.path);
		}
	}
	const list = (paths: string[]) => (paths.length === 0 ? "nothing" : paths.join(", "));
	if (stuck.length === 0)
		return {
			ok: false,
			code: "undo_failed",
			message: `The correction could not be undone (${describeError(error)}); the files it reached were put back as the correction left them: ${list(back)}.`,
		};
	return {
		ok: false,
		code: "undo_failed",
		message: `The correction was only partly undone (${describeError(error)}), and putting it back failed too (${describeError(failure)}): put back as the correction left them: ${list(back)}; neither as the correction left them nor as the candidate had them, perhaps: ${list(stuck)}; every other file is as the correction left it.`,
	};
}

/** Writes one file or symbolic link with a tree's bytes and mode, replacing what is at `path`. */
async function put(path: string, treeMode: string | undefined, bytes: Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await rm(path, { force: true });
	if (treeMode === SYMLINK) await symlink(bytes.toString("utf8"), path);
	else {
		const mode = treeMode === EXECUTABLE ? 0o755 : 0o644;
		await writeFile(path, bytes, { mode, flag: "wx" });
		await chmod(path, mode);
	}
}

/** Whether `path` already holds a tree entry's bytes and mode: a step that failed before writing left it alone. */
async function holds(path: string, treeMode: string | undefined, bytes: Buffer): Promise<boolean> {
	try {
		const found = await lstat(path);
		if (treeMode === SYMLINK) return found.isSymbolicLink() && (await readlink(path)) === bytes.toString("utf8");
		const executable = (found.mode & 0o100) !== 0;
		return found.isFile() && executable === (treeMode === EXECUTABLE) && (await readFile(path)).equals(bytes);
	} catch {
		return false;
	}
}

function isFileMode(mode: string | undefined): boolean {
	return mode === SYMLINK || mode?.startsWith("100") === true;
}

/** Removes the folders a removal left empty, up to the worktree's root: one may hide a file the candidate had there. */
async function pruneEmpty(top: string, folder: string): Promise<void> {
	for (let at = folder; at !== top && dirname(at) !== at; at = dirname(at)) {
		try {
			await rmdir(at);
		} catch {
			return;
		}
	}
}

/** The absolute path of a repository path, refused when it or a symbolic link on its way leads outside the worktree. */
async function inside(top: string, path: string): Promise<string> {
	const full = join(top, path);
	const outside = (target: string) => {
		const rel = relative(top, target);
		return rel.startsWith("..") || isAbsolute(rel);
	};
	if (outside(full)) throw new Error(`${path} is outside the worktree`);
	if (outside(await existingAncestor(dirname(full)))) throw new Error(`${path} leads outside the worktree`);
	return full;
}

/** The real path of the nearest folder on the way to `path` that exists. */
async function existingAncestor(path: string): Promise<string> {
	for (let at = path; ; at = dirname(at)) {
		try {
			return await realpath(at);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error;
		}
	}
}

/** What the correction changed between the two trees, with each file's mode and blob in both. */
async function changedFiles(root: string, candidate: string, corrected: string): Promise<Changed[]> {
	const parts = (await gitText([...DIFF, "--raw", candidate, corrected], { cwd: root })).split("\0");
	const files: Changed[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const [oldMode = "", newMode = "", oldSha = "", newSha = ""] = (parts[i] as string).replace(/^:/, "").split(" ");
		const path = parts[i + 1] as string;
		files.push({
			path,
			...(NO_FILE.test(oldSha) ? {} : { mode: oldMode, sha: oldSha }),
			...(NO_FILE.test(newSha) ? {} : { correctedMode: newMode, correctedSha: newSha }),
		});
	}
	return files;
}

/** The paths whose entry differs between two trees, a mode change included. */
async function differingPaths(root: string, a: string, b: string): Promise<Set<string>> {
	const names = await gitText([...DIFF, "--name-only", a, b], { cwd: root });
	return new Set(names.split("\0").filter((name) => name !== ""));
}

async function runGitOk(args: string[], cwd: string) {
	const result = await runGit(args, { cwd });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
	return result;
}
