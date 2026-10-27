import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_STATUS_LINE, isStatusItem, type StatusItem } from "./footer.ts";

const KIND = "atelier.settings";
const VERSION = 1;

/** How the TUI looks, from `~/.atelier/settings.json`'s `tui`. */
export interface TuiSettings {
	/** Whether the TUI takes the alternate screen (default) or runs in the main one. */
	fullscreen: boolean;
	/** Whether the model's thinking starts folded to `✻ Thinking…`; Ctrl+R opens it. */
	hideThinking: boolean;
	/** The status line's items, in order. */
	statusLine: StatusItem[];
	/** What was wrong with the file and what was used instead: the session starts anyway and shows them. */
	warnings: string[];
}

export const settingsPath = (home: string) => join(home, ".atelier", "settings.json");

const defaults = (warnings: string[] = []): TuiSettings => ({
	fullscreen: true,
	hideThinking: false,
	statusLine: DEFAULT_STATUS_LINE,
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
	const { fullscreen, hideThinking, statusLine } = raw.tui;
	if (typeof fullscreen === "boolean") settings.fullscreen = fullscreen;
	else if (fullscreen !== undefined)
		settings.warnings.push(`${path}: "tui.fullscreen" must be true or false; using the default`);
	if (typeof hideThinking === "boolean") settings.hideThinking = hideThinking;
	else if (hideThinking !== undefined)
		settings.warnings.push(`${path}: "tui.hideThinking" must be true or false; using the default`);
	if (Array.isArray(statusLine)) {
		settings.statusLine = statusLine.filter(isStatusItem);
		for (const item of statusLine.filter((item) => !isStatusItem(item)))
			settings.warnings.push(`${path}: unknown status line item ${JSON.stringify(item)}; skipped`);
	} else if (statusLine !== undefined)
		settings.warnings.push(`${path}: "tui.statusLine" must be a list of items; using the default`);
	return settings;
}
