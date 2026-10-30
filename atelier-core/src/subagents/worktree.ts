import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, link, lstat, mkdir, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { systemTmpdir } from "../scratch.ts";

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
/** Where Atelier makes a worker's worktree, from the scratch directories' folder: `<session>/work/worktrees/<n>/tree`. */
const OWN_WORKTREE = /^atelier-session-[^/]+\/work\/worktrees\/\d+\/tree$/;

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
 * How a worker got the parent's dependencies (each `node_modules` the checkout does not track): `linked`, links to the
 * parent's, which it reads and, confined to its worktree, never writes; `none`, there were none.
 */
export type Dependencies = "linked" | "none";

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
	/**
	 * Puts the snapshot's objects in the repository, so git works in the worktree, once its task started: until then
	 * they are only in the worktree's own object folder, which goes with it.
	 */
	adopt(): Promise<void>;
	/** Writes the patch of what changed to `patchPath`, the dependency folders left out; undefined when nothing changed. */
	collect(patchPath: string): Promise<WorktreeChanges | undefined>;
	/** The files of the parent's tree that differ from the snapshot now: what the parent changed since. */
	changedSince(): Promise<string[]>;
	/** Removes the worktree and what git keeps of it; whatever fails, the folder goes. */
	remove(): Promise<void>;
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
 * `node_modules` stays as it is in `base`: the dependencies are never part of a snapshot or a patch.
 */
async function treeOfWorkingTree(
	top: string,
	base: string,
	index: string,
	objects: Record<string, string>,
): Promise<string> {
	const options = { env: { ...objects, GIT_INDEX_FILE: index }, overrides: await filterOverrides(top) };
	await git(top, ["read-tree", base], options);
	await git(top, ["add", "-A", ...NOT_DEPENDENCIES], options);
	return (await git(top, ["write-tree"], options)).trim();
}

/** The two trees' difference as `git diff` gives it, with nothing of the repository's own diff programs. */
async function diffTrees(
	cwd: string,
	from: string,
	to: string,
	format: readonly string[],
	objects: Record<string, string>,
): Promise<string> {
	return git(cwd, ["diff", "--no-textconv", "--no-ext-diff", "--no-renames", ...format, from, to], { env: objects });
}

/**
 * `path` as one entry of GIT_ALTERNATE_OBJECT_DIRECTORIES: C-quoted, as git reads an entry that starts with a quote,
 * so a colon (the list's separator) or any other character is part of the path.
 */
function alternateEntry(path: string): string {
	const escaped = path
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");
	return `"${escaped}"`;
}

/**
 * Copies the loose objects of `from` that `to` lacks, published as git publishes its own: each written whole to a
 * temporary file beside it (`tmp_obj_`, which git's own cleanup takes) and then hard-linked to its name, which fails
 * when the object is already there. So no reader, another worker's launch included, ever sees part of one.
 */
async function copyObjects(from: string, to: string): Promise<void> {
	for (const folder of await readdir(from).catch((): string[] => [])) {
		if (!/^[0-9a-f]{2}$/.test(folder)) continue;
		await mkdir(join(to, folder), { recursive: true });
		for (const name of await readdir(join(from, folder))) {
			const temporary = join(to, folder, `tmp_obj_atelier_${randomBytes(6).toString("hex")}`);
			await copyFile(join(from, folder, name), temporary);
			try {
				await link(temporary, join(to, folder, name)).catch(async (error) => {
					// Where hard links are not allowed, a rename publishes it as whole, as git does.
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rename(temporary, join(to, folder, name));
				});
			} finally {
				await rm(temporary, { force: true });
			}
		}
	}
}

/**
 * Makes a worktree in `dir` of `cwd`'s repository, detached at a snapshot of its working tree: HEAD plus the changes
 * not committed yet, with links to the parent's dependencies. Throws WorktreeRefusedError when `cwd` is not in a
 * repository with a commit, and any other error when the worktree could not be made.
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
	// The dependencies are found first: a listing that fails leaves nothing of the snapshot in the repository.
	let folders: string[];
	try {
		folders = await dependencyFolders(top);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	let headTree: string;
	let snapshotTree: string;
	let snapshot: string;
	let place: string;
	// What git writes for the snapshot and the patches goes to an object folder of its own, the repository's read
	// through it: a launch refused or stopped before its task starts leaves nothing in the repository (`adopt`).
	const own = join(dir, "objects");
	let objects: Record<string, string>;
	let shared: string;
	try {
		const common = resolve(top, (await git(top, ["rev-parse", "--git-common-dir"])).trim());
		shared = join(common, "objects");
		objects = { GIT_OBJECT_DIRECTORY: own, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateEntry(shared) };
		await mkdir(own, { recursive: true });
		headTree = (await git(top, ["rev-parse", "HEAD^{tree}"])).trim();
		snapshotTree = await treeOfWorkingTree(top, head, index, objects);
		snapshot = (
			await git(
				top,
				["commit-tree", "--no-gpg-sign", snapshotTree, "-p", head, "-m", "atelier: snapshot for a background worker"],
				{ env: { ...objects, ...SNAPSHOT_IDENTITY } },
			)
		).trim();
		await forgetStaleWorktrees(top);
		// Checked out from inside the worktree, once it exists: its own configuration may name filters (an `includeIf`
		// on its git directory) that the checkout's would not.
		// Locked with Atelier's reason: what tells it from the user's own worktrees, and keeps a prune of theirs off it.
		await git(top, ["worktree", "add", "--no-checkout", "--detach", "--lock", "--reason", OWN_LOCK, tree, snapshot], {
			env: objects,
		});
		await git(tree, ["reset", "-q", "--hard"], { env: objects, overrides: await filterOverrides(tree) });
		await linkDependencies(top, tree, folders);
		place = join(tree, relative(top, await realpath(cwd)));
		await mkdir(place, { recursive: true });
	} catch (error) {
		await git(top, ["worktree", "remove", "--force", "--force", tree]).catch(() => "");
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	let removed: Promise<void> | undefined;
	let adopted: Promise<void> | undefined;
	return {
		top,
		cwd: place,
		head: head.slice(0, 7),
		dirty: snapshotTree !== headTree,
		dependencies: folders.length === 0 ? "none" : "linked",
		adopt() {
			adopted ??= copyObjects(own, shared);
			return adopted;
		},
		async collect(patchPath) {
			const changed = await treeOfWorkingTree(tree, snapshot, index, objects);
			if (changed === snapshotTree) return undefined;
			await writeFile(patchPath, await diffTrees(tree, snapshot, changed, ["--binary"], objects));
			const counts = await diffTrees(tree, snapshot, changed, ["--numstat"], objects);
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
			const now = await treeOfWorkingTree(top, snapshot, join(dir, "parent-index"), objects);
			if (now === snapshotTree) return [];
			const names = await diffTrees(top, snapshot, now, ["--name-only"], objects);
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
 * Forgets the worktrees Atelier made that a crash left, one by one. One is Atelier's only when all of these hold: it is
 * locked with exactly Atelier's reason, and the path git lists for it (`ownStalePath`) is a worktree's place in a
 * session's scratch directory, gone. The listing is read with NUL separators, so no name can pass for a field. A
 * worktree of the user's is never touched, whatever its path, lock or state.
 */
async function forgetStaleWorktrees(top: string): Promise<void> {
	const listed = await git(top, ["worktree", "list", "--porcelain", "-z"]).catch(() => "");
	const roots = [...new Set([systemTmpdir(), await realpath(systemTmpdir()).catch(() => systemTmpdir())])];
	for (const record of listed.split("\0\0")) {
		const fields = record.split("\0");
		const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		if (path === undefined || !fields.includes(`locked ${OWN_LOCK}`) || !(await ownStalePath(path, roots))) continue;
		await git(top, ["worktree", "remove", "--force", "--force", path]).catch(() => "");
	}
}

/**
 * Whether `path`, as written and never through a link, is `<session>/work/worktrees/<n>/tree` under one of the scratch
 * directories' `roots`, and gone: no line break or `..` in it, no part of it below the root a link or anything but a
 * folder, and some part missing. A link anywhere below the root would make it another place than it says.
 */
async function ownStalePath(path: string, roots: readonly string[]): Promise<boolean> {
	if (/[\n\r]/.test(path) || normalize(path) !== path) return false;
	const root = roots.find((candidate) => path.startsWith(`${candidate}${sep}`));
	if (root === undefined) return false;
	const rest = path.slice(root.length + 1);
	if (!OWN_WORKTREE.test(rest)) return false;
	let at = root;
	for (const part of rest.split(sep)) {
		at = join(at, part);
		const stat = await lstat(at).catch(() => undefined);
		if (stat === undefined) return true;
		if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
	}
	return false;
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

/**
 * Gives the worktree the parent's dependencies, for the worker to read and run its tests with, made at once and
 * nothing copied: each `node_modules` is a folder of its own whose entries (those of a scope like `@org` and of `.bin`
 * one by one too) are links to the parent's. An entry that leads to a package of the repository itself, outside any
 * `node_modules` (a workspace package), leads to the same package in the worktree instead, so the worker runs its own
 * change of it. The worker is confined to its worktree, so it never writes through the others.
 */
async function linkDependencies(top: string, tree: string, folders: readonly string[]): Promise<void> {
	const pending = folders.filter((folder) => folder !== "");
	for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
		const into = join(tree, folder);
		if (
			await lstat(into).then(
				() => true,
				() => false,
			)
		)
			continue;
		// A folder that leads nowhere (a dangling link) or cannot be listed is skipped, as the parent has nothing there.
		const from = await realpath(join(top, folder)).catch(() => undefined);
		const entries =
			from === undefined ? undefined : await readdir(from, { withFileTypes: true }).catch(() => undefined);
		if (from === undefined || entries === undefined) continue;
		await mkdir(into, { recursive: true });
		for (const entry of entries) {
			const path = join(folder, entry.name);
			// A scope and `.bin` hold entries of their own that may lead to a workspace package.
			if (entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin")) {
				pending.push(path);
				continue;
			}
			const parentEntry = join(from, entry.name);
			const real = entry.isSymbolicLink() ? await realpath(parentEntry).catch(() => parentEntry) : parentEntry;
			const inRepo = relative(top, real);
			const workspace =
				inRepo !== "" && !inRepo.startsWith("..") && !/(^|\/)node_modules(\/|$)/.test(inRepo) && real !== parentEntry;
			await symlink(workspace ? join(tree, inRepo) : parentEntry, join(tree, path));
		}
	}
}
