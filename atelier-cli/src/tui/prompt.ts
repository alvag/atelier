import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint, Shade } from "./style.ts";

/** What goes before the first line of a prompt, and the indent of the rest. */
const MARK = "› ";
const INDENT = "  ";

/** `line` padded with spaces to `width` columns. */
export const padded = (line: string, width: number) => `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;

/**
 * The user's prompt, as Codex shows it: a full-width block on the shade, a shaded row above and below, `› ` before
 * its first line and every other line lined up under it.
 */
export class PromptBlock implements Component {
	readonly #text: string;
	readonly #paint: Paint;
	readonly #shade: Shade;
	constructor(text: string, paint: Paint, shade: Shade) {
		this.#text = text;
		this.#paint = paint;
		this.#shade = shade;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const wrapped = this.#text
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - MARK.length - 1)));
		const lines = wrapped.map((line, index) => `${index === 0 ? this.#paint("bold", MARK) : INDENT}${line}`);
		return ["", ...lines, ""].map((line) => this.#shade.paint(padded(line, width)));
	}
}
