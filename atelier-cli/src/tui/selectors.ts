import { type PermissionMode, visibleText } from "@atelier/core";
import type { Choice } from "./dialog.ts";

/** What `options.list` answers, as the selectors read it. */
export interface Options {
	backends: { name: string; models: string[] }[];
	efforts: string[];
	modes: PermissionMode[];
	profiles: string[];
	active?: string;
}

/** How many rows of a list are shown at once; the rest scroll. */
export const LIST_ROWS = 10;

const shown = (text: string) => visibleText(text).text;

const MODE_NOTES: Record<PermissionMode, string> = {
	normal: "sandboxed commands run, the rest asks",
	auto: "a classifier answers what normal would ask",
	yolo: "a plain git push or rebase runs without asking too",
};

/** `notes` joined after the value, `current` first when the value is the one in use. */
function choice(value: string, now: string | undefined, ...notes: (string | undefined)[]): Choice<string> {
	const said = [value === now ? "current" : undefined, ...notes].filter((note) => note !== undefined);
	return { value, label: shown(value), ...(said.length === 0 ? {} : { description: said.join(" · ") }) };
}

/** One choice for each value, the one in use marked. */
export const choicesOf = (values: readonly string[], now: string | undefined): Choice<string>[] =>
	values.map((value) => choice(value, now));

/** The permission modes, each with what it does. */
export const modeChoices = (modes: readonly PermissionMode[], now: string | undefined): Choice<string>[] =>
	modes.map((mode) => choice(mode, now, MODE_NOTES[mode]));

/** The profiles of `profiles.json`, the one in use and the file's `active` marked. */
export const profileChoices = (options: Options, now: string | undefined): Choice<string>[] =>
	options.profiles.map((name) => choice(name, now, name === options.active ? "active" : undefined));

/** The mode the cycle key goes to: normal and auto take turns; yolo is only chosen by name, and leaves to normal. */
export const nextMode = (mode: string | undefined): PermissionMode => (mode === "normal" ? "auto" : "normal");
