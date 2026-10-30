import { visibleText } from "@atelier/core";
import {
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
// The prompt editor's own decoding of printable keys, which the package's index does not export.
import { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";
import { PasteFilter } from "./dialog.ts";
import { PANEL_FRAME, previewLines, previewPanel, previewRows } from "./preview-panel.ts";
import type { Paint } from "./style.ts";

/** An option as the dialog shows it: text already made safe to show. */
export interface QuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
	/** What choosing it looks like, shown in a panel while the cursor is on it. */
	preview?: string;
}

/**
 * What the user did: picked the option at that index, sent their own text, checked the options at those indexes (and
 * their own text) of a multi-select question, or cancelled.
 */
export type QuestionAnswer = { option: number } | { other: string } | { options: number[]; other?: string } | "cancel";

const TYPE_SOMETHING = "Type something…";
/** The longest text an `ask_user` answer of the user's own words may have. */
const OTHER_MAX = 2000;
const RECOMMENDED = "Recommended";
/** `❯ 1. `, with the space before it: the columns before a label. */
const LEAD = 6;
/** `[ ] `, a multi-select question's box: the columns it adds before a label. */
const BOX = 4;
const NEXT = "Next →";
const SUBMIT = "Submit";
/** The fewest columns a description gets beside its label, unless it fits in fewer. */
const DESCRIPTION_ROOM = 40;
/** The fewest columns a preview gets beside the options, unless it fits in fewer: under them otherwise. */
const PREVIEW_ROOM = 32;
/** The columns between the options and a preview beside them. */
const PREVIEW_GAP = 2;
const PREVIEW_HINT = "↑↓ to see each option's preview";
const NO_PREVIEW = "No preview";
/** The fewest rows of a panel: its borders and one row between them. */
const PANEL_LEAST = 3;

/** The hint's parts in the order they are dropped when it does not fit: the first goes first. */
const dropOrder = ["enter select", "↑↓ move", "←→ tabs"];

/** Whether `keys` are typed text: no control character, so no other key, is in them. */
const isText = (keys: string) => characters(keys).every((char) => char >= " " && char !== "\x7f");

/** Each character of `text` with its end in it, so the cursor moves by whole characters. */
const characters = (text: string) => Array.from(text);

/** `text` as shown, with the cursor at `at` (an index in `characters`): `before`, the cursor's character and `after`. */
function shownAround(text: string, at: number): { before: string; under: string; after: string } {
	const chars = characters(text);
	const shown = (part: string[]) => visibleText(part.join("")).text;
	return {
		before: shown(chars.slice(0, at)),
		under: shown(chars.slice(at, at + 1)) || " ",
		after: shown(chars.slice(at + 1)),
	};
}

/** The end of `text` that fits in `width` columns, after `…` when it is cut. */
function tailFit(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let chars = characters(text);
	while (chars.length > 0 && visibleWidth(chars.join("")) > width - 1) chars = chars.slice(1);
	return `…${chars.join("")}`;
}

/** The parts of `parts` that fit in `width`, joined, dropping the least needed first; cut as a last resort. */
export function fitHint(parts: readonly string[], width: number): string {
	let kept = [...parts];
	for (const drop of dropOrder) {
		if (visibleWidth(kept.join(" · ")) <= width) break;
		kept = kept.filter((part) => part !== drop);
	}
	return truncateToWidth(kept.join(" · "), Math.max(1, width), "…");
}

/**
 * One `ask_user` question between two rules of the accent color: the question in bold, its options numbered with
 * `Recommended` as a dimmed tag and descriptions beside them when the width allows (under them otherwise), then
 * `Type something…` and a line saying the keys. Nothing is selected at first: Up or Down puts the `❯` cursor on a row
 * and Enter answers it; a number key answers its row at once. On `Type something…` what is typed or pasted goes into
 * the row itself, and Enter sends it as written when it is not blank and at most 2000 characters; the draft stays
 * while the cursor is elsewhere. With `guardMs`, the keys that arrive that long after `reveal()` are dropped, so a key
 * typed before the question appeared does not answer it; pasted text answers nothing, and a paste goes into the text
 * only when it starts there.
 *
 * A multi-select question puts a box before each option and `Type something…`: Space, Enter or a row's number checks it
 * or unchecks it, and typing there checks it (Space and the numbers are text there, unless it is empty: then Space
 * toggles it, and Enter goes to the last row). The last row, `Next →` (`Submit` on the last question), sends what is
 * checked, nothing checked included; checked, `Type something…` needs its text.
 *
 * When options of a single-choice question have a preview, a panel beside the options (under them when the width
 * leaves no room) shows the preview of the one the cursor is on, titled with its number and label; before the cursor is
 * on one it says how to see them. The panel is as tall as the tallest preview, so the rows do not move with the cursor,
 * and with `height` it is cut to the rows left, saying how many more there are, or left out when not even its borders
 * fit: the question, the options and the hint line always stay in sight.
 */
export class QuestionDialog implements Component, Focusable {
	focused = false;
	readonly #question: string;
	readonly #tabs: boolean;
	readonly #onTab: ((step: -1 | 1) => void) | undefined;
	readonly #options: readonly QuestionOption[];
	readonly #multiSelect: boolean;
	/** Whether a multi-select question's last row says `Submit`: it is the last question; `Next →` otherwise. */
	readonly #last: boolean;
	/** The options checked, by index, and whether `Type something…` is. */
	readonly #checked = new Set<number>();
	#otherChecked = false;
	/** Whether a box or the text has changed: before that, a multi-select question has no answer as it stands. */
	#touched = false;
	readonly #paint: Paint;
	readonly #guardMs: number;
	readonly #paste: PasteFilter;
	readonly #answer: (answer: QuestionAnswer) => void;
	readonly #height: (() => number) | undefined;
	#revealedAt: number | undefined;
	/** The row of the cursor, none until a key puts it on one; the last row is `Type something…`. */
	#cursor: number | undefined;
	#answered = false;
	/** How many times it handed the input on, by an answer or a move to another tab: a batch reopens it after each. */
	#given = 0;
	/** What the user typed on `Type something…`, and where the text cursor is in it, in characters. */
	#text = "";
	#at = 0;
	/** Why Enter sent nothing, said in the hint line until the next key. */
	#problem = "";

	constructor(
		options: {
			question: string;
			options: readonly QuestionOption[];
			/** The user checks any number of the options, or none. */
			multiSelect?: boolean;
			/** A multi-select question's last row: `Submit` when true (the default), `Next →` otherwise. */
			last?: boolean;
			/** Whether it is one tab of a batch: the hint line says ←→ moves among them. */
			tabs?: boolean;
			/** A batch's move to another tab, by ← (-1) or → (1), when they are not the text's. */
			onTab?: (step: -1 | 1) => void;
			guardMs?: number;
			/** The filter that followed the input before this question appeared; one of its own by default. */
			paste?: PasteFilter;
			/** The most rows it may take on screen, its rules included; as many as it needs without it. */
			height?: () => number;
		},
		paint: Paint,
		answer: (answer: QuestionAnswer) => void,
	) {
		this.#question = options.question;
		this.#tabs = options.tabs ?? false;
		this.#onTab = options.onTab;
		this.#options = options.options;
		this.#multiSelect = options.multiSelect ?? false;
		this.#last = options.last ?? true;
		this.#paint = paint;
		this.#guardMs = options.guardMs ?? 0;
		this.#paste = options.paste ?? new PasteFilter();
		this.#answer = answer;
		this.#height = options.height;
	}

	/** The options' rows and `Type something…`: the numbered rows. */
	get #rows(): number {
		return this.#options.length + 1;
	}

	/** The rows the cursor goes to: a multi-select question adds `Next →` after the numbered ones. */
	get #stops(): number {
		return this.#rows + (this.#multiSelect ? 1 : 0);
	}

	/** The columns before a label: a multi-select question's box after the number. */
	get #indent(): number {
		return LEAD + (this.#multiSelect ? BOX : 0);
	}

	/** Starts the guard: called when the question is put on screen; `again` when a batch shows it once more. */
	reveal(now = Date.now(), again = false): void {
		if (again) this.#revealedAt = now;
		else this.#revealedAt ??= now;
	}

	/** Takes keys again after it answered, as a batch's tab the user goes back to: the cursor stays on the answer. */
	reopen(): void {
		this.#answered = false;
	}

	/** Says `problem` in the hint line until the next key, such as why a batch was not sent. */
	need(problem: string): void {
		this.#problem = problem;
	}

	/** Whether ← and → are the text's: the cursor is on `Type something…` and something is typed there. */
	get editing(): boolean {
		return this.#typing && this.#text !== "";
	}

	/** The question is already whole: Ctrl+O has nothing to open, and opens no card behind it. */
	toggle(): boolean {
		return true;
	}

	#guarded(): boolean {
		return this.#revealedAt !== undefined && Date.now() - this.#revealedAt < this.#guardMs;
	}

	/** Whether the cursor is on `Type something…`. */
	get #typing(): boolean {
		return this.#cursor === this.#options.length;
	}

	#give(answer: QuestionAnswer): void {
		this.#answered = true;
		this.#given++;
		this.#answer(answer);
	}

	#choose(row: number): void {
		this.#give({ option: row });
	}

	/** Sends the text typed, unless it is blank or too long: then the hint line says why. */
	#send(): void {
		if (this.#text.trim() === "") this.#problem = "Type an answer, or esc to cancel";
		else if (this.#text.length > OTHER_MAX) this.#problem = `Too long: ${this.#text.length} of ${OTHER_MAX} characters`;
		else {
			this.#give({ other: this.#text });
		}
	}

	#insert(text: string): void {
		const chars = characters(this.#text);
		const added = characters(text);
		this.#text = [...chars.slice(0, this.#at), ...added, ...chars.slice(this.#at)].join("");
		this.#at += added.length;
		this.#typed();
	}

	/** The text typed changed: a multi-select question checks `Type something…` while it has text, unchecks it without. */
	#typed(): void {
		if (!this.#multiSelect) return;
		this.#otherChecked = this.#text !== "";
		this.#touched = true;
	}

	/** Checks or unchecks the box of `row`, an option or `Type something…`. */
	#flip(row: number): void {
		this.#touched = true;
		if (row === this.#options.length) this.#otherChecked = !this.#otherChecked;
		else if (this.#checked.has(row)) this.#checked.delete(row);
		else this.#checked.add(row);
	}

	/** What is checked, or why it cannot be sent: `Type something…` checked without a text, or with too long a one. */
	#checks(): { options: number[]; other?: string } | { problem: string } {
		if (this.#otherChecked && this.#text.trim() === "") return { problem: "Type an answer, or uncheck Type something" };
		if (this.#otherChecked && this.#text.length > OTHER_MAX)
			return { problem: `Too long: ${this.#text.length} of ${OTHER_MAX} characters` };
		return { options: [...this.#checked].sort((a, b) => a - b), ...(this.#otherChecked ? { other: this.#text } : {}) };
	}

	/**
	 * A multi-select question's boxes as they stand, or why they cannot be sent: what a batch takes for a tab left
	 * without `Next →`. Undefined for a single-choice question, and before any box or the text changed.
	 */
	current(): { options: number[]; other?: string } | { problem: string } | undefined {
		return this.#multiSelect && this.#touched ? this.#checks() : undefined;
	}

	/** `Next →`: hands on what is checked, unless it cannot be sent: then the hint line says why. */
	#next(): void {
		const checks = this.#checks();
		if ("problem" in checks) this.#problem = checks.problem;
		else this.#give(checks);
	}

	/** A key on `Type something…`: it edits the text; true when it was one. */
	#edit(keys: string): boolean {
		const chars = characters(this.#text);
		if (matchesKey(keys, "left")) this.#at = Math.max(0, this.#at - 1);
		else if (matchesKey(keys, "right")) this.#at = Math.min(chars.length, this.#at + 1);
		else if (matchesKey(keys, "home")) this.#at = 0;
		else if (matchesKey(keys, "end")) this.#at = chars.length;
		else if (matchesKey(keys, "backspace")) {
			if (this.#at === 0) return true;
			this.#text = [...chars.slice(0, this.#at - 1), ...chars.slice(this.#at)].join("");
			this.#at--;
			this.#typed();
		} else if (matchesKey(keys, "delete")) {
			this.#text = [...chars.slice(0, this.#at), ...chars.slice(this.#at + 1)].join("");
			this.#typed();
		}
		// Typed text, a character or a burst of them; any other key is not text.
		else if (isText(keys)) this.#insert(keys);
		else return false;
		return true;
	}

	handleInput(data: string): void {
		if (this.#answered) return;
		const guarded = this.#guarded();
		this.#problem = "";
		// Nothing after an answer in this chunk counts, even once a batch has reopened the question to come back to it.
		const given = this.#given;
		const live = () => !guarded && !this.#answered && this.#given === given;
		// Keys and pastes in the order they came: a paste goes into the text only when it starts there, never into an
		// option.
		this.#paste.read(data, {
			keys: (keys) => {
				// Moving among the tabs takes no guard, as before a question appears; the rest of the chunk is the next tab's.
				if (!this.#answered && this.#given === given && this.#tab(keys)) return;
				if (live()) this.#key(keys);
			},
			keep: () => live() && this.#typing,
			pasted: (text) => {
				if (live() && this.#typing) this.#insert(text.replace(/\r\n?/g, "\n"));
			},
		});
	}

	/** ← or → handed to the batch, unless there is no batch or they edit the text typed; true when they were. */
	#tab(keys: string): boolean {
		const step = matchesKey(keys, "left") ? -1 : matchesKey(keys, "right") ? 1 : 0;
		if (step === 0 || this.#onTab === undefined || this.editing) return false;
		this.#given++;
		this.#onTab(step);
		return true;
	}

	#key(keys: string): void {
		if (matchesKey(keys, "escape")) {
			this.#give("cancel");
			return;
		}
		if (matchesKey(keys, "up") || matchesKey(keys, "down")) {
			const step = matchesKey(keys, "up") ? -1 : 1;
			this.#cursor =
				this.#cursor === undefined
					? step === 1
						? 0
						: this.#stops - 1
					: (this.#cursor + step + this.#stops) % this.#stops;
			return;
		}
		if (this.#multiSelect) {
			this.#check(keys);
			return;
		}
		if (matchesKey(keys, "enter")) {
			if (this.#typing) this.#send();
			else if (this.#cursor !== undefined) this.#choose(this.#cursor);
			return;
		}
		// A printable key the terminal encodes (Kitty CSI-u, modifyOtherKeys) counts as the character, as in the prompt.
		const typed = decodePrintableKey(keys) ?? keys;
		if (this.#typing && this.#edit(typed)) return;
		if (/^[1-9]$/.test(typed)) {
			const row = Number(typed) - 1;
			if (row >= this.#rows) return;
			this.#cursor = row;
			// A number on Type something puts the cursor there, to type.
			if (row < this.#options.length) this.#choose(row);
		}
	}

	/** A key of a multi-select question, after Esc and the arrows: it checks, types or goes on. */
	#check(keys: string): void {
		const typed = decodePrintableKey(keys) ?? keys;
		if (matchesKey(keys, "enter")) {
			if (this.#typing) this.#cursor = this.#rows;
			else if (this.#cursor === this.#rows) this.#next();
			else if (this.#cursor !== undefined) this.#flip(this.#cursor);
			return;
		}
		// Space on an empty Type something checks it or unchecks it; there with text, it is a space.
		if (this.#typing && !(typed === " " && this.#text === "") && this.#edit(typed)) return;
		if (typed === " ") {
			if (this.#cursor !== undefined && this.#cursor < this.#rows) this.#flip(this.#cursor);
			return;
		}
		if (/^[1-9]$/.test(typed)) {
			const row = Number(typed) - 1;
			if (row >= this.#rows) return;
			this.#cursor = row;
			this.#flip(row);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rule = this.#paint("cyan", "─".repeat(Math.max(1, width)));
		return [rule, ...this.body(width, (this.#height?.() ?? Number.POSITIVE_INFINITY) - 2), rule];
	}

	/** What goes between the rules, in `rows` rows when it can: the question, its options and the hint line. */
	body(width: number, rows = Number.POSITIVE_INFINITY): string[] {
		const paint = this.#paint;
		const room = Math.max(1, width - 1);
		const question = wrapTextWithAnsi(paint("bold", this.#question), room);
		const tabs = this.#tabs ? ["←→ tabs"] : [];
		const hint =
			this.#problem !== ""
				? paint("yellow", truncateToWidth(this.#problem, room, "…"))
				: paint("dim", fitHint(this.#hint(tabs), room));
		// The blank row after the question, the one before the hint, and the hint.
		const middle = rows - question.length - 3;
		const lines = [...question.map((line) => ` ${line}`), "", ...this.#middle(width, middle), "", ` ${hint}`];
		return lines.map((line) => truncateToWidth(line, width));
	}

	/** What the hint line says, before it is fitted to the width. */
	#hint(tabs: string[]): string[] {
		if (this.#typing) return [this.#multiSelect ? "enter done" : "enter send", "↑↓ move", "esc cancel"];
		const pick = this.#multiSelect ? `space/1-${this.#rows} toggle` : `1-${this.#rows} pick`;
		return [...tabs, "↑↓ move", pick, "enter select", "esc cancel"];
	}

	/** The options, and the preview of the one with the cursor beside or under them, in `rows` rows when it can. */
	#middle(width: number, rows: number): string[] {
		const previews = this.#options.flatMap((option) => (option.preview === undefined ? [] : [option.preview]));
		if (this.#multiSelect || previews.length === 0) return this.#optionRows(width);
		const longest = Math.max(
			visibleWidth(PREVIEW_HINT),
			...previews.flatMap((preview) => previewLines(preview).map((line) => visibleWidth(line))),
		);
		const listWidth = this.#listWidth();
		const beside = width - listWidth - PREVIEW_GAP - PANEL_FRAME;
		const options = this.#optionRows(width);
		if (beside >= Math.min(longest, PREVIEW_ROOM)) {
			// Beside the panel the descriptions go under the labels: only when that takes no rows the screen lacks.
			const list = this.#optionRows(listWidth);
			const room = Math.max(list.length, rows);
			if (list.length <= Math.max(rows, options.length) && room >= PANEL_LEAST) {
				const panel = this.#panel(Math.min(longest, beside), room);
				return Array.from({ length: Math.max(list.length, panel.length) }, (_, row) => {
					const left = list[row] ?? "";
					const right = panel[row];
					if (right === undefined) return left;
					return `${left}${" ".repeat(Math.max(0, listWidth - visibleWidth(left)) + PREVIEW_GAP)}${right}`;
				});
			}
		}
		// Under the options, after a blank row; left out when not even its borders and one row fit.
		const room = rows - options.length - 1;
		if (room < PANEL_LEAST) return options;
		const panel = this.#panel(Math.min(longest, Math.max(1, width - 1 - PANEL_FRAME)), room);
		return [...options, "", ...panel.map((line) => ` ${line}`)];
	}

	/**
	 * The columns of the options' rows with their descriptions under them: up to the `Recommended` tag, and at least
	 * `Type something…`, or the draft typed there with the cursor after it, whole.
	 */
	#listWidth(): number {
		const column = Math.max(0, ...this.#options.map((option) => visibleWidth(option.label)));
		const tagged = this.#options.some((option) => option.recommended);
		const typed = this.#text === "" ? visibleWidth(TYPE_SOMETHING) : visibleWidth(visibleText(this.#text).text) + 1;
		return this.#indent + Math.max(column + (tagged ? visibleWidth(RECOMMENDED) + 2 : 0), typed);
	}

	/**
	 * The panel of the preview of the row with the cursor, `content` columns inside, in `rows` rows its borders included:
	 * as tall as the tallest preview when they leave room for it.
	 */
	#panel(content: number, rows: number): string[] {
		const tallest = Math.max(
			1,
			...this.#options.map((option) =>
				option.preview === undefined ? 1 : previewRows(option.preview, content).length,
			),
		);
		const height = Math.min(tallest, rows - 2);
		const width = content + PANEL_FRAME;
		if (this.#cursor === undefined)
			return previewPanel({ rows: [this.#paint("dim", PREVIEW_HINT)], width, height }, this.#paint);
		const option = this.#options[this.#cursor];
		const title = `${this.#cursor + 1}. ${option?.label ?? TYPE_SOMETHING}`;
		const shown =
			option?.preview === undefined ? [this.#paint("dim", NO_PREVIEW)] : previewRows(option.preview, content);
		return previewPanel({ title, rows: shown, width, height }, this.#paint);
	}

	/**
	 * `❯ 1. English  Recommended   description`, one option after another, then `Type something…`; a multi-select
	 * question's rows have their box after the number, and `Next →` or `Submit` comes last.
	 */
	#optionRows(width: number): string[] {
		const paint = this.#paint;
		const labels = this.#options.map((option) => visibleWidth(option.label));
		const column = Math.max(0, ...labels);
		const tagged = this.#options.some((option) => option.recommended);
		const tagColumn = tagged ? visibleWidth(RECOMMENDED) + 2 : 0;
		const indent = this.#indent;
		const left = indent + column + 2 + tagColumn + 1;
		const longest = Math.max(0, ...this.#options.map((option) => visibleWidth(option.description ?? "")));
		const beside = width - left >= Math.min(DESCRIPTION_ROOM, longest) && longest > 0 && column <= width / 3;
		const room = Math.max(1, width - indent);
		const rows = this.#options.flatMap((option, index) => {
			const head = `${this.#lead(index)}${this.#box(this.#checked.has(index))}`;
			const label = index === this.#cursor ? paint(["bold", "cyan"], option.label) : option.label;
			const tag = option.recommended ? paint(["dim", "cyan"], RECOMMENDED) : "";
			if (beside) {
				const pad = " ".repeat(column - visibleWidth(option.label) + 2);
				const tagWidth = option.recommended ? visibleWidth(RECOMMENDED) : 0;
				const tail = option.description === undefined ? "" : " ".repeat(tagColumn + 1 - tagWidth);
				const [first = "", ...rest] = wrapTextWithAnsi(option.description ?? "", Math.max(1, width - left));
				const description = first === "" ? "" : `${tail}${paint("dim", first)}`;
				return [
					`${head}${label}${pad}${tag}${description}`,
					...rest.map((part) => `${" ".repeat(left)}${paint("dim", part)}`),
				];
			}
			const text = tag === "" ? label : `${label}  ${tag}`;
			const description =
				option.description === undefined ? [] : wrapTextWithAnsi(paint("dim", option.description), room);
			return [
				...wrapTextWithAnsi(text, room).map((part, at) => `${at === 0 ? head : " ".repeat(indent)}${part}`),
				...description.map((part) => `${" ".repeat(indent)}${part}`),
			];
		});
		const other = `${this.#lead(this.#options.length)}${this.#box(this.#otherChecked)}${this.#shownText(room)}`;
		return [...rows, other, ...(this.#multiSelect ? [this.#nextRow()] : [])];
	}

	/** A multi-select question's box, `[✓] ` when checked, `[ ] ` otherwise; nothing for a single-choice question. */
	#box(checked: boolean): string {
		if (!this.#multiSelect) return "";
		return checked ? `[${this.#paint("green", "✓")}] ` : "[ ] ";
	}

	/** `Next →`, or `Submit`, under the boxes, with the cursor when it is there. */
	#nextRow(): string {
		const label = this.#last ? SUBMIT : NEXT;
		const on = this.#cursor === this.#rows;
		return ` ${on ? this.#paint("cyan", "❯") : " "}    ${on ? this.#paint(["bold", "cyan"], label) : label}`;
	}

	/** `Type something…`, or the text typed there with the cursor in it, cut so the cursor stays in sight. */
	#shownText(room: number): string {
		const paint = this.#paint;
		if (!this.#typing)
			return this.#text === "" ? TYPE_SOMETHING : truncateToWidth(visibleText(this.#text).text, room, "…");
		if (this.#text === "") return `${paint("inverse", "T")}${paint("dim", TYPE_SOMETHING.slice(1))}`;
		const { before, under, after } = shownAround(this.#text, this.#at);
		const left = tailFit(before, Math.max(0, room - visibleWidth(under)));
		const right = truncateToWidth(after, Math.max(0, room - visibleWidth(left) - visibleWidth(under)), "…");
		return `${left}${paint("inverse", under)}${right}`;
	}

	/** ` ❯ 1. ` on the cursor's row, `   1. ` on the others. */
	#lead(row: number): string {
		const cursor = row === this.#cursor ? this.#paint("cyan", "❯") : " ";
		return ` ${cursor} ${this.#paint("dim", `${row + 1}.`)} `;
	}
}
