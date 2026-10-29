import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LineCounter, parse, YAMLParseError } from "yaml";
import { isProtected, protectedReadPaths } from "./tools/paths.ts";

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

export interface LoadedSkills {
	/** In the order they were found: the closest project folder first, the user's last. */
	skills: Skill[];
	warnings: SkillWarning[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
/**
 * The most the skills block may add to the system prompt, its instructions included: twice a large personal set of
 * about 25 skills.
 */
export const MAX_SKILLS_BYTES = 24 * 1024;

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
	const data = parseYaml(lines.slice(1, end).join("\n"));
	if (data === null || data === undefined) return {};
	if (typeof data !== "object" || Array.isArray(data)) throw new Error("it is not a mapping");
	return data as Record<string, unknown>;
}

/** `text` parsed as YAML; a syntax error throws as `<what> at line 2, column 5`, the line counted within `text`. */
function parseYaml(text: string): unknown {
	const lineCounter = new LineCounter();
	try {
		return parse(text, { prettyErrors: false, lineCounter });
	} catch (error) {
		if (!(error instanceof YAMLParseError)) throw error;
		const { line, col } = lineCounter.linePos(error.pos[0]);
		throw new Error(`${error.message} at line ${line}, column ${col}`);
	}
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
		const reason = error instanceof Error ? error.message : String(error);
		warn(`invalid frontmatter: ${reason}; not loaded`);
		return undefined;
	}
	if (data.description !== undefined && data.description !== null && typeof data.description !== "string") {
		warn("description must be a string; not loaded");
		return undefined;
	}
	const full = typeof data.description === "string" ? data.description.trim() : "";
	if (full === "") {
		warn("no description; not loaded");
		return undefined;
	}
	const name =
		typeof data.name === "string" && data.name.trim() !== ""
			? data.name.trim()
			: (dirname(file).split(/[/\\]/).pop() ?? "");
	if (name.length > MAX_NAME || !NAME.test(name))
		warn(`name "${name}" should be lowercase letters, digits and hyphens, at most ${MAX_NAME}`);
	// Characters, not UTF-16 units, so a cut never splits one.
	const characters = Array.from(full);
	if (characters.length > MAX_DESCRIPTION)
		warn(`description is longer than ${MAX_DESCRIPTION} characters; cut to ${MAX_DESCRIPTION}`);
	return { name, description: characters.slice(0, MAX_DESCRIPTION).join(""), path: file };
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const PROMPT_HEAD = [
	"The following skills provide specialized instructions for specific tasks.",
	"When a task matches a skill's description, read its SKILL.md with the read tool before acting.",
	"Resolve paths relative to a skill against its folder (the folder of its SKILL.md).",
	"",
	"<available_skills>",
].join("\n");
const PROMPT_TAIL = "</available_skills>";

/** One skill's entry in the block. */
function promptEntry({ name, description, path }: Skill): string {
	return `  <skill>\n    <name>${escapeXml(name)}</name>\n    <description>${escapeXml(description)}</description>\n    <location>${escapeXml(path)}</location>\n  </skill>`;
}

/** What the system prompt says about `skills`: how to use them, and each one's name, description and SKILL.md; empty without skills. */
export function skillsPrompt(skills: readonly Skill[]): string {
	if (skills.length === 0) return "";
	return [PROMPT_HEAD, ...skills.map(promptEntry), PROMPT_TAIL].join("\n");
}

/** The first of `skills` whose block fits in MAX_SKILLS_BYTES; each one left out gets a warning. */
function withinCap(skills: readonly Skill[], warnings: SkillWarning[]): Skill[] {
	let size = Buffer.byteLength(PROMPT_HEAD) + 1 + Buffer.byteLength(PROMPT_TAIL);
	const kept: Skill[] = [];
	for (const skill of skills) {
		size += Buffer.byteLength(promptEntry(skill)) + 1;
		if (size > MAX_SKILLS_BYTES)
			warnings.push({
				path: skill.path,
				message: `the skills list is over ${MAX_SKILLS_BYTES / 1024} KiB; not listed`,
			});
		else kept.push(skill);
	}
	return kept;
}

/**
 * Finds the skills in `.agents/skills/` from `cwd` up to the repository root, then in `home`'s, each folder once: a
 * skill is a folder with a SKILL.md whose frontmatter has a description, and of two with the same name the first wins.
 *
 * Left out are the skills the agent's `read` could not open and those past MAX_SKILLS_BYTES; with an invalid sandbox
 * configuration, every skill.
 */
export async function loadSkills(cwd: string, home: string): Promise<LoadedSkills> {
	const folders = [...(await projectFolders(cwd)), resolve(home)].map((dir) => join(dir, ".agents", "skills"));
	const files = (await Promise.all([...new Set(folders)].map((folder) => skillFiles(folder)))).flat();
	if (files.length === 0) return { skills: [], warnings: [] };
	// The same places `read` refuses; without them (an invalid sandbox file) nothing is loaded.
	let protectedPaths: string[];
	try {
		protectedPaths = await protectedReadPaths(cwd, home);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { skills: [], warnings: [{ path: resolve(cwd), message: `no skills loaded: ${reason}` }] };
	}
	const skills: Skill[] = [];
	const warnings: SkillWarning[] = [];
	const byName = new Map<string, Skill>();
	for (const file of files) {
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
	return { skills: withinCap(skills, warnings), warnings };
}
