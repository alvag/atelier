import { execFile } from "node:child_process";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
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
/**
 * What git would otherwise run or write of the repository's own configuration: hooks (`worktree add` runs
 * post-checkout), the file system monitor, submodules, automatic gc and maintenance, and a split index's shared file
 * in the repository's .git. Filters are turned off per driver (`filterOverrides`), and diffs take no textconv or
 * external diff.
 */
const NO_PROGRAMS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.splitIndex=false",
	"-c",
	"submodule.recurse=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
];
/** Where Atelier makes a worker's worktree: `worktrees/<n>/tree` in a session's scratch directory. */
const OWN_WORKTREE = /\/atelier-session-[^/]+\/[^/]+\/worktrees\/\d+\/tree$/;

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

/**
 * How a worker got the parent's dependencies (each ignored `node_modules` folder), always as its own: `cloned`, copies
 * that share their blocks until written; `copied`, plain copies where the file system cannot clone; `none`, there were
 * none.
 */
export type Dependencies = "cloned" | "copied" | "none";

/** A worker's own worktree of the parent's tree as it was when the task started. */
export interface TaskWorktree {
	/** The top of the parent's checkout: where the patch applies. */
	top: string;
	/** The folder in the worktree that stands where the parent's working directory does in the checkout. */
	cwd: string;
	/** HEAD's short id when the snapshot was taken, and whether the snapshot has uncommitted changes on top of it. */
	head: string;
	dirty: boolean;
	dependencies: Dependencies;
	/** Writes the patch of what changed to `patchPath`, the dependency folders left out; undefined when nothing changed. */
	collect(patchPath: string): Promise<WorktreeChanges | undefined>;
	/** The files of the parent's tree that differ from the snapshot now: what the parent changed since. */
	changedSince(): Promise<string[]>;
	/** Removes the worktree and what git keeps of it; whatever fails, the folder goes. */
	remove(): Promise<void>;
}

export interface TaskWorktreeOptions {
	/** Whether to try a copy-on-write clone of the dependencies before a plain copy; true unless a test says. */
	clone?: boolean;
}

/** Runs git with none of the repository's programs: `overrides` turns its filter drivers off. */
async function git(
	cwd: string,
	args: readonly string[],
	{ env = {}, overrides = [] }: { env?: Record<string, string>; overrides?: readonly string[] } = {},
): Promise<string> {
	const { stdout } = await execFileAsync("git", [...NO_PROGRAMS, ...overrides, ...args], {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
		maxBuffer: MAX_PATCH_BYTES,
	});
	return stdout;
}

/**
 * Every filter driver git's configuration names (`filter.<driver>.*`, from any scope), turned off: no clean, smudge or
 * process command, and not required. A file whose attributes name one is taken as it is on disk.
 */
async function filterOverrides(cwd: string): Promise<string[]> {
	// Exit 1 when no key matches: no driver to turn off.
	const keys = await git(cwd, ["config", "--name-only", "--get-regexp", "^filter\\."]).catch(() => "");
	const drivers = new Set(
		keys
			.split("\n")
			.filter((key) => key.lastIndexOf(".") > "filter".length)
			.map((key) => key.slice("filter.".length, key.lastIndexOf("."))),
	);
	return [...drivers].flatMap((driver) =>
		["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.${driver}.${setting}`]),
	);
}

/**
 * The tree of `top`'s working tree as it is now, tracked and untracked files but not ignored ones nor the `excluded`
 * folders, written with an index of its own (`index`), so the user's index, branches and stash are never touched.
 */
async function treeOfWorkingTree(
	top: string,
	base: string,
	index: string,
	excluded: readonly string[] = [],
): Promise<string> {
	const options = { env: { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" }, overrides: await filterOverrides(top) };
	await git(top, ["read-tree", base], options);
	await git(top, ["add", "-A"], options);
	if (excluded.length > 0)
		await git(top, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...excluded], options);
	return (await git(top, ["write-tree"], options)).trim();
}

/** The two trees' difference as `git diff` gives it, with nothing of the repository's own diff programs. */
async function diffTrees(cwd: string, from: string, to: string, format: readonly string[]): Promise<string> {
	return git(cwd, ["diff", "--no-textconv", "--no-ext-diff", "--no-renames", ...format, from, to]);
}

/**
 * Makes a worktree in `dir` of `cwd`'s repository, detached at a snapshot of its working tree: HEAD plus the changes
 * not committed yet, with the parent's dependencies as its own. Throws WorktreeRefusedError when `cwd` is not in a
 * repository with a commit, and any other error when the worktree or its dependencies could not be made.
 */
export async function createTaskWorktree(
	cwd: string,
	dir: string,
	{ clone = true }: TaskWorktreeOptions = {},
): Promise<TaskWorktree> {
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
	// The dependencies first, beside the worktree: a copy that fails leaves nothing of the snapshot in the repository.
	let folders: string[];
	let copies: CopiedDependencies;
	try {
		folders = await dependencyFolders(top);
		copies = await copyDependencies(top, join(dir, "dependencies"), folders, clone);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
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
				["commit-tree", "--no-gpg-sign", snapshotTree, "-p", head, "-m", "atelier: snapshot for a background worker"],
				{ env: SNAPSHOT_IDENTITY },
			)
		).trim();
		await forgetStaleWorktrees(top);
		// Checked out from inside the worktree, once it exists: its own configuration may name filters (an `includeIf`
		// on its git directory) that the checkout's would not.
		await git(top, ["worktree", "add", "--no-checkout", "--detach", tree, snapshot]);
		await git(tree, ["reset", "-q", "--hard"], { overrides: await filterOverrides(tree) });
		await placeDependencies(tree, copies.staged);
		place = join(tree, relative(top, await realpath(cwd)));
		await mkdir(place, { recursive: true });
	} catch (error) {
		await git(top, ["worktree", "remove", "--force", tree]).catch(() => "");
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	let removed: Promise<void> | undefined;
	return {
		top,
		cwd: place,
		head: head.slice(0, 7),
		dirty: snapshotTree !== headTree,
		dependencies: copies.dependencies,
		async collect(patchPath) {
			// The dependencies are never part of the patch, whatever the worker made of them (a link is not ignored as a folder is).
			const changed = await treeOfWorkingTree(tree, snapshot, index, folders);
			if (changed === snapshotTree) return undefined;
			await writeFile(patchPath, await diffTrees(tree, snapshot, changed, ["--binary"]));
			const counts = await diffTrees(tree, snapshot, changed, ["--numstat"]);
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
			const names = await diffTrees(top, snapshot, now, ["--name-only"]);
			return names.split("\n").filter((name) => name !== "");
		},
		remove() {
			// Only this worktree: never a prune, which would forget the user's own worktrees whose folder is gone.
			removed ??= git(top, ["worktree", "remove", "--force", tree])
				.catch(() => "")
				.then(() => rm(dir, { recursive: true, force: true }));
			return removed;
		},
	};
}

/**
 * Forgets the worktrees Atelier made that a crash left (their folder gone): those in a session's scratch directory,
 * one by one. A worktree of the user's is never touched, whatever its state.
 */
async function forgetStaleWorktrees(top: string): Promise<void> {
	const listed = await git(top, ["worktree", "list", "--porcelain"]).catch(() => "");
	for (const entry of listed.split("\n\n")) {
		const path = entry.match(/^worktree (.+)$/m)?.[1];
		if (path === undefined || !OWN_WORKTREE.test(path) || !/^prunable/m.test(entry)) continue;
		await git(top, ["worktree", "remove", "--force", path]).catch(() => "");
	}
}

/** The folders of the checkout git ignores that are named `node_modules`, from the top; none nested in another. */
async function dependencyFolders(top: string): Promise<string[]> {
	const listed = await git(top, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
	return listed
		.split("\0")
		.filter((entry) => entry.endsWith("/") && basename(entry.slice(0, -1)) === "node_modules")
		.map((entry) => entry.slice(0, -1));
}

/** Copies `from` to `to` sharing its blocks (APFS clones, reflinks); false where the file system cannot. */
async function cloneFolder(from: string, to: string): Promise<boolean> {
	const args =
		process.platform === "darwin"
			? ["-c", "-R", from, to]
			: process.platform === "linux"
				? ["-R", "--reflink=always", from, to]
				: undefined;
	if (args === undefined) return false;
	try {
		await execFileAsync("cp", args);
		return true;
	} catch {
		await rm(to, { recursive: true, force: true });
		return false;
	}
}

/** The parent's dependency folders copied beside the worktree, waiting to be put in it. */
interface CopiedDependencies {
	dependencies: Dependencies;
	staged: { folder: string; path: string }[];
}

/**
 * Copies the parent's dependencies into `staging`, as the worker's own, so it can run its tests and nothing it writes
 * there reaches the parent's: each folder cloned, or copied where the file system cannot clone (the links inside are
 * copied as links). A folder that cannot be copied fails the whole worktree: the worker would not have what it needs.
 */
async function copyDependencies(
	top: string,
	staging: string,
	folders: readonly string[],
	clone: boolean,
): Promise<CopiedDependencies> {
	let dependencies: Dependencies = "none";
	const staged: CopiedDependencies["staged"] = [];
	await mkdir(staging, { recursive: true });
	for (const [index, folder] of folders.entries()) {
		const from = join(top, folder);
		const path = join(staging, String(index));
		staged.push({ folder, path });
		if (clone && (await cloneFolder(from, path))) {
			if (dependencies === "none") dependencies = "cloned";
			continue;
		}
		try {
			await execFileAsync("cp", ["-R", from, path]);
		} catch (error) {
			throw new Error(`could not copy ${folder} into the worker's worktree: ${(error as Error).message}`);
		}
		dependencies = "copied";
	}
	return { dependencies, staged };
}

/** Moves the copied dependencies to their places in the worktree, in place of whatever the checkout put there. */
async function placeDependencies(tree: string, staged: CopiedDependencies["staged"]): Promise<void> {
	for (const { folder, path } of staged) {
		const to = join(tree, folder);
		await rm(to, { recursive: true, force: true });
		await mkdir(dirname(to), { recursive: true });
		await rename(path, to);
	}
}
