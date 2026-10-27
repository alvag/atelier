import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { isProtected, protectedReadPaths } from "./tools/paths.ts";
import { secretDirectories } from "./tools/sandbox-paths.ts";

/** A skill as the system prompt lists it: the agent reads `path` when a task matches `description`. */
export interface Skill {
	name: string;
	description: string;
	/** Absolute path of its SKILL.md. */
	path: string;
}

export interface SkillWarning {
	/** The SKILL.md the warning is about. */
	path: string;
	message: string;
}

export interface Skills {
	/** In the order they were found: the closest project folder first, the user's last. */
	skills: Skill[];
	warnings: SkillWarning[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/**
 * Folders from `cwd` up to the repository root, the closest first: the first one
 * with a `.git` (a folder, or a file in a worktree). Outside a repository, `cwd` alone.
 */
async function projectFolders(cwd: string): Promise<string[]> {
	const found: string[] = [];
	let dir = resolve(cwd);
	while (true) {
		found.push(dir);
		if (
			await stat(join(dir, ".git")).then(
				() => true,
				() => false,
			)
		)
			return found;
		const parent = dirname(dir);
		if (parent === dir) return [resolve(cwd)];
		dir = parent;
	}
}

/** The SKILL.md of each folder directly inside `dir`, by name; hidden folders are skipped, a missing `dir` has none. */
async function skillFiles(dir: string): Promise<string[]> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const files: string[] = [];
	for (const name of names.filter((entry) => !entry.startsWith(".")).sort()) {
		const file = join(dir, name, "SKILL.md");
		if (
			await stat(file).then(
				(info) => info.isFile(),
				() => false,
			)
		)
			files.push(file);
	}
	return files;
}

/** The frontmatter between the opening and closing `---` lines, parsed; throws with the reason when it cannot be read. */
function frontmatter(text: string): Record<string, unknown> {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trimEnd() !== "---") return {};
	const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (end === -1) throw new Error("no closing ---");
	const data: unknown = parse(lines.slice(1, end).join("\n"));
	if (data === null || data === undefined) return {};
	if (typeof data !== "object" || Array.isArray(data)) throw new Error("it is not a mapping");
	return data as Record<string, unknown>;
}

/** The skill in `file`, or why it is not loaded; `warnings` gets what is wrong but does not stop it. */
async function readSkill(
	file: string,
	protectedPaths: readonly string[],
	warnings: SkillWarning[],
): Promise<Skill | undefined> {
	const warn = (message: string) => warnings.push({ path: file, message });
	if (isProtected(file, protectedPaths) || isProtected(await realpath(file).catch(() => file), protectedPaths)) {
		warn("it is in a protected location the agent cannot read; not loaded");
		return undefined;
	}
	let data: Record<string, unknown>;
	try {
		data = frontmatter(await readFile(file, "utf8"));
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
		warn(`invalid frontmatter: ${reason}; not loaded`);
		return undefined;
	}
	const description = typeof data.description === "string" ? data.description.trim() : "";
	if (description === "") {
		warn("no description; not loaded");
		return undefined;
	}
	const name =
		typeof data.name === "string" && data.name.trim() !== ""
			? data.name.trim()
			: (dirname(file).split(/[/\\]/).pop() ?? "");
	if (name.length > MAX_NAME || !NAME.test(name))
		warn(`name "${name}" should be lowercase letters, digits and hyphens, at most ${MAX_NAME}`);
	if (description.length > MAX_DESCRIPTION) warn(`description is longer than ${MAX_DESCRIPTION} characters`);
	return { name, description, path: file };
}

/**
 * Finds the skills in `.agents/skills/` from `cwd` up to the repository root, then in the user's
 * `home`/.agents/skills/, once. A skill is a folder with a SKILL.md whose frontmatter has a description;
 * of two with the same name the first found wins. Skills the agent's `read` could not open are left out.
 */
export async function loadSkills(cwd: string, home: string): Promise<Skills> {
	// The same places `read` refuses; with an invalid sandbox file, at least the secret directories.
	const protectedPaths = await protectedReadPaths(cwd, home).catch(() =>
		Promise.all(secretDirectories(home).map((dir) => realpath(dir).catch(() => dir))),
	);
	const folders = [...(await projectFolders(cwd)), resolve(home)].map((dir) => join(dir, ".agents", "skills"));
	const skills: Skill[] = [];
	const warnings: SkillWarning[] = [];
	const byName = new Map<string, Skill>();
	for (const folder of [...new Set(folders)]) {
		for (const file of await skillFiles(folder)) {
			const skill = await readSkill(file, protectedPaths, warnings);
			if (skill === undefined) continue;
			const first = byName.get(skill.name);
			if (first !== undefined) {
				warnings.push({
					path: file,
					message: `skill "${skill.name}" is already loaded from ${first.path}; this one is ignored`,
				});
				continue;
			}
			byName.set(skill.name, skill);
			skills.push(skill);
		}
	}
	return { skills, warnings };
}
