import { lstat, readFile, realpath, stat } from "node:fs/promises";
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
		const bare = await isBareRepository(dir);
		if (bare === true) return own(dir);
		// A folder that looks like a bare repository whose config is not read with certainty ends the search: it is
		// its own project, never the checkout around it.
		if (bare === undefined) return own(dir);
		if (dirname(dir) === dir) return own(start);
	}
}

/**
 * Whether `dir` is a bare repository: `false` when it does not look like one (`HEAD`, `objects/`, `refs/`, links
 * followed) or its `config` says with certainty it is not, `true` when the `config` says it is, `undefined` when it
 * looks like one and its `config`, followed through links, is missing or cannot be read with certainty.
 */
async function isBareRepository(dir: string): Promise<boolean | undefined> {
	const kinds = await Promise.all(
		["HEAD", "objects", "refs"].map((name) => stat(join(dir, name)).catch(() => undefined)),
	);
	const [head, objects, refs] = kinds;
	if (!head?.isFile() || !objects?.isDirectory() || !refs?.isDirectory()) return false;
	const text = await readFile(join(dir, "config"), "utf8").catch(() => undefined);
	return text === undefined ? undefined : coreBare(text);
}

/**
 * The value of a config line after its key, as git reads it: quotes delimit text in which `#` and `;` are not comments,
 * spaces outside them at either end are dropped. Undefined for what is not read here: a backslash (an escape or a
 * continued line) or an unclosed quote.
 */
function configValue(text: string): string | undefined {
	let value = "";
	let quoted = false;
	let pending = "";
	for (const char of text) {
		if (char === "\\") return undefined;
		if (char === '"') {
			value += pending;
			pending = "";
			quoted = !quoted;
		} else if (!quoted && (char === "#" || char === ";")) break;
		else if (!quoted && /\s/.test(char)) pending += value === "" ? "" : char;
		else {
			value += pending + char;
			pending = "";
		}
	}
	return quoted ? undefined : value;
}

/** A config boolean as git reads it: `true`, `yes`, `on`, `1`, or `false`, `no`, `off`, `0` and empty; undefined otherwise. */
function booleanOf(value: string): boolean | undefined {
	// `configValue` already dropped the spaces outside quotes; those inside are part of the value, as in git.
	const word = value.toLowerCase();
	if (["true", "yes", "on", "1"].includes(word)) return true;
	if (["false", "no", "off", "0", ""].includes(word)) return false;
	return undefined;
}

/**
 * `core.bare` as git reads a config file: only in the `[core]` section (any case, no subsection), the last one wins,
 * `true`, `yes`, `on`, `1` or a key alone. Undefined when the file is not one this reads with certainty (a backslash
 * anywhere, an unclosed quote, a header or a line that is no section, key or comment, a `bare` that is no boolean).
 */
function coreBare(text: string): boolean | undefined {
	// A backslash anywhere, in a value or a comment, is an escape or a continuation this does not read.
	if (text.includes("\\")) return undefined;
	let inCore = false;
	let bare = false;
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		if (line.startsWith("[")) {
			// `[name]`, `[name.sub]` or `[name "sub"]`; anything else is a header git refuses.
			const section = /^\[([A-Za-z0-9.-]+)(\s+"[^"]*")?\](.*)$/.exec(line);
			if (section === null) return undefined;
			inCore = section[2] === undefined && (section[1] ?? "").toLowerCase() === "core";
			line = (section[3] ?? "").trim();
		}
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(=(.*))?$/.exec(line);
		if (entry === null) return undefined;
		const value = entry[2] === undefined ? "true" : configValue(entry[3] ?? "");
		if (value === undefined) return undefined;
		if (inCore && entry[1]?.toLowerCase() === "bare") {
			const known = booleanOf(value);
			if (known === undefined) return undefined;
			bare = known;
		}
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
