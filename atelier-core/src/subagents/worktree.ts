import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
/** The reason Atelier's worktrees are locked with: only a worktree locked with it is Atelier's to remove. */
const OWN_LOCK = "atelier: background worker";

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

/** What `git add` leaves as it is in the base: every `node_modules` folder or file, ignored or not, at any depth. */
const NOT_DEPENDENCIES = ["--", ".", ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**"];

/**
 * The tree of `top`'s working tree as it is now, tracked and untracked files but not ignored ones, written with an
 * index of its own (`index`), so the user's index, branches and stash are never touched. Whatever is under a
 * `node_modules` stays as it is in `base`: the dependencies are never part of a snapshot or a patch; so do the `kept`
 * paths.
 */
async function treeOfWorkingTree(
	top: string,
	base: string,
	index: string,
	kept: readonly string[] = [],
): Promise<string> {
	const options = { env: { GIT_INDEX_FILE: index }, overrides: await filterOverrides(top) };
	await git(top, ["read-tree", base], options);
	await git(top, ["add", "-A", ...NOT_DEPENDENCIES, ...kept.map((path) => `:(exclude,literal)${path}`)], options);
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
	// The dependencies first, beside the worktree, with all their links lead to: a copy that fails or a link refused
	// leaves nothing of the snapshot in the repository.
	const stage = join(dir, "stage");
	let dependencies: Dependencies;
	try {
		dependencies = await stageDependencies(top, tree, stage, await dependencyFolders(top), clone);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	let headTree: string;
	let snapshotTree: string;
	let snapshot: string;
	let place: string;
	let relinked = new Map<string, string>();
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
		// Locked with Atelier's reason: what tells it from the user's own worktrees, and keeps a prune of theirs off it.
		await git(top, ["worktree", "add", "--no-checkout", "--detach", "--lock", "--reason", OWN_LOCK, tree, snapshot]);
		await git(tree, ["reset", "-q", "--hard"], { overrides: await filterOverrides(tree) });
		await mergeInto(stage, tree);
		relinked = await relinkIntoWorktree(top, tree);
		place = join(tree, relative(top, await realpath(cwd)));
		await mkdir(place, { recursive: true });
	} catch (error) {
		await git(top, ["worktree", "remove", "--force", "--force", tree]).catch(() => "");
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	let removed: Promise<void> | undefined;
	// A link Atelier made lead into the worktree is as the snapshot has it, unless the worker changed it since.
	const stillRelinked = async () => {
		const kept: string[] = [];
		for (const [path, target] of relinked)
			if ((await readlink(join(tree, path)).catch(() => undefined)) === target) kept.push(path);
		return kept;
	};
	return {
		top,
		cwd: place,
		head: head.slice(0, 7),
		dirty: snapshotTree !== headTree,
		dependencies,
		async collect(patchPath) {
			const changed = await treeOfWorkingTree(tree, snapshot, index, await stillRelinked());
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
			removed ??= git(top, ["worktree", "remove", "--force", "--force", tree])
				.catch(() => "")
				.then(() => rm(dir, { recursive: true, force: true }));
			return removed;
		},
	};
}

/**
 * Forgets the worktrees Atelier made that a crash left: locked with its reason, their folder gone; one by one. A
 * worktree of the user's is never touched, whatever its path or state.
 */
async function forgetStaleWorktrees(top: string): Promise<void> {
	const listed = await git(top, ["worktree", "list", "--porcelain"]).catch(() => "");
	for (const entry of listed.split("\n\n")) {
		const path = entry.match(/^worktree (.+)$/m)?.[1];
		if (path === undefined || entry.match(/^locked (.*)$/m)?.[1] !== OWN_LOCK) continue;
		if (
			await lstat(path).then(
				() => true,
				() => false,
			)
		)
			continue;
		await git(top, ["worktree", "remove", "--force", "--force", path]).catch(() => "");
	}
}

/**
 * Every `node_modules` of the checkout that is not tracked, folder or link, ignored or not, also inside a folder that is
 * not tracked as a whole: what the snapshot leaves out and the worker needs. From the top; none inside another.
 */
async function dependencyFolders(top: string): Promise<string[]> {
	const untracked = ["ls-files", "--others", "--exclude-standard", "--directory", "-z"];
	const entries = [
		...(await git(top, [...untracked, "--ignored"])).split("\0"),
		...(await git(top, untracked)).split("\0"),
	].filter((entry) => entry !== "");
	const found = new Set<string>();
	for (const entry of entries) {
		const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
		if (basename(path) === "node_modules") found.add(path);
		else if (entry.endsWith("/"))
			for (const nested of await nestedDependencyFolders(join(top, path))) found.add(join(path, nested));
	}
	return [...found].sort();
}

/** The `node_modules` folders or links inside `dir`, as paths from it, without going into links or into one found. */
async function nestedDependencyFolders(dir: string): Promise<string[]> {
	const found: string[] = [];
	const pending = [""];
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const entries = await readdir(join(dir, at), { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = at === "" ? entry.name : join(at, entry.name);
			if (entry.name === "node_modules" && (entry.isDirectory() || entry.isSymbolicLink())) found.push(path);
			else if (entry.isDirectory() && entry.name !== ".git") pending.push(path);
		}
	}
	return found;
}

/** Whether `path` is `top` or inside it. */
function within(top: string, path: string): boolean {
	return path === top || path.startsWith(`${top}${sep}`);
}

/**
 * Makes every link in the worktree that leads into the parent's tree lead to the same place in the worktree instead,
 * so nothing the worker reads or writes through one is the parent's (pnpm links its packages by absolute paths).
 * Answers the links it changed outside the dependencies, as paths from the top, with their new target.
 */
async function relinkIntoWorktree(top: string, tree: string): Promise<Map<string, string>> {
	const changed = new Map<string, string>();
	const pending = [""];
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const entries = await readdir(join(tree, at), { withFileTypes: true });
		for (const entry of entries) {
			const path = at === "" ? entry.name : join(at, entry.name);
			if (at === "" && entry.name === ".git") continue;
			// The dependencies' links were settled before they came in.
			if (entry.name === "node_modules") continue;
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isSymbolicLink()) continue;
			const link = join(tree, path);
			const target = await readlink(link);
			const resolved = resolve(dirname(link), target);
			const real = await realpath(resolved).catch(() => resolved);
			const inParent = within(top, real) ? real : within(top, resolved) ? resolved : undefined;
			if (inParent === undefined) continue;
			const local = join(tree, relative(top, inParent));
			await rm(link, { force: true });
			await symlink(local, link);
			if (!/(^|\/)node_modules(\/|$)/.test(path)) changed.set(path, local);
		}
	}
	return changed;
}

/** Copies `from` to `to` sharing its blocks (APFS clones, reflinks); false where the file system cannot. */
async function cloneFolder(from: string, to: string): Promise<boolean> {
	const args =
		process.platform === "darwin"
			? ["-c", "-R", "-H", from, to]
			: process.platform === "linux"
				? ["-R", "-H", "--reflink=always", from, to]
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

/**
 * Copies the parent's dependency folders into `stage`, laid out as they will be in `tree`, as the worker's own, so it
 * can run its tests and nothing it writes there reaches the parent's: each cloned, or copied where the file system
 * cannot clone. Then makes every link in them lead inside the worktree (`settleLinks`). Anything that cannot be copied,
 * or a link that is refused, fails the whole worktree: the worker would not have what it needs.
 */
async function stageDependencies(
	top: string,
	tree: string,
	stage: string,
	folders: readonly string[],
	clone: boolean,
): Promise<Dependencies> {
	let dependencies: Dependencies = "none";
	// -H: a link given to copy is copied as what it leads to.
	const copy = async (from: string, path: string) => {
		const to = join(stage, path);
		await mkdir(dirname(to), { recursive: true });
		if (clone && (await cloneFolder(from, to))) {
			if (dependencies === "none") dependencies = "cloned";
			return;
		}
		try {
			await execFileAsync("cp", ["-R", "-H", from, to]);
		} catch (error) {
			throw new Error(`could not copy ${path} into the worker's worktree: ${(error as Error).message}`);
		}
		dependencies = "copied";
	};
	await mkdir(stage, { recursive: true });
	for (const folder of folders) await copy(join(top, folder), folder);
	await settleLinks(top, tree, stage, folders, copy);
	return dependencies;
}

/**
 * Makes every link in the staged dependencies lead inside the worktree, so nothing the worker reads or writes through
 * one is the parent's: a link into the parent's tree (pnpm links its packages by absolute paths) leads to the same
 * place in the worktree, and what it leads to is copied there when the worktree would not have it (an ignored store);
 * a link out of both trees is replaced by a copy of what it leads to, whose links are settled too. A link to the
 * repository's git directory, or to a folder that holds the parent's tree or the worktree, is refused.
 */
async function settleLinks(
	top: string,
	tree: string,
	stage: string,
	roots: readonly string[],
	copy: (from: string, path: string) => Promise<void>,
): Promise<void> {
	const gitDirs = await Promise.all(
		["--git-common-dir", "--absolute-git-dir"].map(async (flag) =>
			realpath(resolve(top, (await git(top, ["rev-parse", flag])).trim())),
		),
	);
	const staged = (path: string) =>
		lstat(join(stage, path)).then(
			() => true,
			() => false,
		);
	// Each copy with the real folder it came from: its links are resolved where they were, not where the copy is.
	const copied = async (path: string, from: string) => ({ path, origin: await realpath(from).catch(() => from) });
	const pending = await Promise.all(roots.map((root) => copied(root, join(top, root))));
	// What the worktree needs at `path` (from its top): already staged, in the snapshot, else copied from the parent's.
	const need = async (path: string) => {
		if (await staged(path)) return;
		const from = join(top, path);
		if (
			!(await lstat(from).then(
				() => true,
				() => false,
			))
		)
			return;
		const inSnapshot =
			!/(^|\/)node_modules(\/|$)/.test(path) &&
			(await git(top, ["check-ignore", "-q", "--", path]).then(
				() => false,
				() => true,
			));
		if (inSnapshot) return;
		await copy(from, path);
		pending.push(await copied(path, from));
	};
	const seen = new Set<string>();
	for (let root = pending.pop(); root !== undefined; root = pending.pop()) {
		if (seen.has(root.path)) continue;
		seen.add(root.path);
		const walk = [root.path];
		for (let path = walk.pop(); path !== undefined; path = walk.pop()) {
			const at = join(stage, path);
			const stat = await lstat(at);
			if (stat.isDirectory()) {
				for (const name of await readdir(at)) walk.push(join(path, name));
				continue;
			}
			if (!stat.isSymbolicLink()) continue;
			const target = await readlink(at);
			const lexical = resolve(dirname(join(root.origin, relative(root.path, path))), target);
			const real = await realpath(lexical).catch(() => lexical);
			if (gitDirs.some((gitDir) => within(gitDir, real)))
				throw new Error(`${path} leads to ${real}, inside the repository's git directory`);
			if (within(real, top) || within(real, tree))
				throw new Error(`${path} leads to ${real}, which holds the repository or the worker's worktree`);
			// Where what it leads to is in the worktree: the parent's tree there, or this same copy; else its own copy.
			let local: string;
			if (within(top, real)) {
				local = relative(top, real);
				await need(local);
			} else if (within(root.origin, real)) local = join(root.path, relative(root.origin, real));
			else {
				await rm(at, { force: true });
				await copy(real, path);
				pending.push(await copied(path, real));
				continue;
			}
			// A link that already leads there from its new place (most of pnpm's relative links) is left as it is.
			if (resolve(dirname(join(tree, path)), target) === join(tree, local)) continue;
			await rm(at, { force: true });
			await symlink(join(tree, local), at);
		}
	}
}

/** Moves what `from` holds into `to`, folder by folder; where the worktree already has a file, the worktree's stays. */
async function mergeInto(from: string, to: string): Promise<void> {
	for (const name of await readdir(from)) {
		const source = join(from, name);
		const target = join(to, name);
		const there = await lstat(target).catch(() => undefined);
		if (there === undefined) await rename(source, target);
		else if (there.isDirectory() && (await lstat(source)).isDirectory()) await mergeInto(source, target);
	}
}
