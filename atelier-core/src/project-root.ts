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

/** The main checkout of a linked worktree whose `.git` file is `dotGit`; undefined for a submodule or what cannot be read. */
async function mainCheckout(dir: string, dotGit: string): Promise<string | undefined> {
	try {
		const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
		if (pointer === undefined) return undefined;
		const gitDir = resolve(dir, pointer);
		// A submodule's git directory has no `commondir`: it is a repository of its own.
		const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
		const commonDir = await realpath(resolve(gitDir, common));
		// A bare repository is its own git directory; otherwise the checkout is the folder that holds `.git`.
		return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
	} catch {
		return undefined;
	}
}
