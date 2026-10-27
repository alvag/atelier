import { readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const SHORT_COMMIT = 7;

/**
 * The folders the search must not walk up into, from `GIT_CEILING_DIRECTORIES` as git reads it: split on the platform's
 * path list separator, absolute paths only, with their symlinks resolved; one that does not exist is ignored.
 */
async function ceilingDirectories(): Promise<string[]> {
	const listed = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter((path) => isAbsolute(path));
	const real = await Promise.all(listed.map((path) => realpath(path).catch(() => undefined)));
	return real.filter((path) => path !== undefined);
}

/** The git directory of the repository `cwd` is in: `.git` itself, or where a linked worktree's `.git` file points. */
async function gitDirOf(cwd: string): Promise<string | undefined> {
	const ceilings = await ceilingDirectories();
	// Its symlinks resolved too, as the ceilings' are, for the two to compare.
	const start = await realpath(cwd).catch(() => resolve(cwd));
	for (let dir = start; ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		const found = await stat(dotGit).catch(() => undefined);
		if (found?.isDirectory()) return dotGit;
		if (found?.isFile()) {
			const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, "utf8"));
			return pointer?.[1] === undefined ? undefined : resolve(dir, pointer[1].trim());
		}
		if (dirname(dir) === dir || ceilings.includes(dirname(dir))) return undefined;
	}
}

/**
 * The branch of the repository `cwd` is in, read from its `HEAD` without running git: the short commit when `HEAD` is
 * detached, nothing outside a repository or when `HEAD` cannot be read. Like git, it stops below `GIT_CEILING_DIRECTORIES`.
 */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
	try {
		const gitDir = await gitDirOf(cwd);
		if (gitDir === undefined) return undefined;
		const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
		const ref = /^ref: (.+)$/.exec(head)?.[1];
		if (ref !== undefined) return ref.replace(/^refs\/heads\//, "");
		return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, SHORT_COMMIT) : undefined;
	} catch {
		return undefined;
	}
}
