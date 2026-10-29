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

/** What the user did: picked the option at that index, chose to type their own answer, or cancelled. */
export type QuestionAnswer = { option: number } | "other" | "cancel";

const TYPE_SOMETHING = "Type something…";
const RECOMMENDED = "Recommended";
/** `❯ 1. `, with the space before it: the columns before a label. */
const LEAD = 6;
/** The fewest columns a description gets beside its label, unless it fits in fewer. */
const DESCRIPTION_ROOM = 40;

/** The hint's parts in the order they are dropped when it does not fit: the first goes first. */
const dropOrder = ["enter select", "↑↓ move"];

/** The parts of `parts` that fit in `width`, joined, dropping the least needed first; cut as a last resort. */
function fitHint(parts: readonly string[], width: number): string {
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
 * and Enter answers it; a number key answers its row at once. With `guardMs`, the keys that arrive that long after
 * `reveal()` are dropped, so a key typed before the question appeared does not answer it; pasted text answers nothing.
 */
export class QuestionDialog implements Component, Focusable {
	focused = false;
	readonly #question: string;
	readonly #title: string | undefined;
	readonly #options: readonly QuestionOption[];
	readonly #paint: Paint;
	readonly #guardMs: number;
	readonly #paste: PasteFilter;
	readonly #answer: (answer: QuestionAnswer) => void;
	#revealedAt: number | undefined;
	/** The row of the cursor, none until a key puts it on one; the last row is `Type something…`. */
	#cursor: number | undefined;
	#answered = false;

	constructor(
		options: {
			question: string;
			options: readonly QuestionOption[];
			/** A line over the question, such as where it is in its batch. */
			title?: string;
			guardMs?: number;
			/** The filter that followed the input before this question appeared; one of its own by default. */
			paste?: PasteFilter;
		},
		paint: Paint,
		answer: (answer: QuestionAnswer) => void,
	) {
		this.#question = options.question;
		this.#title = options.title;
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

	/** Starts the guard: called when the question is put on screen. */
	reveal(now = Date.now()): void {
		this.#revealedAt ??= now;
	}

	/** The question is already whole: Ctrl+O has nothing to open, and opens no card behind it. */
	toggle(): boolean {
		return true;
	}

	#guarded(): boolean {
		return this.#revealedAt !== undefined && Date.now() - this.#revealedAt < this.#guardMs;
	}

	#choose(row: number): void {
		this.#answered = true;
		this.#answer(row < this.#options.length ? { option: row } : "other");
	}

	handleInput(data: string): void {
		const keys = this.#paste.feed(data);
		if (this.#answered || keys === "" || this.#guarded()) return;
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
			if (this.#cursor !== undefined) this.#choose(this.#cursor);
			return;
		}
		if (/^[1-9]$/.test(keys)) {
			const row = Number(keys) - 1;
			if (row < this.#rows) {
				this.#cursor = row;
				this.#choose(row);
			}
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = this.#paint;
		const room = Math.max(1, width - 1);
		const rule = paint("cyan", "─".repeat(Math.max(1, width)));
		const title = this.#title === undefined ? [] : wrapTextWithAnsi(paint("dim", this.#title), room);
		const question = wrapTextWithAnsi(paint("bold", this.#question), room);
		const hint = fitHint(["↑↓ move", `1-${this.#rows} pick`, "enter select", "esc cancel"], room);
		const lines = [
			rule,
			...[...title, ...question].map((line) => ` ${line}`),
			"",
			...this.#optionRows(width),
			"",
			` ${paint("dim", hint)}`,
			rule,
		];
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
		const other = this.#options.length;
		const typed = other === this.#cursor ? paint(["bold", "cyan"], TYPE_SOMETHING) : TYPE_SOMETHING;
		return [...rows, `${this.#lead(other)}${typed}`];
	}

	/** ` ❯ 1. ` on the cursor's row, `   1. ` on the others. */
	#lead(row: number): string {
		const cursor = row === this.#cursor ? this.#paint("cyan", "❯") : " ";
		return ` ${cursor} ${this.#paint("dim", `${row + 1}.`)} `;
	}
}
