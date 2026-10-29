import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { projectRoot } from "./project-root.ts";
import { commandRuleScope } from "./tools/command-rules.ts";
import { isInside } from "./tools/paths.ts";

/**
 * What the user allowed for good or for this session, so the same question is
 * not asked again: a `bash` rule (`open`, `npm install`) or a folder `edit`
 * and `write` may write in. Session rules live in memory; the ones allowed
 * always are in `~/.atelier/permissions.json`, the user's own file, never the
 * repository's, so a repository cannot give itself permissions. A `bash` rule for
 * a command that runs code the repository defines is allowed always only in a
 * project, kept in `~/.atelier/project-permissions.json` with the project's real
 * path, so a freshly cloned repository's scripts never run on a rule allowed
 * elsewhere. A separate file, so an Atelier that does not know project rules keeps
 * reading `permissions.json` as it is.
 */

const KIND = "atelier.permissions";
const PROJECT_KIND = "atelier.project-permissions";
const VERSION = 1;

export type PermissionRuleKind = "bash" | "path";
export type PermissionRuleScope = "session" | "project" | "always";

export interface PermissionRule {
	kind: PermissionRuleKind;
	value: string;
}

export interface ListedPermissionRule extends PermissionRule {
	/** Names the rule for `remove`. */
	id: string;
	scope: PermissionRuleScope;
	/** The project's real path, for a rule allowed always in it. */
	project?: string;
	/** A rule saved for every folder that is no longer allowed there (it runs code the project defines): it is not used. */
	ignored?: true;
}

export interface CurrentPermissionRules {
	/** The `bash` rules of the session and those allowed always in every folder. */
	bash: string[];
	/** The `bash` rules allowed always in this session's project: they cover only what stays in it. */
	projectBash: string[];
	paths: string[];
	/** Why a saved file was not used: `<path>: <reason>; no saved rule is used`, one line per file. */
	problem?: string;
	/** The rules saved for every folder that are no longer used there, and what to do about them. */
	ignored?: string;
}

/** A rule that cannot be kept, or a file that cannot be written. */
export class PermissionRulesError extends Error {
	override name = "PermissionRulesError";
}

export const permissionRulesPath = (home: string) => join(home, ".atelier", "permissions.json");
export const projectPermissionRulesPath = (home: string) => join(home, ".atelier", "project-permissions.json");

/** Writes to one file wait for each other in this process, so a read and its write are never interleaved. */
const writing = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
	const next = (writing.get(path) ?? Promise.resolve()).then(work, work);
	writing.set(
		path,
		next.catch(() => {}),
	);
	return next;
}

/** Why a rule cannot be kept, or undefined when it can. */
function ruleProblem(
	{ kind, value }: PermissionRule,
	scope: PermissionRuleScope,
	home: string | undefined,
): string | undefined {
	if (kind === "bash") {
		const broadest = commandRuleScope(value);
		if (broadest === undefined) return `"${value}" is not a command rule`;
		if (scope !== "session" && broadest === "session")
			return `"${value}" runs arbitrary code: it is never allowed always`;
		if (scope === "always" && broadest === "project")
			return `"${value}" runs code the project defines: it is allowed always only in a project`;
		return undefined;
	}
	if (scope === "project") return `"${value}" is a folder: folders are not allowed per project`;
	if (!isAbsolute(value) || normalize(value) !== value || value.endsWith("/"))
		return `"${value}" is not an absolute folder`;
	if (home !== undefined && isInside(value, home)) return `"${value}" contains the home directory`;
	return undefined;
}

/** A rule allowed always in one project. */
interface ProjectRule {
	value: string;
	project: string;
}

type Saved = { rules: PermissionRule[]; problem?: string };
type ProjectSaved = { rules: ProjectRule[]; problem?: string };

const keyOf = ({ kind, value }: PermissionRule) => `${kind}:${value}`;
const projectKeyOf = ({ value, project }: ProjectRule) => `${project}\n${value}`;

/** Whether a rule saved for every folder is used there: a project's command is not, though it is kept in the file. */
const usedEverywhere = ({ kind, value }: PermissionRule) => kind === "path" || commandRuleScope(value) === "always";

/** The entries of a saved file of `kind`, or why it cannot be used; a missing file has none. */
async function readEntries(path: string, kind: string): Promise<{ entries: unknown[] } | { reason: string }> {
	let text: string;
	try {
		const info = await stat(path);
		if ((info.mode & 0o022) !== 0) return { reason: "writable by other users" };
		if (process.getuid !== undefined && info.uid !== process.getuid()) return { reason: "not owned by you" };
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
		return { reason: `cannot read it: ${(error as Error).message}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { reason: "not valid JSON" };
	}
	const file = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	if (file.kind !== kind || file.version !== VERSION)
		return { reason: `expected kind "${kind}" and version ${VERSION}` };
	const unknown = Object.keys(file).find((key) => !["kind", "version", "allow"].includes(key));
	if (unknown !== undefined) return { reason: `unknown key "${unknown}"` };
	if (!Array.isArray(file.allow)) return { reason: '"allow" must be an array' };
	return { entries: file.allow };
}

/**
 * Reads the rules saved for every folder; a missing file has none, an invalid one none and a problem. A valid rule
 * that is no longer allowed in every folder (a project's command, an interpreter) is kept: `usedEverywhere` tells.
 */
async function readSaved(home: string): Promise<Saved> {
	const path = permissionRulesPath(home);
	const invalid = (reason: string): Saved => ({ rules: [], problem: `${path}: ${reason}; no saved rule is used` });
	const read = await readEntries(path, KIND);
	if ("reason" in read) return invalid(read.reason);
	const rules: PermissionRule[] = [];
	for (const [index, entry] of read.entries.entries()) {
		const keys = typeof entry === "object" && entry !== null ? Object.keys(entry) : [];
		const kind = keys[0];
		const value = keys.length === 1 ? (entry as Record<string, unknown>)[kind as string] : undefined;
		const rule: PermissionRule | undefined =
			(kind === "bash" || kind === "path") && typeof value === "string" ? { kind, value } : undefined;
		const problem =
			rule === undefined
				? 'expected { "bash": "<rule>" } or { "path": "<folder>" }'
				: ruleProblem(rule, rule.kind === "bash" ? "session" : "always", home);
		if (rule === undefined || problem !== undefined) return invalid(`entry ${index + 1}: ${problem}`);
		rules.push(rule);
	}
	return { rules };
}

/** Reads the rules saved for projects; a missing file has none, an invalid one none and a problem. */
async function readProjectSaved(home: string): Promise<ProjectSaved> {
	const path = projectPermissionRulesPath(home);
	const invalid = (reason: string): ProjectSaved => ({
		rules: [],
		problem: `${path}: ${reason}; no saved project rule is used`,
	});
	const read = await readEntries(path, PROJECT_KIND);
	if ("reason" in read) return invalid(read.reason);
	const rules: ProjectRule[] = [];
	for (const [index, entry] of read.entries.entries()) {
		const fields = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
		const { bash: value, project } = fields;
		const shaped =
			Object.keys(fields).length === 2 &&
			typeof value === "string" &&
			typeof project === "string" &&
			isAbsolute(project) &&
			normalize(project) === project;
		const problem = shaped
			? ruleProblem({ kind: "bash", value }, "project", home)
			: 'expected { "bash": "<rule>", "project": "<absolute folder>" }';
		if (!shaped || problem !== undefined) return invalid(`entry ${index + 1}: ${problem}`);
		rules.push({ value, project });
	}
	return { rules };
}

/** Writes a rules file through a new 0600 temporary file and a rename, so a reader never sees half a file. */
async function writeFileAtomically(home: string, path: string, content: unknown): Promise<void> {
	await mkdir(join(home, ".atelier"), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`);
		} finally {
			await handle.close();
		}
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

const writeSaved = (home: string, rules: readonly PermissionRule[]) =>
	writeFileAtomically(home, permissionRulesPath(home), {
		kind: KIND,
		version: VERSION,
		allow: rules.map(({ kind, value }) => ({ [kind]: value })),
	});

const writeProjectSaved = (home: string, rules: readonly ProjectRule[]) =>
	writeFileAtomically(home, projectPermissionRulesPath(home), {
		kind: PROJECT_KIND,
		version: VERSION,
		allow: rules.map(({ value, project }) => ({ bash: value, project })),
	});

/** What a session says about the saved rules no longer used in every folder. */
function ignoredNote(home: string, rules: readonly PermissionRule[]): string | undefined {
	if (rules.length === 0) return undefined;
	const names = rules.map(({ value }) => JSON.stringify(value)).join(", ");
	return `${permissionRulesPath(home)}: not used in every folder anymore, as they run code the project defines or any code given to them: ${names}. Allow them again in a project if you want, and remove these from the rules list`;
}

export interface PermissionRulesOptions {
	/** The user's home, where the rules allowed always are kept; without it only session rules exist. */
	home?: string;
	/** The session's working directory: its project (`projectRoot`) is where rules allowed in this project apply. */
	cwd?: string;
}

/** The rules of one session: its own in memory, and the user's saved ones, read again at each use. */
export class PermissionRules {
	readonly #home: string | undefined;
	readonly #session = new Map<string, PermissionRule>();
	readonly #project: Promise<string | undefined>;

	constructor({ home, cwd }: PermissionRulesOptions = {}) {
		this.#home = home;
		// Settled once, when the session opens: what the agent does later cannot move its project.
		this.#project =
			home === undefined || cwd === undefined ? Promise.resolve(undefined) : projectRoot(cwd).catch(() => undefined);
	}

	/** Whether rules can be allowed always: there is a home to save them in. */
	get canSave(): boolean {
		return this.#home !== undefined;
	}

	/** The project rules allowed "in this project" apply to; undefined when they cannot be saved. */
	project(): Promise<string | undefined> {
		return this.#project;
	}

	async #saved(): Promise<Saved> {
		return this.#home === undefined ? { rules: [] } : readSaved(this.#home);
	}

	/** The rules saved for this session's project. */
	async #projectSaved(): Promise<ProjectSaved> {
		const project = await this.#project;
		if (this.#home === undefined || project === undefined) return { rules: [] };
		const saved = await readProjectSaved(this.#home);
		return { ...saved, rules: saved.rules.filter((rule) => rule.project === project) };
	}

	/** The rules in force now, session and saved together. */
	async current(): Promise<CurrentPermissionRules> {
		const [saved, projectSaved] = await Promise.all([this.#saved(), this.#projectSaved()]);
		const all = [...this.#session.values(), ...saved.rules.filter(usedEverywhere)];
		const values = (kind: PermissionRuleKind) => [
			...new Set(all.filter((rule) => rule.kind === kind).map(({ value }) => value)),
		];
		const problems = [saved.problem, projectSaved.problem].filter((problem) => problem !== undefined);
		const ignored =
			this.#home === undefined
				? undefined
				: ignoredNote(
						this.#home,
						saved.rules.filter((rule) => !usedEverywhere(rule)),
					);
		return {
			bash: values("bash"),
			projectBash: [...new Set(projectSaved.rules.map(({ value }) => value))],
			paths: values("path"),
			...(problems.length === 0 ? {} : { problem: problems.join("\n") }),
			...(ignored === undefined ? {} : { ignored }),
		};
	}

	/**
	 * Keeps the rules for this session, saves them for this session's project or for every folder; throws
	 * `PermissionRulesError` when one cannot be kept.
	 */
	async allow(rules: readonly PermissionRule[], scope: PermissionRuleScope): Promise<void> {
		for (const rule of rules) {
			const problem = ruleProblem(rule, scope, this.#home);
			if (problem !== undefined) throw new PermissionRulesError(problem);
		}
		if (scope === "session") {
			for (const rule of rules) this.#session.set(keyOf(rule), { kind: rule.kind, value: rule.value });
			return;
		}
		const home = this.#home;
		if (home === undefined) throw new PermissionRulesError("there is no home directory to save the rule in");
		if (scope === "project") {
			const project = await this.#project;
			if (project === undefined) throw new PermissionRulesError("this session has no project to save the rule for");
			await serialized(projectPermissionRulesPath(home), async () => {
				const saved = await readProjectSaved(home);
				if (saved.problem !== undefined) throw new PermissionRulesError(saved.problem);
				const merged = new Map(saved.rules.map((rule) => [projectKeyOf(rule), rule]));
				for (const { value } of rules) merged.set(projectKeyOf({ value, project }), { value, project });
				if (merged.size !== saved.rules.length) await writeProjectSaved(home, [...merged.values()]);
			});
			return;
		}
		await serialized(permissionRulesPath(home), async () => {
			const saved = await readSaved(home);
			if (saved.problem !== undefined) throw new PermissionRulesError(saved.problem);
			const merged = new Map(saved.rules.map((rule) => [keyOf(rule), rule]));
			for (const rule of rules) merged.set(keyOf(rule), { kind: rule.kind, value: rule.value });
			if (merged.size !== saved.rules.length) await writeSaved(home, [...merged.values()]);
		});
	}

	/** Every rule in force, session ones first, then this project's, then the saved ones (those not used last, marked). */
	async list(): Promise<ListedPermissionRule[]> {
		const [saved, projectSaved] = await Promise.all([this.#saved(), this.#projectSaved()]);
		return [
			...[...this.#session.values()].map((rule) => ({
				id: `session:${keyOf(rule)}`,
				scope: "session" as const,
				...rule,
			})),
			...projectSaved.rules.map(({ value, project }) => ({
				id: `project:${keyOf({ kind: "bash", value })}`,
				scope: "project" as const,
				kind: "bash" as const,
				value,
				project,
			})),
			...saved.rules
				.filter(usedEverywhere)
				.map((rule) => ({ id: `always:${keyOf(rule)}`, scope: "always" as const, ...rule })),
			...saved.rules
				.filter((rule) => !usedEverywhere(rule))
				.map((rule) => ({ id: `always:${keyOf(rule)}`, scope: "always" as const, ...rule, ignored: true as const })),
		];
	}

	/** Removes the rule `list` named `id`; false when there is none. */
	async remove(id: string): Promise<boolean> {
		if (id.startsWith("session:")) return this.#session.delete(id.slice("session:".length));
		const home = this.#home;
		if (home === undefined) return false;
		if (id.startsWith("project:")) {
			const project = await this.#project;
			const key = id.slice("project:".length);
			if (project === undefined || !key.startsWith("bash:")) return false;
			const removed = projectKeyOf({ value: key.slice("bash:".length), project });
			return serialized(projectPermissionRulesPath(home), async () => {
				const saved = await readProjectSaved(home);
				if (saved.problem !== undefined) throw new PermissionRulesError(saved.problem);
				const kept = saved.rules.filter((rule) => projectKeyOf(rule) !== removed);
				if (kept.length === saved.rules.length) return false;
				await writeProjectSaved(home, kept);
				return true;
			});
		}
		if (!id.startsWith("always:")) return false;
		const key = id.slice("always:".length);
		return serialized(permissionRulesPath(home), async () => {
			const saved = await readSaved(home);
			if (saved.problem !== undefined) throw new PermissionRulesError(saved.problem);
			const kept = saved.rules.filter((rule) => keyOf(rule) !== key);
			if (kept.length === saved.rules.length) return false;
			await writeSaved(home, kept);
			return true;
		});
	}
}
