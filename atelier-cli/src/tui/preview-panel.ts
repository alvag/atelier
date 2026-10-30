import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";

/** The columns a panel's sides take around its content: `│ ` and ` │`. */
export const PANEL_FRAME = 4;

/** A preview's lines as written: tabs as two spaces, and a final newline ending the last line rather than starting one. */
export function previewLines(preview: string): string[] {
	return preview.replace(/\n$/, "").replaceAll("\t", "  ").split("\n");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/**
 * What a row never splits, captured to keep it: a marker of the sanitizer (`⟨U+061C⟩`), or a terminal sequence: CSI,
 * OSC (a hyperlink's, say) up to its BEL or ST, or another escape and its one character.
 */
const WHOLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal sequence starts with the escape character
	/(⟨U\+[0-9A-F]{4,6}⟩|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/;
/** A hyperlink's sequence, OSC 8: its target, empty when it ends one. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the sequence starts with the escape character
const HYPERLINK = /^\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/;
/** A color or style sequence, SGR; `\x1b[m` and `\x1b[0m` end them all. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the sequence starts with the escape character
const STYLE = /^\x1b\[[0-9;]*m$/;
const RESET = "\x1b[0m";
const END_LINK = "\x1b]8;;\x07";

/** The pieces of `line` a row may end between: its characters as the eye sees them, and what `WHOLE` matches. */
function pieces(line: string): string[] {
	return line
		.split(WHOLE)
		.flatMap((part, index) =>
			index % 2 === 1 ? [part] : Array.from(graphemes.segment(part), (entry) => entry.segment),
		);
}

/**
 * `line` cut into rows of at most `width` columns, by columns rather than words: every space stays where it was. A
 * color or a hyperlink that goes on past a row's end is ended there and started again on the next row, so the panel's
 * side is never in it.
 */
function cutLine(line: string, width: number): string[] {
	const rows: string[] = [];
	let row = "";
	let used = 0;
	/** The color and the hyperlink in effect: the sequences that started them. */
	let style = "";
	let link = "";
	for (const piece of pieces(line)) {
		const size = visibleWidth(piece);
		if (used > 0 && used + size > width) {
			rows.push(`${row}${link === "" ? "" : END_LINK}${style === "" ? "" : RESET}`);
			row = `${style}${link}`;
			used = 0;
		}
		if (STYLE.test(piece)) style = piece === "\x1b[m" || piece === RESET ? "" : `${style}${piece}`;
		const target = HYPERLINK.exec(piece);
		if (target) link = target[1] === "" ? "" : piece;
		row += piece;
		used += size;
	}
	return [...rows, row];
}

/** A preview's rows in `width` columns: each of its lines, cut by columns. */
export function previewRows(preview: string, width: number): string[] {
	return previewLines(preview).flatMap((line) => cutLine(line, Math.max(1, width)));
}

/**
 * `rows` in a box `width` columns wide, `height` rows between its borders: blank rows fill it when they are fewer, and
 * when they are more the last row says, dimmed, how many more there are. The border is dimmed, with `title` in the top
 * one.
 */
export function previewPanel(
	panel: { title?: string; rows: readonly string[]; width: number; height: number },
	paint: Paint,
): string[] {
	const content = Math.max(1, panel.width - PANEL_FRAME);
	const height = Math.max(1, panel.height);
	const cut = panel.rows.length > height;
	const kept = cut ? panel.rows.slice(0, height - 1) : panel.rows;
	const more = cut ? [paint("dim", `… ${panel.rows.length - kept.length} more lines`)] : [];
	const shown = [...kept, ...more];
	const filled = [...shown, ...Array.from({ length: height - shown.length }, () => "")];
	const side = paint("dim", "│");
	const line = (text: string) => {
		const fitted = truncateToWidth(text, content, "…");
		return `${side} ${fitted}${" ".repeat(Math.max(0, content - visibleWidth(fitted)))} ${side}`;
	};
	const title = panel.title === undefined ? undefined : truncateToWidth(panel.title, content, "…");
	const top =
		title === undefined
			? paint("dim", `┌${"─".repeat(content + 2)}┐`)
			: `${paint("dim", "┌")} ${title} ${paint("dim", `${"─".repeat(content - visibleWidth(title))}┐`)}`;
	return [top, ...filled.map(line), paint("dim", `└${"─".repeat(content + 2)}┘`)];
}
