import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { secretDirectories } from "./sandbox-paths.ts";

/**
 * The user's and the project's additions to the agent's sandbox policy:
 * `~/.atelier/sandbox.json` and `<cwd>/.atelier/sandbox.json`, each
 * `{ "allowWrite"?: string[], "denyRead"?: string[] }`. They only add. What the
 * policy fixes (the library's own protections, the user's secrets, the secret
 * file patterns, and these files) stays, and a write entry that would touch it
 * is refused. They never apply to the verifier.
 */

/** The paths a file adds, absolute. */
export interface SandboxAdditions {
	allowWrite: string[];
	denyRead: string[];
}

export class SandboxConfigError extends Error {
	constructor(file: string, problem: string) {
		super(`Invalid sandbox configuration ${file}: ${problem}`);
		this.name = "SandboxConfigError";
	}
}

const KEYS = ["allowWrite", "denyRead"] as const;
const EXAMPLE = '{"allowWrite": ["~/work"], "denyRead": ["~/Documents"]}';

export function userConfigFile(home: string): string {
	return join(home, ".atelier", "sandbox.json");
}

export function projectConfigFile(cwd: string): string {
	return join(cwd, ".atelier", "sandbox.json");
}

export interface LoadOptions {
	cwd: string;
	home: string;
}

/**
 * Reads both files (a missing one adds nothing) and returns their entries as
 * absolute paths, the user's first. Throws `SandboxConfigError`, naming the file
 * and the problem, for anything it cannot take as written.
 */
export function loadSandboxAdditions({ cwd, home }: LoadOptions): SandboxAdditions {
	const protectedPaths = protectedWritePaths(home);
	const additions: SandboxAdditions = { allowWrite: [], denyRead: [] };
	for (const [file, base] of [
		[userConfigFile(home), home],
		[projectConfigFile(cwd), cwd],
	] as const) {
		const config = readConfig(file);
		if (config === undefined) continue;
		for (const entry of config.allowWrite ?? []) {
			const path = resolveEntry(entry, base, home);
			const refusal = protectedConflict(path, protectedPaths);
			if (refusal !== undefined)
				throw new SandboxConfigError(file, `allowWrite entry ${JSON.stringify(entry)} is refused: ${refusal}`);
			additions.allowWrite.push(path);
		}
		for (const entry of config.denyRead ?? []) additions.denyRead.push(resolveEntry(entry, base, home));
	}
	return additions;
}

type RawConfig = Partial<Record<(typeof KEYS)[number], string[]>>;

function readConfig(file: string): RawConfig | undefined {
	if (!existsSync(file)) return undefined;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new SandboxConfigError(file, `could not be read (${reason(error)})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SandboxConfigError(file, `not valid JSON (${reason(error)})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new SandboxConfigError(file, `must be a JSON object, for example ${EXAMPLE}`);
	const config = parsed as Record<string, unknown>;
	for (const key of Object.keys(config))
		if (!(KEYS as readonly string[]).includes(key))
			throw new SandboxConfigError(
				file,
				`unknown key ${JSON.stringify(key)} (the keys are "allowWrite" and "denyRead")`,
			);
	for (const key of KEYS) {
		const value = config[key];
		if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string" && v !== "")))
			throw new SandboxConfigError(file, `"${key}" must be an array of non-empty strings`);
	}
	return config as RawConfig;
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `~`, `~/x`, an absolute path, or a path relative to `base`; made absolute and with symbolic links resolved. */
function resolveEntry(entry: string, base: string, home: string): string {
	const expanded = entry === "~" ? home : entry.startsWith("~/") ? join(home, entry.slice(2)) : entry;
	return canonical(resolve(base, expanded));
}

/** The real path, also for what does not exist yet: the nearest existing ancestor is resolved. */
function canonical(path: string): string {
	let existing = path;
	const rest: string[] = [];
	while (!existsSync(existing) && dirname(existing) !== existing) {
		rest.unshift(existing.slice(dirname(existing).length + 1));
		existing = dirname(existing);
	}
	return join(realpathSync(existing), ...rest);
}

/** What no entry may make writable: home itself and the places only the user may change. */
export function protectedWritePaths(home: string): { whole: string[]; inside: string[] } {
	const inside = [...secretDirectories(home), join(home, ".atelier")].map(canonical);
	return { whole: [canonical(home), ...inside], inside };
}

const isWithin = (path: string, parent: string) =>
	path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Why `path` cannot be writable, or undefined when it can. */
function protectedConflict(
	path: string,
	{ whole, inside }: ReturnType<typeof protectedWritePaths>,
): string | undefined {
	const covered = whole.find((protectedPath) => isWithin(protectedPath, path));
	if (covered !== undefined) return `it would make ${covered} writable, and that path stays protected`;
	const parent = inside.find((protectedPath) => isWithin(path, protectedPath));
	if (parent !== undefined) return `it is inside ${parent}, which stays protected`;
	return undefined;
}
