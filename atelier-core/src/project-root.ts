import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The project a session works in, as rules allowed "in this project" name it: the real path of the git checkout
 * that holds the working directory (the main checkout for a linked worktree, so every worktree of a repository
 * shares its rules), or the working directory itself outside git. It reads the files git leaves, never runs git,
 * whose configuration the repository could set.
 */
export async function projectRoot(cwd: string): Promise<string> {
	const start = await realpath(cwd);
	for (let dir = start; ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		const info = await stat(dotGit).catch(() => undefined);
		if (info?.isDirectory()) return dir;
		if (info?.isFile()) return (await mainCheckout(dir, dotGit)) ?? dir;
		if (dirname(dir) === dir) return start;
	}
}

/**
 * The main checkout of a linked worktree whose `.git` file is `dotGit`; undefined for a submodule, for what cannot be
 * read, and for a `.git` file the main checkout does not know: only a git directory in the common directory's
 * `worktrees/` whose `gitdir` points back at this very `.git` file is a linked worktree, so a folder cannot claim
 * another checkout's rules by writing a pointer of its own.
 */
async function mainCheckout(dir: string, dotGit: string): Promise<string | undefined> {
	try {
		const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
		if (pointer === undefined) return undefined;
		const gitDir = await realpath(resolve(dir, pointer));
		// A submodule's git directory has no `commondir`: it is a repository of its own.
		const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
		const commonDir = await realpath(resolve(gitDir, common));
		if (dirname(gitDir) !== join(commonDir, "worktrees")) return undefined;
		const back = (await readFile(join(gitDir, "gitdir"), "utf8")).trim();
		if ((await realpath(resolve(gitDir, back))) !== (await realpath(dotGit))) return undefined;
		// A bare repository is its own git directory; otherwise the checkout is the folder that holds `.git`.
		return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
	} catch {
		return undefined;
	}
}
