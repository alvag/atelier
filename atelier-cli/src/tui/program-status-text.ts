import { plain } from "./herdr-status.ts";

/** The longest line told to the terminal, far under the 2048 bytes OSC 7501 takes. */
export const MAX_LINE_CHARS = 200;
const ELLIPSIS = "…";

/** The first line of `text` with words, one line without control or bidi characters, cut to `max` characters. */
export function oneLine(text: string, max = MAX_LINE_CHARS): string {
	const first = plain(text.split("\n").find((line) => plain(line) !== "") ?? "");
	const characters = [...first];
	if (characters.length <= max) return first;
	return `${characters
		.slice(0, max - 1)
		.join("")
		.trimEnd()}${ELLIPSIS}`;
}
