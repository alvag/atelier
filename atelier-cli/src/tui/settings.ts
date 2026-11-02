import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_STATUS_LINE, isStatusItem, type StatusItem } from "./footer.ts";
import { NOTIFY_VIAS, type NotifyVia } from "./notifications.ts";

const KIND = "atelier.settings";
const VERSION = 1;

/** When and how the TUI tells the user a turn ended or the session waits for them. */
export interface NotificationSettings {
	enabled: boolean;
	via: NotifyVia;
	sound: boolean;
	/** The shortest turn whose end is told; waiting for the user is told always. */
	minSeconds: number;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = { enabled: true, via: "auto", sound: false, minSeconds: 10 };

/** How the TUI looks, from `~/.atelier/settings.json`'s `tui`. */
export interface TuiSettings {
	/** Whether the TUI takes the alternate screen (default) or runs in the main one. */
	fullscreen: boolean;
	/** Whether the model's thinking starts folded to `✻ Thinking…`; Ctrl+R opens it. */
	hideThinking: boolean;
	/** Whether the fullscreen side panel shows when the terminal is wide enough; Ctrl+P changes and saves it. */
	sidePanel: boolean;
	/** The status line's items, in order. */
	statusLine: StatusItem[];
	notifications: NotificationSettings;
	/** What was wrong with the file and what was used instead: the session starts anyway and shows them. */
	warnings: string[];
}

export const settingsPath = (home: string) => join(home, ".atelier", "settings.json");

const defaults = (warnings: string[] = []): TuiSettings => ({
	fullscreen: true,
	hideThinking: false,
	sidePanel: true,
	statusLine: DEFAULT_STATUS_LINE,
	notifications: { ...DEFAULT_NOTIFICATIONS },
	warnings,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the TUI's settings. A missing file or home gives the defaults; a file that cannot be used gives them with a
 * warning, and a wrong field or item is left out with one, the rest of the file still used.
 */
export async function readTuiSettings(home: string | undefined): Promise<TuiSettings> {
	if (home === undefined) return defaults();
	const path = settingsPath(home);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
		return defaults([`${path}: cannot read it: ${(error as Error).message}; using the defaults`]);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return defaults([`${path}: not valid JSON; using the defaults`]);
	}
	if (!isRecord(raw) || raw.kind !== KIND || raw.version !== VERSION)
		return defaults([`${path}: expected kind "${KIND}" and version ${VERSION}; using the defaults`]);
	if (raw.tui === undefined) return defaults();
	if (!isRecord(raw.tui)) return defaults([`${path}: "tui" must be an object; using the defaults`]);
	const settings = defaults();
	const { fullscreen, hideThinking, sidePanel, statusLine, notifications } = raw.tui;
	if (typeof fullscreen === "boolean") settings.fullscreen = fullscreen;
	else if (fullscreen !== undefined)
		settings.warnings.push(`${path}: "tui.fullscreen" must be true or false; using the default`);
	if (typeof hideThinking === "boolean") settings.hideThinking = hideThinking;
	else if (hideThinking !== undefined)
		settings.warnings.push(`${path}: "tui.hideThinking" must be true or false; using the default`);
	if (typeof sidePanel === "boolean") settings.sidePanel = sidePanel;
	else if (sidePanel !== undefined)
		settings.warnings.push(`${path}: "tui.sidePanel" must be true or false; using the default`);
	if (Array.isArray(statusLine)) {
		const known = statusLine.filter(isStatusItem);
		for (const item of statusLine.filter((item) => !isStatusItem(item)))
			settings.warnings.push(`${path}: unknown status line item ${JSON.stringify(item)}; skipped`);
		// An empty footer looks broken, not chosen: keep the default line.
		if (known.length > 0) settings.statusLine = known;
		else settings.warnings.push(`${path}: "tui.statusLine" has no known item; using the default`);
	} else if (statusLine !== undefined)
		settings.warnings.push(`${path}: "tui.statusLine" must be a list of items; using the default`);
	if (isRecord(notifications)) settings.notifications = readNotifications(notifications, path, settings.warnings);
	else if (notifications !== undefined)
		settings.warnings.push(`${path}: "tui.notifications" must be an object; using the defaults`);
	return settings;
}

/** The saves of each settings file, one after the other: a later choice is written after an earlier one. */
const saves = new Map<string, Promise<unknown>>();
/** Each save's own temporary file. */
let saveCount = 0;

/**
 * Saves whether the side panel shows as `tui.sidePanel`, the rest of the file kept as it was (a missing file is made
 * with that setting alone). A file that cannot be read as settings is left untouched: the answer says why. Saves of
 * the same file run in the order they were asked for, so the last choice is the one kept.
 */
export function saveSidePanel(home: string, shown: boolean): Promise<string | undefined> {
	const path = settingsPath(home);
	const saved = (saves.get(path) ?? Promise.resolve()).then(() => writeSidePanel(path, shown));
	const done = saved.catch(() => {});
	saves.set(path, done);
	void done.then(() => {
		if (saves.get(path) === done) saves.delete(path);
	});
	return saved;
}

async function writeSidePanel(path: string, shown: boolean): Promise<string | undefined> {
	const refused = (why: string) => `${path}: ${why}; the side panel's choice was not saved`;
	let raw: unknown = { kind: KIND, version: VERSION };
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) return refused("not valid JSON");
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return refused(`cannot read it: ${(error as Error).message}`);
	}
	if (!isRecord(raw) || raw.kind !== KIND || raw.version !== VERSION)
		return refused(`expected kind "${KIND}" and version ${VERSION}`);
	if (raw.tui !== undefined && !isRecord(raw.tui)) return refused(`"tui" must be an object`);
	const next = { ...raw, tui: { ...(raw.tui ?? {}), sidePanel: shown } };
	// Written beside it and moved over it, so the file is never left half written.
	const partial = `${path}.${process.pid}.${++saveCount}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		// The file keeps its permissions (a private one stays private); a new one gets the usual ones.
		const mode = await stat(path).then(
			(found) => found.mode & 0o7777,
			() => undefined,
		);
		await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`, mode === undefined ? {} : { mode });
		if (mode !== undefined) await chmod(partial, mode);
		await rename(partial, path);
		return undefined;
	} catch (error) {
		await rm(partial, { force: true }).catch(() => {});
		return refused(`cannot write it: ${(error as Error).message}`);
	}
}

/** The notices' settings, each wrong field left at its default with a warning. */
function readNotifications(raw: Record<string, unknown>, path: string, warnings: string[]): NotificationSettings {
	const read = { ...DEFAULT_NOTIFICATIONS };
	const wrong = (field: string, rule: string) =>
		warnings.push(`${path}: "tui.notifications.${field}" must be ${rule}; using the default`);
	const { enabled, via, sound, minSeconds } = raw;
	if (typeof enabled === "boolean") read.enabled = enabled;
	else if (enabled !== undefined) wrong("enabled", "true or false");
	if (NOTIFY_VIAS.includes(via as NotifyVia)) read.via = via as NotifyVia;
	else if (via !== undefined)
		wrong(
			"via",
			NOTIFY_VIAS.map((name) => `"${name}"`)
				.join(", ")
				.replace(/, (?=[^,]*$)/, " or "),
		);
	if (typeof sound === "boolean") read.sound = sound;
	else if (sound !== undefined) wrong("sound", "true or false");
	if (typeof minSeconds === "number" && Number.isFinite(minSeconds) && minSeconds >= 0) read.minSeconds = minSeconds;
	else if (minSeconds !== undefined) wrong("minSeconds", "a number of seconds, 0 or more");
	return read;
}
