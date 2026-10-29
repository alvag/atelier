import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The project a session works in, as rules allowed "in this project" name it: the real path of the git checkout
 * that holds the working directory (the main checkout for a linked worktree, so every worktree of a repository
 * shares its rules), a bare repository for the folders in it, or the working directory itself outside git. It reads
 * the files git leaves, never runs git, whose configuration the repository could set.
 */
export async function projectRoot(cwd: string): Promise<string> {
	return (await projectOf(cwd)).project;
}

/**
 * The project of `cwd` (`projectRoot`) and the checkout that holds it: the folder the session's commands work in,
 * which for a linked worktree is the worktree itself, not the main checkout its rules are kept for.
 */
export async function projectOf(cwd: string): Promise<{ project: string; checkout: string }> {
	const start = await realpath(cwd);
	const own = (dir: string) => ({ project: dir, checkout: dir });
	for (let dir = start; ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		// A `.git` that is a link is never followed to another checkout: the folder holding it is the project.
		const info = await lstat(dotGit).catch(() => undefined);
		if (info?.isDirectory() || info?.isSymbolicLink()) return own(dir);
		if (info?.isFile()) return { project: (await mainCheckout(dir, dotGit)) ?? dir, checkout: dir };
		if (await isBareRepository(dir)) return own(dir);
		if (dirname(dir) === dir) return own(start);
	}
}

/** Whether `dir` is a bare repository, as its files show: `HEAD`, `objects/`, `refs/` and `core.bare` true in `config`. */
async function isBareRepository(dir: string): Promise<boolean> {
	const kinds = await Promise.all(
		["HEAD", "objects", "refs", "config"].map((name) => lstat(join(dir, name)).catch(() => undefined)),
	);
	const [head, objects, refs, config] = kinds;
	if (!head?.isFile() || !objects?.isDirectory() || !refs?.isDirectory() || !config?.isFile()) return false;
	return coreBare(await readFile(join(dir, "config"), "utf8").catch(() => ""));
}

/**
 * The value of `core.bare` as git reads a config file: only in the `[core]` section (any case, no subsection), the
 * last one wins, a key alone is true, comments (`#`, `;`) and quotes are not part of the value, and a backslash at
 * the end of a line continues it on the next.
 */
function coreBare(text: string): boolean {
	let inCore = false;
	let bare = false;
	for (const raw of text.replace(/\\\r?\n/g, "").split("\n")) {
		let line = raw.trim();
		const section = /^\[([^\]]*)\](.*)$/.exec(line);
		if (section) {
			inCore = (section[1] ?? "").trim().toLowerCase() === "core";
			line = (section[2] ?? "").trim();
		}
		const entry = /^bare\s*(?:=(.*))?$/i.exec(line.replace(/\s*[#;].*$/, ""));
		if (!inCore || entry === null) continue;
		const value = (entry[1] ?? "true").trim().replace(/"/g, "").toLowerCase();
		bare = ["true", "yes", "on", "1"].includes(value);
	}
	return bare;
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
		// `dir` is a real path and `dotGit` a plain file in it: the main checkout must name this very file.
		if ((await realpath(resolve(gitDir, back))) !== dotGit) return undefined;
		// A bare repository is its own git directory; otherwise the checkout is the folder that holds `.git`.
		return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
	} catch {
		return undefined;
	}
}
