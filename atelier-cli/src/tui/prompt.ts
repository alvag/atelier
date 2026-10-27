import {
	type Component,
	Editor,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Paint, Shade } from "./style.ts";

/** What goes before the first line of a prompt, and the indent of the rest. */
const MARK = "› ";
const INDENT = "  ";
/** What the empty editor says, dimmed. */
const PLACEHOLDER = "Ask Atelier to do anything";
/** Starts the rows the editor draws as borders, so that its band tells them from what was typed. */
const BORDER = "\x1b_atelier:border\x07";

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

/**
 * The editor, as Codex shows its input: a band on the shade with a shaded row above and below instead of the lines,
 * `› ` before the first line and a dimmed placeholder while it is empty. The list of completions goes under the band,
 * lined up with the text. Without the shade, the editor as pi-tui draws it.
 */
export class PromptEditor extends Editor {
	readonly #paint: Paint;
	readonly #shade: Shade;
	constructor(tui: TUI, theme: EditorTheme, paint: Paint, shade: Shade) {
		super(tui, theme);
		this.#paint = paint;
		this.#shade = shade;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.#shade.on) return super.renderTopBorder(width, hiddenLineCount);
		return this.#border("↑", hiddenLineCount);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (!this.#shade.on) return super.renderBottomBorder(width, hiddenLineCount);
		return this.#border("↓", hiddenLineCount);
	}

	/** A shaded row, which says how many lines are out of sight above or below when some are. */
	#border(direction: string, hiddenLineCount: number): string {
		return `${BORDER}${hiddenLineCount > 0 ? this.#paint("dim", `${direction} ${hiddenLineCount} more`) : ""}`;
	}

	override render(width: number): string[] {
		if (!this.#shade.on) return super.render(width);
		const lines = super.render(Math.max(1, width - MARK.length));
		const empty = this.getText() === "";
		let borders = 0;
		let first = true;
		return lines.map((line) => {
			if (borders === 2) return `${INDENT}${line}`;
			if (line.startsWith(BORDER)) {
				borders++;
				return this.#band(`${INDENT}${line.slice(BORDER.length)}`, width);
			}
			const text = first && empty ? `${line.trimEnd()}${this.#paint("dim", PLACEHOLDER)}` : line;
			const row = `${first ? this.#paint("bold", MARK) : INDENT}${text}`;
			first = false;
			return this.#band(row, width);
		});
	}

	/** The pointer over the text is where the text is, after the mark. */
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.#shade.on) return super.handleMouse(event);
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - MARK.length),
			width: Math.max(1, event.width - MARK.length),
		});
	}

	#band(row: string, width: number): string {
		return this.#shade.paint(padded(visibleWidth(row) > width ? truncateToWidth(row, width, "") : row, width));
	}
}
