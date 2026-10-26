import {
	type Component,
	type Focusable,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Paint, selectListTheme } from "./style.ts";

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
		if (data.startsWith("\x1b[200~")) return;
		this.#list.handleInput(data);
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
