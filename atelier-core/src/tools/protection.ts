import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { danglingLink, foldPath, isInsideFolded, linkTargets, realpathAllowMissing } from "./paths.ts";
import { gitProtectedPaths, operationStatePaths } from "./sandbox.ts";
import { loadSandboxAdditions } from "./sandbox-config.ts";
import { libraryProtectedPaths } from "./sandbox-paths.ts";

/** The real path of a place, or the place itself when something on the way cannot be resolved. */
const realOrSelf = (path: string) => realpathAllowMissing(path).catch(() => path);

/** Whether `path` is `place` or inside it, as named (`lexical`) or as it is on disk (`real`), however the name got there. */
async function isUnder(place: string, lexical: string, real: string): Promise<boolean> {
	// A place that is a link to a folder that does not exist yet is still where that name will be created.
	const places = [place, await realOrSelf(place), ...(await linkTargets(place))];
	return places.some((candidate) => isInsideFolded(candidate, lexical) || isInsideFolded(candidate, real));
}

/** The segments of `path` below `root`, folded, or undefined when it is not below it. */
function firstSegments(root: string, path: string): string[] | undefined {
	const segments = relative(foldPath(root), foldPath(path)).split(sep);
	return segments[0] === ".." || segments[0] === "" ? undefined : segments;
}

/** Under odd/tasks/ in any letter case, as named or on disk, also when odd/tasks is a link to somewhere else. */
async function isFeatureDocument(cwd: string, lexical: string, real: string): Promise<boolean> {
	const root = await realOrSelf(cwd);
	for (const [base, path] of [
		[cwd, lexical],
		[root, real],
	] as const) {
		const segments = firstSegments(base, path);
		if (segments !== undefined && segments[0] === "odd" && segments[1] === "tasks" && segments.length > 2) return true;
	}
	return isUnder(join(cwd, "odd", "tasks"), lexical, real);
}

/** Under the project's `.atelier`, as named or on disk, also when `.atelier` is a link to another folder. */
async function isProjectConfig(cwd: string, lexical: string, real: string): Promise<boolean> {
	const root = await realOrSelf(cwd);
	for (const [base, path] of [
		[cwd, lexical],
		[root, real],
	] as const)
		if (firstSegments(base, path)?.[0] === ".atelier") return true;
	return isUnder(join(cwd, ".atelier"), lexical, real);
}

/**
 * The git files the agent's `bash` sandbox denies because git runs code from
 * them: hooks and configuration, the pending steps of a rebase or a
 * cherry-pick, and what git reports for the working directory's repository
 * (the effective hooks directory, the configuration of the git directories,
 * the `.git` file of a linked worktree), wherever the git directory is. Built
 * from the sandbox's own lists.
 */
function gitExecutionPaths(cwd: string, home: string): string[] {
	const directories = [cwd, ...loadSandboxAdditions({ cwd, home }).allowWrite];
	return [
		...directories
			.flatMap(libraryProtectedPaths)
			.filter((path) => basename(path).startsWith(".git") || basename(dirname(path)) === ".git"),
		...directories.flatMap((dir) => operationStatePaths(join(dir, ".git"))),
		...gitProtectedPaths(cwd),
	];
}

async function isGitState(cwd: string, home: string, lexical: string, real: string): Promise<boolean> {
	for (const place of gitExecutionPaths(cwd, home)) if (await isUnder(place, lexical, real)) return true;
	return false;
}

/**
 * Why `edit` and `write` never touch the file, approved or not; undefined when
 * they may. `real` is the file as it is on disk. Compares real paths as well
 * as names, so a link or a move cannot give the file another name.
 */
export async function projectRefusal(
	tool: "edit" | "write",
	cwd: string,
	path: string,
	real: string,
	home: string = homedir(),
): Promise<string | undefined> {
	const lexical = resolve(cwd, path);
	// A link to nothing is not followed: where a write would land cannot be told, so it is not written.
	if ((await danglingLink(lexical)) !== undefined)
		return `Not ${tool === "edit" ? "edited" : "written"}: ${path} is a symbolic link to a missing file.`;
	// Feature documents change only through the feature tool, which keeps them well formed.
	if (await isFeatureDocument(cwd, lexical, real))
		return `${path} is a feature document: change it with the feature tool, not ${tool}.`;
	if (await isProjectConfig(cwd, lexical, real))
		return `${path} is project configuration: the agent does not write .atelier/.`;
	if (await isGitState(cwd, home, lexical, real))
		return `${path} is git state that runs code: the agent does not write it.`;
	return undefined;
}

const approved = new Map<string, string>();

/** Remembers the real path the user is asked about for this call; `undefined` when the call needs no question. */
export function rememberApproval(callId: string | undefined, real: string | undefined): void {
	if (callId === undefined) return;
	if (real === undefined) approved.delete(callId);
	else approved.set(callId, real);
}

/**
 * The real path the user approved for this call when it differs from `real`;
 * undefined when the call needed no question or the path is the same. Forgets the call.
 */
export function approvalMismatch(callId: string | undefined, real: string): string | undefined {
	if (callId === undefined) return undefined;
	const asked = approved.get(callId);
	approved.delete(callId);
	return asked !== undefined && asked !== real ? asked : undefined;
}
