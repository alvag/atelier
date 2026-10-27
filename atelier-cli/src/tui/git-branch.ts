import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SHORT_COMMIT = 7;

/** The folders the search must not walk up into, from `GIT_CEILING_DIRECTORIES` as git reads it: absolute paths only. */
function ceilingDirectories(): string[] {
	const listed = process.env.GIT_CEILING_DIRECTORIES ?? "";
	return listed
		.split(":")
		.filter((path) => isAbsolute(path))
		.map((path) => resolve(path));
}

/** The git directory of the repository `cwd` is in: `.git` itself, or where a linked worktree's `.git` file points. */
async function gitDirOf(cwd: string): Promise<string | undefined> {
	const ceilings = ceilingDirectories();
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
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
