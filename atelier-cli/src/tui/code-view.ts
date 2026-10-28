import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.ts";
import type { Band, Paint, Tones } from "./style.ts";

/** Characters of a line shown before it is cut: highlighting and wrapping a line much longer would hang the screen. */
const MAX_LINE_CHARS = 500;
/** Characters of code past which it is shown without highlighting, which grows faster than the code. */
const MAX_HIGHLIGHTED = 20_000;

/** `line` cut to its first characters with `…` when it is too long to show whole. */
export function clipLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	// A cut between the halves of a surrogate pair would leave half a character.
	const end = /[\uD800-\uDBFF]/.test(line.charAt(MAX_LINE_CHARS - 1)) ? MAX_LINE_CHARS - 1 : MAX_LINE_CHARS;
	return `${line.slice(0, end)}…`;
}

/** The lines of `code` highlighted as `lang`, or plain when it is too long to highlight quickly. */
export function highlightLines(paint: Paint, lines: readonly string[], lang: string | undefined): string[] {
	const code = lines.join("\n");
	return code.length > MAX_HIGHLIGHTED ? [...lines] : highlightCode(paint, code, lang);
}

/** Lines of a diff past which a pair of texts that long is shown removed and added whole instead of compared. */
const MAX_COMPARED = 250_000;

type Kind = "same" | "removed" | "added";

/** One line of a diff: whether both sides share it, and where it is in the text before and after. */
interface Change {
	kind: Kind;
	before?: number;
	after?: number;
}

/**
 * The lines of `before` and `after` as a diff: the longest run of lines both share stays, the rest is removed or
 * added. Texts too long to compare are removed and added whole.
 */
export function lineDiff(before: readonly string[], after: readonly string[]): Change[] {
	const n = before.length;
	const m = after.length;
	if (n * m > MAX_COMPARED)
		return [
			...before.map((_, i): Change => ({ kind: "removed", before: i })),
			...after.map((_, j): Change => ({ kind: "added", after: j })),
		];
	// `shared(i, j)`: how many lines `before` from `i` and `after` from `j` share, in order.
	const table = new Uint32Array((n + 1) * (m + 1));
	const shared = (i: number, j: number) => table[i * (m + 1) + j] ?? 0;
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			table[i * (m + 1) + j] =
				before[i] === after[j] ? shared(i + 1, j + 1) + 1 : Math.max(shared(i + 1, j), shared(i, j + 1));
	const changes: Change[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && before[i] === after[j]) changes.push({ kind: "same", before: i++, after: j++ });
		else if (j < m && (i === n || shared(i, j + 1) > shared(i + 1, j))) changes.push({ kind: "added", after: j++ });
		else changes.push({ kind: "removed", before: i++ });
	}
	return changes;
}

/** A line of the view: its number when it has one, its mark, its text already painted, and its band. */
interface Row {
	number?: number;
	mark?: Kind;
	text: string;
	band?: Band;
}

const MARKS = { same: " ", removed: "-", added: "+" } as const;
const MARK_STYLES = { removed: "red", added: "green" } as const;

/** The language highlight.js may know a file by: its extension. */
const languageOf = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1];

/** `… 3 more lines`. */
const moreRow = (left: number): Row => ({ text: `… ${left} more line${left === 1 ? "" : "s"}` });

/** `… 3 more lines` after the first `max` rows. */
function capRows(rows: Row[], max: number): Row[] {
	return rows.length <= max ? rows : [...rows.slice(0, max), moreRow(rows.length - max)];
}

/**
 * The rows laid out to `room` columns: the numbers dimmed and lined up, the marks in red and green, a line too long
 * wrapped under its text, not under its number, and a banded row on its band to the last column.
 */
function layout(rows: Row[], room: number, paint: Paint, tones?: Tones): string[] {
	const digits = Math.max(0, ...rows.map(({ number }) => (number === undefined ? 0 : String(number).length)));
	const marked = rows.some(({ mark }) => mark !== undefined);
	return rows.flatMap(({ number, mark, text, band }) => {
		const columns = [
			...(digits > 0
				? [number === undefined ? " ".repeat(digits) : paint("dim", String(number).padStart(digits))]
				: []),
			...(marked && mark !== undefined ? [mark === "same" ? " " : paint(MARK_STYLES[mark], MARKS[mark])] : []),
		];
		const prefix = columns.length === 0 ? "" : `${columns.join(" ")} `;
		const indent = " ".repeat(visibleWidth(prefix));
		const parts = wrapTextWithAnsi(text, Math.max(1, room - indent.length));
		return (parts.length === 0 ? [""] : parts).map((part, i) => {
			const line = `${i === 0 ? prefix : indent}${part}`;
			if (band === undefined || tones === undefined) return line;
			return tones.band(band, `${line}${" ".repeat(Math.max(0, room - visibleWidth(line)))}`);
		});
	});
}

/** A written file: its first `max` lines numbered and highlighted by its extension, each cut when too long. */
export function writeView(path: string, content: string, paint: Paint, room: number, max: number): string[] {
	const lines = content.split("\n");
	const shown = lines.slice(0, max).map(clipLine);
	const rows = highlightLines(paint, shown, languageOf(path)).map((text, i): Row => ({ number: i + 1, text }));
	return layout(lines.length > max ? [...rows, moreRow(lines.length - max)] : rows, room, paint);
}

interface Edit {
	oldText: string;
	newText: string;
}

/**
 * An edit as a diff, each of its edits up to `max` rows: removed lines in red, added in green, the lines both sides
 * share dimmed, each line compared whole and cut only to be shown. On `tones`' bands, the removed and added lines are
 * highlighted by the file's extension instead. With `startLines` and `newStartLines`, where each edit starts in the
 * file before and after the edits, they go in the file's order with each line's number, in the file before for what
 * an edit removes and keeps, in the file after for what it adds; without them, in the call's order, unnumbered.
 */
export function editView(
	path: string,
	edits: readonly Edit[],
	startLines: readonly number[] | undefined,
	newStartLines: readonly number[] | undefined,
	paint: Paint,
	room: number,
	max: number,
	tones?: Tones,
): string[] {
	const banded = tones?.on === true;
	const lang = languageOf(path);
	const numbered =
		startLines !== undefined &&
		newStartLines !== undefined &&
		startLines.length === edits.length &&
		newStartLines.length === edits.length;
	const placed = edits.map((edit, index) => ({
		edit,
		start: numbered ? startLines[index] : undefined,
		newStart: numbered ? newStartLines[index] : undefined,
	}));
	if (numbered) placed.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
	const rows = placed.flatMap(({ edit, start, newStart }, index) => {
		// Compared whole, so a change past where a long line is cut still shows; cut only to be shown.
		const before = edit.oldText.split("\n");
		const after = edit.newText.split("\n");
		const shown = { before: before.map(clipLine), after: after.map(clipLine) };
		const highlighted = banded
			? { before: highlightLines(paint, shown.before, lang), after: highlightLines(paint, shown.after, lang) }
			: undefined;
		const diff = lineDiff(before, after).map(({ kind, before: b, after: a }): Row => {
			const line = kind === "added" ? (a as number) : (b as number);
			const text = (kind === "added" ? shown.after[line] : shown.before[line]) ?? "";
			const first = kind === "added" ? newStart : start;
			const number = first === undefined ? undefined : first + line;
			const row = { ...(number === undefined ? {} : { number }), mark: kind };
			if (kind === "same") return { ...row, text: paint("dim", text) };
			if (highlighted === undefined) return { ...row, text: paint(MARK_STYLES[kind], text) };
			const code = (kind === "added" ? highlighted.after : highlighted.before)[line] ?? text;
			return { ...row, text: code, band: kind };
		});
		return [...(index > 0 ? [{ text: paint("dim", "⋮") }] : []), ...capRows(diff, max)];
	});
	return layout(rows, room, paint, tones);
}
