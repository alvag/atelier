import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A patch bigger than this is not collected: it would not be reviewed whole anyway. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
/** The snapshot commit is never on a branch; it only needs an author git accepts. */
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "Atelier",
	GIT_AUTHOR_EMAIL: "atelier@localhost",
	GIT_COMMITTER_NAME: "Atelier",
	GIT_COMMITTER_EMAIL: "atelier@localhost",
};

/** A worktree refused before anything was made: the folder is not in a git repository with a commit. */
export class WorktreeRefusedError extends Error {
	override name = "WorktreeRefusedError";
}

/** What a worker changed in its worktree, as a patch against the snapshot it started from. */
export interface WorktreeChanges {
	patchPath: string;
	/** The files the patch changes, as paths from the repository's top. */
	files: string[];
	insertions: number;
	deletions: number;
}

/** A worker's own worktree of the parent's tree as it was when the task started. */
export interface TaskWorktree {
	/** The top of the parent's checkout: where the patch applies. */
	top: string;
	/** The folder in the worktree that stands where the parent's working directory does in the checkout. */
	cwd: string;
	/** HEAD's short id when the snapshot was taken, and whether the snapshot has uncommitted changes on top of it. */
	head: string;
	dirty: boolean;
	/** Writes the patch of what changed to `patchPath`; undefined when nothing changed. */
	collect(patchPath: string): Promise<WorktreeChanges | undefined>;
	/** The files of the parent's tree that differ from the snapshot now: what the parent changed since. */
	changedSince(): Promise<string[]>;
	/** Removes the worktree and what git keeps of it; whatever fails, the folder goes. */
	remove(): Promise<void>;
}

/** Runs git without hooks: nothing of the repository's own code runs for a snapshot, a worktree or a patch. */
async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
		maxBuffer: MAX_PATCH_BYTES,
	});
	return stdout;
}

/**
 * The tree of `top`'s working tree as it is now, tracked and untracked files but not ignored ones, written with an
 * index of its own (`index`), so the user's index, branches and stash are never touched.
 */
async function treeOfWorkingTree(top: string, base: string, index: string): Promise<string> {
	const env = { GIT_INDEX_FILE: index };
	await git(top, ["read-tree", base], env);
	await git(top, ["add", "-A"], env);
	return (await git(top, ["write-tree"], env)).trim();
}

/**
 * Makes a worktree in `dir` of `cwd`'s repository, detached at a snapshot of its working tree: HEAD plus the changes
 * not committed yet. Throws WorktreeRefusedError when `cwd` is not in a repository with a commit.
 */
export async function createTaskWorktree(cwd: string, dir: string): Promise<TaskWorktree> {
	const refused = () =>
		new WorktreeRefusedError(
			`Refused: a worker runs in the background in a git worktree of its own, and ${cwd} is not in a git repository with a commit; run it without background.`,
		);
	let top: string;
	let head: string;
	try {
		top = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
		head = (await git(top, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
	} catch {
		throw refused();
	}
	await mkdir(dir, { recursive: true });
	const index = join(dir, "index");
	const tree = join(dir, "tree");
	let headTree: string;
	let snapshotTree: string;
	let snapshot: string;
	let place: string;
	try {
		headTree = (await git(top, ["rev-parse", "HEAD^{tree}"])).trim();
		snapshotTree = await treeOfWorkingTree(top, head, index);
		snapshot = (
			await git(
				top,
				["commit-tree", snapshotTree, "-p", head, "-m", "atelier: snapshot for a background worker"],
				SNAPSHOT_IDENTITY,
			)
		).trim();
		// What a crash left of earlier worktrees (their folder gone) is cleared first.
		await git(top, ["worktree", "prune"]).catch(() => "");
		await git(top, ["worktree", "add", "--detach", tree, snapshot]);
		place = join(tree, relative(top, await realpath(cwd)));
		await mkdir(place, { recursive: true });
	} catch (error) {
		await git(top, ["worktree", "remove", "--force", tree]).catch(() => "");
		await rm(dir, { recursive: true, force: true });
		await git(top, ["worktree", "prune"]).catch(() => "");
		throw error;
	}
	let removed: Promise<void> | undefined;
	return {
		top,
		cwd: place,
		head: head.slice(0, 7),
		dirty: snapshotTree !== headTree,
		async collect(patchPath) {
			const changed = await treeOfWorkingTree(tree, snapshot, index);
			if (changed === snapshotTree) return undefined;
			const patch = await git(tree, ["diff", "--binary", "--no-renames", snapshot, changed]);
			await writeFile(patchPath, patch);
			const counts = await git(tree, ["diff", "--numstat", "--no-renames", snapshot, changed]);
			let insertions = 0;
			let deletions = 0;
			const files: string[] = [];
			for (const line of counts.split("\n")) {
				const [added, deleted, ...path] = line.split("\t");
				if (path.length === 0) continue;
				files.push(path.join("\t"));
				insertions += Number(added) || 0;
				deletions += Number(deleted) || 0;
			}
			return { patchPath, files, insertions, deletions };
		},
		async changedSince() {
			const now = await treeOfWorkingTree(top, snapshot, join(dir, "parent-index"));
			if (now === snapshotTree) return [];
			const names = await git(top, ["diff", "--name-only", "--no-renames", snapshot, now]);
			return names.split("\n").filter((name) => name !== "");
		},
		remove() {
			removed ??= git(top, ["worktree", "remove", "--force", tree])
				.catch(() => git(top, ["worktree", "prune"]).catch(() => ""))
				.then(() => rm(dir, { recursive: true, force: true }))
				.then(() => git(top, ["worktree", "prune"]).catch(() => ""))
				.then(() => {});
			return removed;
		},
	};
}
