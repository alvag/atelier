import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

/** A file the correction changed, as it was in the candidate; `sha` absent when the correction created it. */
interface Changed {
	path: string;
	mode?: string;
	sha?: string;
}

const DIFF = ["diff-tree", "-r", "--no-renames", "-z"];
const NO_FILE = /^0+$/;
const SYMLINK = "120000";
const EXECUTABLE = "100755";

/**
 * Puts the files a correction changed back to what they held in the candidate tree: modified and deleted
 * files get the candidate's bytes and mode, created ones are removed. It fails closed before writing
 * anything: when a correction file is committed, or the worktree no longer holds the corrected version of
 * one of them. Other files, the index and the commits are never touched.
 */
export async function undoCorrection(root: string, candidate: string, corrected: string): Promise<UndoResult> {
	try {
		const changed = await changedFiles(root, candidate, corrected);
		if (changed.length === 0) return { ok: false, code: "no_correction", message: "The correction changed no file." };
		const paths = changed.map((file) => file.path);
		const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { cwd: root });
		if (head.code === 0) {
			const differs = await differingPaths(root, corrected, head.stdout.toString("utf8").trim());
			const committed = paths.filter((path) => !differs.has(path));
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
		for (const file of changed) {
			if (file.sha === undefined) continue;
			if (file.mode !== SYMLINK && !file.mode?.startsWith("100"))
				return { ok: false, code: "undo_failed", message: `${file.path} is not a file; nothing was undone.` };
			blobs.set(file.path, (await runGitOk(["cat-file", "blob", file.sha], root)).stdout);
		}
		return await restore(root, changed, blobs);
	} catch (error) {
		return { ok: false, code: "undo_failed", message: `The correction could not be undone: ${describeError(error)}` };
	}
}

/** Writes the candidate's files: removals first, so a path the correction turned into a directory is free again. */
async function restore(root: string, changed: Changed[], blobs: Map<string, Buffer>): Promise<UndoResult> {
	const removed: string[] = [];
	const restored: string[] = [];
	const top = await realpath(root);
	try {
		for (const file of changed) {
			if (file.sha !== undefined) continue;
			await rm(await inside(top, file.path), { force: true });
			removed.push(file.path);
		}
		for (const file of changed) {
			const bytes = blobs.get(file.path);
			if (bytes === undefined) continue;
			const path = await inside(top, file.path);
			await mkdir(dirname(path), { recursive: true });
			await rm(path, { force: true });
			if (file.mode === SYMLINK) await symlink(bytes.toString("utf8"), path);
			else {
				const mode = file.mode === EXECUTABLE ? 0o755 : 0o644;
				await writeFile(path, bytes, { mode, flag: "wx" });
				await chmod(path, mode);
			}
			restored.push(file.path);
		}
	} catch (error) {
		const done = [...restored, ...removed];
		return {
			ok: false,
			code: "undo_failed",
			message: `The correction was only partly undone (${done.length === 0 ? "nothing" : done.join(", ")}): ${describeError(error)}`,
		};
	}
	return { ok: true, restored, removed };
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

/** What the correction changed between the two trees, with each file's candidate mode and blob. */
async function changedFiles(root: string, candidate: string, corrected: string): Promise<Changed[]> {
	const parts = (await gitText([...DIFF, "--raw", candidate, corrected], { cwd: root })).split("\0");
	const files: Changed[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const [oldMode = "", , oldSha = ""] = (parts[i] as string).replace(/^:/, "").split(" ");
		const path = parts[i + 1] as string;
		files.push(NO_FILE.test(oldSha) ? { path } : { path, mode: oldMode, sha: oldSha });
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
