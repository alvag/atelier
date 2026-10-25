import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileReport } from "./profiles.ts";

export const PIN_KIND = "atelier.profile_pin";
export const PIN_VERSION = 1;

/** Where the pins of a working directory live; absent outside a git repository. */
export interface PinPlaces {
	/** `<git common dir>/atelier/profile-pin.json`: the user's choice for this clone. */
	local?: string;
	/** `<worktree root>/.atelier/profile.json`: what the repository declares. */
	repo?: string;
}

export type PinRead = { profile?: string; reports: ProfileReport[] };

/** Finds the pin files for `cwd` by asking git; none outside a repository. */
export function pinPlaces(cwd: string): PinPlaces {
	const found = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
		timeout: 5000,
	});
	const [top, common] = found.status === 0 ? found.stdout.trim().split("\n") : [];
	if (!top?.startsWith("/") || !common?.startsWith("/")) return {};
	return { local: join(common, "atelier", "profile-pin.json"), repo: join(top, ".atelier", "profile.json") };
}

/** The profile a pin file names. Anything wrong with the file is reported and the pin counts as absent. */
export function parsePin(text: string, path: string): PinRead {
	const drop = (message: string): PinRead => ({ reports: [{ path, message: `${message}, pin ignored` }] });
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return drop("not valid JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return drop("not an object");
	const pin = raw as Record<string, unknown>;
	if (pin.kind !== PIN_KIND || pin.version !== PIN_VERSION)
		return drop(`expected kind "${PIN_KIND}" and version ${PIN_VERSION}`);
	if (typeof pin.profile !== "string" || pin.profile === "") return drop(`"profile" is not a profile name`);
	return { profile: pin.profile, reports: [] };
}

/** Reads a pin file; a missing file is no pin and no report. */
export async function readPin(path: string): Promise<PinRead> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reports: [] };
		return { reports: [{ path, message: `cannot read it: ${(error as Error).message}, pin ignored` }] };
	}
	return parsePin(text, path);
}
