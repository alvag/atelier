import {
	type Component,
	type Focusable,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Paint, selectListTheme } from "./style.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** The length of the longest end of `text` that begins `marker` without being all of it. */
function partialMarker(text: string, marker: string, least: number): number {
	for (let length = Math.min(marker.length - 1, text.length); length >= least; length--)
		if (marker.startsWith(text.slice(text.length - length))) return length;
	return 0;
}

export interface Choice<T extends string> {
	value: T;
	label: string;
}

/**
 * A question with a list of answers, in a frame: `┌ title ─┐`, the question's lines, then the choices. The answer
 * selected at first is `initial`; Esc gives `cancel`. Text pasted into it answers nothing: only keys move or choose.
 */
export class ChoiceDialog<T extends string> implements Component, Focusable {
	focused = false;
	readonly #title: string;
	readonly #lines: readonly string[];
	readonly #list: SelectList;
	readonly #paint: Paint;
	/** Between a paste's start marker and its end marker, which may arrive in different chunks of input. */
	#pasting = false;
	/** The end of a chunk that may be the start of a marker, kept until the next chunk says. */
	#pending = "";

	constructor(
		options: { title: string; lines: readonly string[]; choices: readonly Choice<T>[]; initial: T; cancel: T },
		paint: Paint,
		answer: (value: T) => void,
	) {
		this.#title = options.title;
		this.#lines = options.lines;
		this.#paint = paint;
		const items = options.choices.map(({ value, label }) => ({ value, label }));
		this.#list = new SelectList(items, items.length, selectListTheme(paint));
		this.#list.setSelectedIndex(
			Math.max(
				0,
				items.findIndex((item) => item.value === options.initial),
			),
		);
		const values = new Set<string>(options.choices.map((choice) => choice.value));
		this.#list.onSelect = (item) => answer(values.has(item.value) ? (item.value as T) : options.cancel);
		this.#list.onCancel = () => answer(options.cancel);
	}

	handleInput(data: string): void {
		let rest = this.#pending + data;
		this.#pending = "";
		let keys = "";
		while (rest !== "") {
			if (this.#pasting) {
				const end = rest.indexOf(PASTE_END);
				if (end === -1) {
					// Everything in a paste is dropped; only a cut end marker is kept.
					this.#pending = rest.slice(rest.length - partialMarker(rest, PASTE_END, 1));
					break;
				}
				rest = rest.slice(end + PASTE_END.length);
				this.#pasting = false;
				continue;
			}
			const start = rest.indexOf(PASTE_START);
			if (start === -1) {
				// A lone Esc is the key, not a cut marker: only "ESC [" and longer wait for the rest.
				const cut = partialMarker(rest, PASTE_START, 2);
				keys += rest.slice(0, rest.length - cut);
				this.#pending = rest.slice(rest.length - cut);
				break;
			}
			keys += rest.slice(0, start);
			rest = rest.slice(start + PASTE_START.length);
			this.#pasting = true;
		}
		if (keys !== "") this.#list.handleInput(keys);
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	render(width: number): string[] {
		const paint = this.#paint;
		const inner = Math.max(1, width - 4);
		const title = truncateToWidth(` ${this.#title} `, inner);
		const fill = Math.max(0, width - 2 - visibleWidth(title));
		const top = paint("yellow", `┌${title}${"─".repeat(fill)}┐`);
		const row = (line: string) => {
			const cut = truncateToWidth(line, inner, "…", true);
			return `${paint("yellow", "│")} ${cut} ${paint("yellow", "│")}`;
		};
		const body = this.#lines.flatMap((line) => wrapTextWithAnsi(line, inner));
		return [
			truncateToWidth(top, width),
			...body.map(row),
			...this.#list.render(inner).map(row),
			truncateToWidth(paint("yellow", `└${"─".repeat(Math.max(0, width - 2))}┘`), width),
		];
	}
}
