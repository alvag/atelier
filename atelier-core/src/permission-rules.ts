import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { isValidCommandRule } from "./tools/command-rules.ts";
import { isInside } from "./tools/paths.ts";

/**
 * What the user allowed for good or for this session, so the same question is
 * not asked again: a `bash` rule (`open`, `npm install`) or a folder `edit`
 * and `write` may write in. Session rules live in memory; the ones allowed
 * always are in `~/.atelier/permissions.json`, the user's own file, never the
 * repository's, so a repository cannot give itself permissions.
 */

const KIND = "atelier.permissions";
const VERSION = 1;

export type PermissionRuleKind = "bash" | "path";
export type PermissionRuleScope = "session" | "always";

export interface PermissionRule {
	kind: PermissionRuleKind;
	value: string;
}

export interface ListedPermissionRule extends PermissionRule {
	/** Names the rule for `remove`. */
	id: string;
	scope: PermissionRuleScope;
}

export interface CurrentPermissionRules {
	bash: string[];
	paths: string[];
	/** Why the saved file was not used: `<path>: <reason>; no saved rule is used`. */
	problem?: string;
}

/** A rule that cannot be kept, or a file that cannot be written. */
export class PermissionRulesError extends Error {
	override name = "PermissionRulesError";
}

export const permissionRulesPath = (home: string) => join(home, ".atelier", "permissions.json");

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
	if (kind === "bash")
		return isValidCommandRule(value, { always: scope === "always" })
			? undefined
			: scope === "always" && isValidCommandRule(value, { always: false })
				? `"${value}" runs arbitrary code: it is never allowed always`
				: `"${value}" is not a command rule`;
	if (!isAbsolute(value) || normalize(value) !== value || value.endsWith("/"))
		return `"${value}" is not an absolute folder`;
	if (home !== undefined && isInside(value, home)) return `"${value}" contains the home directory`;
	return undefined;
}

type Saved = { rules: PermissionRule[]; problem?: string };

const keyOf = ({ kind, value }: PermissionRule) => `${kind}:${value}`;

/** Reads the saved rules; a missing file has none, an invalid one none and a problem. */
async function readSaved(home: string): Promise<Saved> {
	const path = permissionRulesPath(home);
	const invalid = (reason: string): Saved => ({ rules: [], problem: `${path}: ${reason}; no saved rule is used` });
	let text: string;
	try {
		const info = await stat(path);
		if ((info.mode & 0o022) !== 0) return invalid("writable by other users");
		if (process.getuid !== undefined && info.uid !== process.getuid()) return invalid("not owned by you");
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [] };
		return invalid(`cannot read it: ${(error as Error).message}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalid("not valid JSON");
	}
	const file = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	if (file.kind !== KIND || file.version !== VERSION) return invalid(`expected kind "${KIND}" and version ${VERSION}`);
	const unknown = Object.keys(file).find((key) => !["kind", "version", "allow"].includes(key));
	if (unknown !== undefined) return invalid(`unknown key "${unknown}"`);
	if (!Array.isArray(file.allow)) return invalid('"allow" must be an array');
	const rules: PermissionRule[] = [];
	for (const [index, entry] of file.allow.entries()) {
		const keys = typeof entry === "object" && entry !== null ? Object.keys(entry) : [];
		const kind = keys[0];
		const value = keys.length === 1 ? (entry as Record<string, unknown>)[kind as string] : undefined;
		const rule: PermissionRule | undefined =
			(kind === "bash" || kind === "path") && typeof value === "string" ? { kind, value } : undefined;
		const problem =
			rule === undefined
				? 'expected { "bash": "<rule>" } or { "path": "<folder>" }'
				: ruleProblem(rule, "always", home);
		if (rule === undefined || problem !== undefined) return invalid(`entry ${index + 1}: ${problem}`);
		rules.push(rule);
	}
	return { rules };
}

/** Writes the rules through a new 0600 temporary file and a rename, so a reader never sees half a file. */
async function writeSaved(home: string, rules: readonly PermissionRule[]): Promise<void> {
	const path = permissionRulesPath(home);
	await mkdir(join(home, ".atelier"), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const content = { kind: KIND, version: VERSION, allow: rules.map(({ kind, value }) => ({ [kind]: value })) };
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

export interface PermissionRulesOptions {
	/** The user's home, where the rules allowed always are kept; without it only session rules exist. */
	home?: string;
}

/** The rules of one session: its own in memory, and the user's saved ones, read again at each use. */
export class PermissionRules {
	readonly #home: string | undefined;
	readonly #session = new Map<string, PermissionRule>();

	constructor({ home }: PermissionRulesOptions = {}) {
		this.#home = home;
	}

	/** Whether rules can be allowed always: there is a home to save them in. */
	get canSave(): boolean {
		return this.#home !== undefined;
	}

	async #saved(): Promise<Saved> {
		return this.#home === undefined ? { rules: [] } : readSaved(this.#home);
	}

	/** The rules in force now, session and saved together. */
	async current(): Promise<CurrentPermissionRules> {
		const saved = await this.#saved();
		const all = [...this.#session.values(), ...saved.rules];
		const values = (kind: PermissionRuleKind) => [
			...new Set(all.filter((rule) => rule.kind === kind).map(({ value }) => value)),
		];
		return {
			bash: values("bash"),
			paths: values("path"),
			...(saved.problem === undefined ? {} : { problem: saved.problem }),
		};
	}

	/** Keeps the rules for this session, or saves them for every session; throws `PermissionRulesError` when one cannot be kept. */
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
		await serialized(permissionRulesPath(home), async () => {
			const saved = await readSaved(home);
			if (saved.problem !== undefined) throw new PermissionRulesError(saved.problem);
			const merged = new Map(saved.rules.map((rule) => [keyOf(rule), rule]));
			for (const rule of rules) merged.set(keyOf(rule), { kind: rule.kind, value: rule.value });
			if (merged.size !== saved.rules.length) await writeSaved(home, [...merged.values()]);
		});
	}

	/** Every rule in force, session ones first. */
	async list(): Promise<ListedPermissionRule[]> {
		const saved = await this.#saved();
		return [
			...[...this.#session.values()].map((rule) => ({
				id: `session:${keyOf(rule)}`,
				scope: "session" as const,
				...rule,
			})),
			...saved.rules.map((rule) => ({ id: `always:${keyOf(rule)}`, scope: "always" as const, ...rule })),
		];
	}

	/** Removes the rule `list` named `id`; false when there is none. */
	async remove(id: string): Promise<boolean> {
		if (id.startsWith("session:")) return this.#session.delete(id.slice("session:".length));
		const home = this.#home;
		if (home === undefined || !id.startsWith("always:")) return false;
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
