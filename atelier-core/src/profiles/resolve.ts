import { homedir } from "node:os";
import { type PinPlaces, pinPlaces, readPin } from "./pins.ts";
import {
	type Profile,
	type ProfileReport,
	type ProfilesFile,
	type Role,
	type RoleEntry,
	readProfiles,
} from "./profiles.ts";

/** The layer the session's profile came from. */
export type ProfileOrigin = "explicit" | "local-pin" | "repo" | "active" | "default";

export interface ResolveProfileInput {
	cwd: string;
	/** Defaults to the user's home; tests point it at a fake one. */
	home?: string;
	/** The profile the user chose for this session (`--profile`, the selector, `session.start.profile`). */
	choice?: string;
	/** Where the pins are; defaults to what git says for `cwd`. */
	pins?: PinPlaces;
}

export interface ResolvedProfile {
	/** The profile's name; absent for the default profile. */
	name?: string;
	origin: ProfileOrigin;
	profile: Profile;
	/** Everything dropped or ignored on the way, from every file read. */
	reports: ProfileReport[];
}

/** What `role` asks for in the resolved profile; empty (inherit everything) when the profile does not set it. */
export function roleEntry(resolved: Pick<ResolvedProfile, "profile">, role: Role): RoleEntry {
	return resolved.profile[role] ?? {};
}

/**
 * The profile for a session, from the first layer that names one that exists:
 * the explicit choice, the local pin, the repository's declaration, the
 * global `active`, and otherwise the default profile, which sets nothing. A
 * layer naming a missing profile is reported and skipped. An invalid
 * `profiles.json` is reported and acts as no profiles.
 */
export async function resolveProfile({
	cwd,
	home = homedir(),
	choice,
	pins,
}: ResolveProfileInput): Promise<ResolvedProfile> {
	const read = await readProfiles(home);
	const reports = [...read.reports];
	const path = `${home}/.atelier/profiles.json`;
	if (!read.valid) reports.push({ path, message: `${read.reason}: the file is ignored` });
	const file: ProfilesFile = read.valid ? read.file : { profiles: new Map() };
	const places = pins ?? pinPlaces(cwd);
	const [local, repo] = await Promise.all([
		places.local === undefined ? undefined : readPin(places.local),
		places.repo === undefined ? undefined : readPin(places.repo),
	]);
	reports.push(...(local?.reports ?? []), ...(repo?.reports ?? []));
	const layers: [ProfileOrigin, string | undefined, string][] = [
		["explicit", choice, "the chosen profile"],
		["local-pin", local?.profile, places.local ?? ""],
		["repo", repo?.profile, places.repo ?? ""],
		["active", file.active, path],
	];
	for (const [origin, name, source] of layers) {
		if (name === undefined) continue;
		const profile = file.profiles.get(name);
		if (profile !== undefined) return { name, origin, profile, reports };
		reports.push({ path: source, message: `profile "${name}" does not exist, skipped` });
	}
	return { origin: "default", profile: {}, reports };
}
