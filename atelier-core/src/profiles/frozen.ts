import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentBackend } from "../backend.ts";
import { MissingApiKeyError } from "../credentials.ts";
import { describeError } from "../events.ts";
import type { BackendName } from "../protocol/types.ts";
import { pinPlaces } from "./pins.ts";
import { type ProfileBackend, type ProfileReport, profilesPath, type Role, type ThinkingLevel } from "./profiles.ts";
import { type ResolvedProfile, type ResolveProfileInput, resolveProfile, roleEntry } from "./resolve.ts";

/** What a session uses of its profile: resolved once at start and never again, with what its files held then. */
export interface FrozenProfile {
	resolved: ResolvedProfile;
	/** The files the resolution reads; a change to any of them after the freeze is noticed, not applied. */
	paths: string[];
	/** A digest of each of `paths` at the freeze; empty for a file that was not there. */
	files: Record<string, string>;
}

/** The digest of each file; empty for one that is missing or unreadable. */
export async function fingerprint(paths: readonly string[]): Promise<Record<string, string>> {
	const digests = await Promise.all(
		paths.map((path) =>
			readFile(path).then(
				(bytes) => createHash("sha256").update(bytes).digest("hex"),
				() => "",
			),
		),
	);
	return Object.fromEntries(paths.map((path, index) => [path, digests[index] as string]));
}

/** Resolves the session's profile by layers and fixes it, remembering what its files held. */
export async function freezeProfile(input: ResolveProfileInput): Promise<FrozenProfile> {
	const home = input.home ?? homedir();
	const pins = input.pins ?? pinPlaces(input.cwd);
	const paths = [
		profilesPath(home),
		...(pins.local === undefined ? [] : [pins.local]),
		...(pins.repo === undefined ? [] : [pins.repo]),
	];
	// Read before resolving: a file that changes in between is noticed at the next turn, never missed.
	const files = await fingerprint(paths);
	return { resolved: await resolveProfile({ ...input, home, pins }), paths, files };
}

/** The files that differ from `seen` as warnings about the frozen profile, and what the files hold now. */
export async function profileChanges(
	frozen: FrozenProfile,
	seen: Record<string, string>,
): Promise<{ changes: ProfileReport[]; files: Record<string, string> }> {
	const now = await fingerprint(frozen.paths);
	const kept = frozen.resolved.name === undefined ? "the default profile" : `profile "${frozen.resolved.name}"`;
	const changes: ProfileReport[] = [];
	for (const path of frozen.paths) {
		const before = seen[path] ?? "";
		const after = now[path] ?? "";
		if (before === after) continue;
		const what = before === "" ? "was created" : after === "" ? "was removed" : "changed";
		changes.push({ path, message: `${what} after the session started; this session keeps ${kept}` });
	}
	return { changes, files: now };
}

/** What a role runs with once the profile and the session's own choices are put together. */
export interface RoleSettings {
	/** The backend the profile names; absent means the session's kind. */
	backend?: ProfileBackend;
	model?: string;
	thinking?: ThinkingLevel;
}

/** The settings of `role`: its entry, and `model` (the session's) where the entry sets none. */
export function roleSettings(frozen: FrozenProfile | undefined, role: Role, model: string | undefined): RoleSettings {
	const entry = frozen === undefined ? {} : roleEntry(frozen.resolved, role);
	const chosen = entry.model ?? model;
	return {
		...(entry.backend === undefined ? {} : { backend: entry.backend }),
		...(chosen === undefined ? {} : { model: chosen }),
		...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
	};
}

/** What the summary request of a session on `backend` takes from the compaction entry, and what to say about the entry. */
export interface CompactionSettings {
	compaction?: { model?: string; thinking?: ThinkingLevel };
	notice?: string;
}

/**
 * The compaction entry for a session on the backend `backendId`. The summary always runs in the session's own
 * backend, so an entry naming another one is dropped whole; Claude Code compacts on its own, so nothing applies there.
 */
export function compactionSettings(frozen: FrozenProfile | undefined, backendId: string): CompactionSettings {
	const entry = roleSettings(frozen, "compaction", undefined);
	if (entry.model === undefined && entry.thinking === undefined) return {};
	if (backendId === "claude-code")
		return { notice: "compaction: claude-code compacts on its own, so the compaction entry does not apply" };
	if (entry.backend !== undefined && entry.backend !== backendId)
		return {
			notice: `compaction: the summary runs in the session's own backend (${backendId}), so the "${entry.backend}" entry is not used`,
		};
	return {
		compaction: {
			...(entry.model === undefined ? {} : { model: entry.model }),
			...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
		},
	};
}

/** The backend the orchestrator's entry names, when it does. */
export function orchestratorBackend(frozen: FrozenProfile | undefined): ProfileBackend | undefined {
	return frozen === undefined ? undefined : roleEntry(frozen.resolved, "orchestrator").backend;
}

/** The backend the main session runs on: the explicit choice, then the orchestrator's prefix, then `fallback`. */
export function sessionBackend(
	frozen: FrozenProfile | undefined,
	explicit: BackendName | undefined,
	fallback: BackendName,
): BackendName {
	if (explicit !== undefined) return explicit;
	return (frozen === undefined ? undefined : roleEntry(frozen.resolved, "orchestrator").backend) ?? fallback;
}

/** Builds the backend for a role; without a name it is the session's kind. */
export type RoleBackendFactory = (name?: BackendName) => AgentBackend | Promise<AgentBackend>;

/**
 * Why a role that names its own backend could not start. It says the role and the backend and
 * nothing falls back to the other backend: the role is the one that fails.
 */
export function roleStartMessage(role: string, backend: string, error: unknown): string {
	if (error instanceof MissingApiKeyError) return `${role}: ${backend} has no API key (${error.message})`;
	return `${role}: ${backend} could not start: ${describeError(error)}`;
}
