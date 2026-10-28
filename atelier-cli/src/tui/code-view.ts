import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.ts";
import type { Paint } from "./style.ts";

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

/** A line of the view: its number when it has one, its mark, and its text already painted. */
interface Row {
	number?: number;
	mark?: Kind;
	text: string;
}

const MARKS = { same: " ", removed: "-", added: "+" } as const;
const MARK_STYLES = { removed: "red", added: "green" } as const;

/** The language highlight.js may know a file by: its extension. */
const languageOf = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1];

/** `… 3 more lines` after the first `max` rows. */
function capRows(rows: Row[], max: number): Row[] {
	if (rows.length <= max) return rows;
	const left = rows.length - max;
	return [...rows.slice(0, max), { text: `… ${left} more line${left === 1 ? "" : "s"}` }];
}

/**
 * The rows laid out to `room` columns: the numbers dimmed and lined up, the marks in red and green, and a line too
 * long wrapped under its text, not under its number.
 */
function layout(rows: Row[], room: number, paint: Paint): string[] {
	const digits = Math.max(0, ...rows.map(({ number }) => (number === undefined ? 0 : String(number).length)));
	const marked = rows.some(({ mark }) => mark !== undefined);
	return rows.flatMap(({ number, mark, text }) => {
		const columns = [
			...(digits > 0
				? [number === undefined ? " ".repeat(digits) : paint("dim", String(number).padStart(digits))]
				: []),
			...(marked && mark !== undefined ? [mark === "same" ? " " : paint(MARK_STYLES[mark], MARKS[mark])] : []),
		];
		const prefix = columns.length === 0 ? "" : `${columns.join(" ")} `;
		const indent = " ".repeat(visibleWidth(prefix));
		const parts = wrapTextWithAnsi(text, Math.max(1, room - indent.length));
		return (parts.length === 0 ? [""] : parts).map((part, i) => `${i === 0 ? prefix : indent}${part}`);
	});
}

/** A written file: its first `max` lines numbered and highlighted by its extension. */
export function writeView(path: string, content: string, paint: Paint, room: number, max: number): string[] {
	const rows = highlightCode(paint, content, languageOf(path)).map((text, i): Row => ({ number: i + 1, text }));
	return layout(capRows(rows, max), room, paint);
}

interface Edit {
	oldText: string;
	newText: string;
}

/**
 * An edit as a diff, each of its edits up to `max` rows: removed lines in red, added in green, the lines both sides
 * share dimmed. With `startLines`, the edits go in the file's order with each line's number, before the edit for
 * what it removes and keeps, after it for what it adds; without them, in the call's order, unnumbered.
 */
export function editView(
	edits: readonly Edit[],
	startLines: readonly number[] | undefined,
	paint: Paint,
	room: number,
	max: number,
): string[] {
	const numbered = startLines !== undefined && startLines.length === edits.length;
	const lineCount = (text: string) => text.split("\n").length;
	const placed = edits.map((edit, index) => {
		const start = numbered ? (startLines[index] as number) : undefined;
		// What the edits before it in the file added or removed moves its new lines.
		const shift =
			start === undefined
				? 0
				: edits.reduce(
						(sum, other, k) =>
							(startLines?.[k] ?? start) < start ? sum + lineCount(other.newText) - lineCount(other.oldText) : sum,
						0,
					);
		return { edit, start, shift };
	});
	if (numbered) placed.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
	const rows = placed.flatMap(({ edit, start, shift }, index) => {
		const before = edit.oldText.split("\n");
		const after = edit.newText.split("\n");
		const diff = lineDiff(before, after).map(({ kind, before: b, after: a }): Row => {
			const line = kind === "added" ? (a as number) : (b as number);
			const text = kind === "added" ? after[line] : before[line];
			const number = start === undefined ? undefined : start + line + (kind === "added" ? shift : 0);
			const painted = kind === "same" ? paint("dim", text ?? "") : paint(MARK_STYLES[kind], text ?? "");
			return { ...(number === undefined ? {} : { number }), mark: kind, text: painted };
		});
		return [...(index > 0 ? [{ text: paint("dim", "⋮") }] : []), ...capRows(diff, max)];
	});
	return layout(rows, room, paint);
}
