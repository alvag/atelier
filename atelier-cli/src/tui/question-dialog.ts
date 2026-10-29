import { visibleText } from "@atelier/core";
import {
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PasteFilter } from "./dialog.ts";
import type { Paint } from "./style.ts";

/** An option as the dialog shows it: text already made safe to show. */
export interface QuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

/** What the user did: picked the option at that index, sent their own text, or cancelled. */
export type QuestionAnswer = { option: number } | { other: string } | "cancel";

const TYPE_SOMETHING = "Type something…";
/** The longest text an `ask_user` answer of the user's own words may have. */
const OTHER_MAX = 2000;
const RECOMMENDED = "Recommended";
/** `❯ 1. `, with the space before it: the columns before a label. */
const LEAD = 6;
/** The fewest columns a description gets beside its label, unless it fits in fewer. */
const DESCRIPTION_ROOM = 40;

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
 */
export class QuestionDialog implements Component, Focusable {
	focused = false;
	readonly #question: string;
	readonly #tabs: boolean;
	readonly #options: readonly QuestionOption[];
	readonly #paint: Paint;
	readonly #guardMs: number;
	readonly #paste: PasteFilter;
	readonly #answer: (answer: QuestionAnswer) => void;
	#revealedAt: number | undefined;
	/** The row of the cursor, none until a key puts it on one; the last row is `Type something…`. */
	#cursor: number | undefined;
	#answered = false;
	/** What the user typed on `Type something…`, and where the text cursor is in it, in characters. */
	#text = "";
	#at = 0;
	/** Why Enter sent nothing, said in the hint line until the next key. */
	#problem = "";

	constructor(
		options: {
			question: string;
			options: readonly QuestionOption[];
			/** Whether it is one tab of a batch: the hint line says ←→ moves among them. */
			tabs?: boolean;
			guardMs?: number;
			/** The filter that followed the input before this question appeared; one of its own by default. */
			paste?: PasteFilter;
		},
		paint: Paint,
		answer: (answer: QuestionAnswer) => void,
	) {
		this.#question = options.question;
		this.#tabs = options.tabs ?? false;
		this.#options = options.options;
		this.#paint = paint;
		this.#guardMs = options.guardMs ?? 0;
		this.#paste = options.paste ?? new PasteFilter();
		this.#answer = answer;
	}

	/** The options' rows and `Type something…`. */
	get #rows(): number {
		return this.#options.length + 1;
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

	#choose(row: number): void {
		this.#answered = true;
		this.#answer({ option: row });
	}

	/** Sends the text typed, unless it is blank or too long: then the hint line says why. */
	#send(): void {
		if (this.#text.trim() === "") this.#problem = "Type an answer, or esc to cancel";
		else if (this.#text.length > OTHER_MAX) this.#problem = `Too long: ${this.#text.length} of ${OTHER_MAX} characters`;
		else {
			this.#answered = true;
			this.#answer({ other: this.#text });
		}
	}

	#insert(text: string): void {
		const chars = characters(this.#text);
		const added = characters(text);
		this.#text = [...chars.slice(0, this.#at), ...added, ...chars.slice(this.#at)].join("");
		this.#at += added.length;
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
		} else if (matchesKey(keys, "delete"))
			this.#text = [...chars.slice(0, this.#at), ...chars.slice(this.#at + 1)].join("");
		// Typed text, a character or a burst of them; any other key is not text.
		else if (isText(keys)) this.#insert(keys);
		else return false;
		return true;
	}

	handleInput(data: string): void {
		if (this.#answered) return;
		const guarded = this.#guarded();
		this.#problem = "";
		// Keys and pastes in the order they came: a paste goes into the text only when it starts there, never into an
		// option, and nothing after the answer counts.
		this.#paste.read(data, {
			keys: (keys) => {
				if (!guarded && !this.#answered) this.#key(keys);
			},
			keep: () => !guarded && !this.#answered && this.#typing,
			pasted: (text) => {
				if (!guarded && !this.#answered && this.#typing) this.#insert(text.replace(/\r\n?/g, "\n"));
			},
		});
	}

	#key(keys: string): void {
		if (matchesKey(keys, "escape")) {
			this.#answered = true;
			this.#answer("cancel");
			return;
		}
		if (matchesKey(keys, "up") || matchesKey(keys, "down")) {
			const step = matchesKey(keys, "up") ? -1 : 1;
			this.#cursor =
				this.#cursor === undefined
					? step === 1
						? 0
						: this.#rows - 1
					: (this.#cursor + step + this.#rows) % this.#rows;
			return;
		}
		if (matchesKey(keys, "enter")) {
			if (this.#typing) this.#send();
			else if (this.#cursor !== undefined) this.#choose(this.#cursor);
			return;
		}
		if (this.#typing && this.#edit(keys)) return;
		if (/^[1-9]$/.test(keys)) {
			const row = Number(keys) - 1;
			if (row >= this.#rows) return;
			this.#cursor = row;
			// A number on Type something puts the cursor there, to type.
			if (row < this.#options.length) this.#choose(row);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rule = this.#paint("cyan", "─".repeat(Math.max(1, width)));
		return [rule, ...this.body(width), rule];
	}

	/** What goes between the rules: the question, its options and the hint line. */
	body(width: number): string[] {
		const paint = this.#paint;
		const room = Math.max(1, width - 1);
		const question = wrapTextWithAnsi(paint("bold", this.#question), room);
		const tabs = this.#tabs ? ["←→ tabs"] : [];
		const hint =
			this.#problem !== ""
				? paint("yellow", truncateToWidth(this.#problem, room, "…"))
				: paint(
						"dim",
						this.#typing
							? fitHint(["enter send", "↑↓ move", "esc cancel"], room)
							: fitHint([...tabs, "↑↓ move", `1-${this.#rows} pick`, "enter select", "esc cancel"], room),
					);
		const lines = [...question.map((line) => ` ${line}`), "", ...this.#optionRows(width), "", ` ${hint}`];
		return lines.map((line) => truncateToWidth(line, width));
	}

	/** `❯ 1. English  Recommended   description`, one option after another, then `Type something…`. */
	#optionRows(width: number): string[] {
		const paint = this.#paint;
		const labels = this.#options.map((option) => visibleWidth(option.label));
		const column = Math.max(0, ...labels);
		const tagged = this.#options.some((option) => option.recommended);
		const tagColumn = tagged ? visibleWidth(RECOMMENDED) + 2 : 0;
		const left = LEAD + column + 2 + tagColumn + 1;
		const longest = Math.max(0, ...this.#options.map((option) => visibleWidth(option.description ?? "")));
		const beside = width - left >= Math.min(DESCRIPTION_ROOM, longest) && longest > 0 && column <= width / 3;
		const room = Math.max(1, width - LEAD);
		const rows = this.#options.flatMap((option, index) => {
			const head = this.#lead(index);
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
				...wrapTextWithAnsi(text, room).map((part, at) => `${at === 0 ? head : " ".repeat(LEAD)}${part}`),
				...description.map((part) => `${" ".repeat(LEAD)}${part}`),
			];
		});
		return [...rows, `${this.#lead(this.#options.length)}${this.#typed(Math.max(1, width - LEAD))}`];
	}

	/** `Type something…`, or the text typed there with the cursor in it, cut so the cursor stays in sight. */
	#typed(room: number): string {
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
