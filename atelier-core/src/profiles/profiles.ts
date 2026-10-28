import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "../thinking.ts";

export const PROFILES_KIND = "atelier.agent_model_profiles";
export const PROFILES_VERSION = 1;

export const ROLES = [
	"orchestrator",
	"worker",
	"explorer",
	"verifier",
	"review-risk",
	"review-resilience",
	"review-readability",
	"review-reliability",
	"review-refuter",
	"review-validator",
	"compaction",
	"permission-classifier",
] as const;
export type Role = (typeof ROLES)[number];

export { THINKING_LEVELS, type ThinkingLevel };

export const PROFILE_BACKENDS = ["anthropic-api", "claude-code", "opencode-go"] as const;
export type ProfileBackend = (typeof PROFILE_BACKENDS)[number];

const SAFE_MODEL = /^[A-Za-z0-9._~:@/+%-]+$/;

/** What one role asks for; a missing field inherits from the session. */
export interface RoleEntry {
	backend?: ProfileBackend;
	model?: string;
	thinking?: ThinkingLevel;
}

/** The roles a profile sets; every other role inherits. */
export type Profile = Partial<Record<Role, RoleEntry>>;

/** Something dropped or ignored while reading a file. The rest of the file still counts. */
export interface ProfileReport {
	/** The file the report is about. */
	path: string;
	message: string;
}

export interface ProfilesFile {
	active?: string;
	profiles: Map<string, Profile>;
}

export type ProfilesRead =
	| { valid: true; file: ProfilesFile; reports: ProfileReport[] }
	| { valid: false; reason: string; reports: ProfileReport[] };

export function profilesPath(home: string = homedir()): string {
	return join(home, ".atelier", "profiles.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function distance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++)
			row[j] = Math.min(
				(previous[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		previous = row;
	}
	return previous[b.length] as number;
}

/** The known name closest to `name` when it is a typo away, for "did you mean". */
export function closestName(name: string, known: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = 3;
	for (const candidate of known) {
		const d = distance(name.toLowerCase(), candidate);
		if (d < bestDistance) [best, bestDistance] = [candidate, d];
	}
	return best;
}

/** The backend prefix split from the model, or why the text is not a model. */
function parseModel(value: unknown): { ok: true; entry: RoleEntry } | { ok: false; why: string } {
	if (typeof value !== "string" || !SAFE_MODEL.test(value)) return { ok: false, why: "unsafe or empty model" };
	const backend = PROFILE_BACKENDS.find((name) => value.startsWith(`${name}/`));
	const model = backend === undefined ? value : value.slice(backend.length + 1);
	if (model === "") return { ok: false, why: `no model after the "${backend}/" prefix` };
	return { ok: true, entry: { ...(backend === undefined ? {} : { backend }), model } };
}

const isLevel = (value: unknown): value is ThinkingLevel => THINKING_LEVELS.includes(value as ThinkingLevel);

/** One role's entry; undefined when nothing valid is left. Reports what it drops. */
function parseEntry(raw: unknown, where: string, report: (message: string) => void): RoleEntry | undefined {
	if (!isRecord(raw)) {
		report(`${where}: not an object, dropped`);
		return undefined;
	}
	const entry: RoleEntry = {};
	if (raw.model !== undefined) {
		const parsed = parseModel(raw.model);
		if (parsed.ok) Object.assign(entry, parsed.entry);
		else report(`${where}: ${parsed.why}, model dropped`);
	}
	// "effort" is the alias of "thinking"; a valid "thinking" wins.
	for (const key of ["thinking", "effort"] as const) {
		const level = raw[key];
		if (level === undefined || entry.thinking !== undefined) continue;
		if (isLevel(level)) entry.thinking = level;
		else report(`${where}: unknown level for ${key} (${THINKING_LEVELS.join(", ")}), dropped`);
	}
	return entry.model === undefined && entry.thinking === undefined ? undefined : entry;
}

function parseProfile(raw: unknown, name: string, path: string, reports: ProfileReport[]): Profile | undefined {
	if (!isRecord(raw)) {
		reports.push({ path, message: `profile "${name}": not an object, dropped` });
		return undefined;
	}
	const profile: Profile = {};
	for (const [role, value] of Object.entries(raw)) {
		const report = (message: string) => reports.push({ path, message });
		if (!(ROLES as readonly string[]).includes(role)) {
			const near = closestName(role, ROLES);
			report(
				`profile "${name}": unknown role "${role}"${near === undefined ? "" : `, did you mean "${near}"?`}, dropped`,
			);
			continue;
		}
		const entry = parseEntry(value, `profile "${name}", role "${role}"`, report);
		if (entry !== undefined) profile[role as Role] = entry;
	}
	return profile;
}

/** Reads the text of a `profiles.json`. Anything but the expected `kind` and `version` makes the whole file invalid. */
export function parseProfiles(text: string, path: string = profilesPath()): ProfilesRead {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { valid: false, reason: "not valid JSON", reports: [] };
	}
	if (!isRecord(raw) || raw.kind !== PROFILES_KIND || raw.version !== PROFILES_VERSION)
		return { valid: false, reason: `expected kind "${PROFILES_KIND}" and version ${PROFILES_VERSION}`, reports: [] };
	const reports: ProfileReport[] = [];
	const profiles = new Map<string, Profile>();
	if (raw.profiles !== undefined && !isRecord(raw.profiles))
		reports.push({ path, message: `"profiles" is not an object, ignored` });
	else
		for (const [name, value] of Object.entries(raw.profiles ?? {})) {
			const profile = parseProfile(value, name, path, reports);
			if (profile !== undefined) profiles.set(name, profile);
		}
	const file: ProfilesFile = { profiles };
	if (typeof raw.active === "string" && raw.active !== "") file.active = raw.active;
	else if (raw.active !== undefined) reports.push({ path, message: `"active" is not a profile name, ignored` });
	return { valid: true, file, reports };
}

/** Reads `~/.atelier/profiles.json`. A missing file is no profiles, not an error. */
export async function readProfiles(home: string = homedir()): Promise<ProfilesRead> {
	const path = profilesPath(home);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { valid: true, file: { profiles: new Map() }, reports: [] };
		return { valid: false, reason: `cannot read it: ${(error as Error).message}`, reports: [] };
	}
	return parseProfiles(text, path);
}

/** Writes `~/.atelier/profiles.json` through a temporary file and a rename, so a reader never sees half a file. */
export async function writeProfiles(file: ProfilesFile, home: string = homedir()): Promise<void> {
	const path = profilesPath(home);
	const body = {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		...(file.active === undefined ? {} : { active: file.active }),
		profiles: Object.fromEntries(
			[...file.profiles].map(([name, profile]) => [
				name,
				Object.fromEntries(
					Object.entries(profile).map(([role, entry]) => [
						role,
						{
							...(entry.model === undefined
								? {}
								: { model: entry.backend === undefined ? entry.model : `${entry.backend}/${entry.model}` }),
							...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
						},
					]),
				),
			]),
		),
	};
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
