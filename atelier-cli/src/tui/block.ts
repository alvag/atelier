import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** A transcript block's lines one column in, as the transcript's text, each wrapped to the width. */
export function blockLines(lines: string[], width: number): string[] {
	if (width < 2) return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
	return lines.flatMap((line) => wrapTextWithAnsi(line, width - 1).map((piece) => ` ${piece}`));
}
