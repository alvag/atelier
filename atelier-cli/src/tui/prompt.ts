import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	getKeybindings,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PROMPT_HISTORY_LIMIT } from "./prompt-history.ts";
import type { Paint, Shade } from "./style.ts";

/** What goes before the first line of a prompt, and the indent of the rest. */
const MARK = "› ";
const INDENT = "  ";
/** What the empty editor says, dimmed. */
const PLACEHOLDER = "Ask Atelier to do anything";
/** Starts the rows the editor draws as borders, so that its band tells them from what was typed. */
const BORDER = "\x1b_atelier:border\x07";

/** A command typed after `!`, or after `!!` when the model does not see it; a bare marker is an ordinary prompt. */
export function parseShell(text: string): { command: string; exclude: boolean } | undefined {
	const exclude = text.startsWith("!!");
	const command = text.slice(exclude ? 2 : 1);
	return text.startsWith("!") && command.trim() !== "" ? { command, exclude } : undefined;
}

/** What the editor says under a shell command's draft. */
const SHELL_NOTICE = "Shell · outside sandbox";
const EXCLUDED_NOTICE = " · excluded from context";

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
	readonly #questionOpen: () => boolean;
	#prompts: string[] = [];
	#recalled: number | undefined;
	#editorWidth = 80;
	#hiddenAbove = 0;
	#hiddenBelow = 0;
	/** `questionOpen` says whether a question is open, which puts the editor out of sight. */
	constructor(tui: TUI, theme: EditorTheme, paint: Paint, shade: Shade, questionOpen: () => boolean) {
		super(tui, theme);
		this.#paint = paint;
		this.#shade = shade;
		this.#questionOpen = questionOpen;
		// Edits, including paste, programmatic changes and undo, end recall; cursor movement does not.
		this.onChange = () => {
			this.#recalled = undefined;
		};
	}

	/** Keep Pi's own history empty so it only moves the cursor in an ordinary draft. */
	override addToHistory(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		this.#prompts = [...this.#prompts.filter((prompt) => prompt !== trimmed), trimmed].slice(-PROMPT_HISTORY_LIMIT);
		this.#recalled = undefined;
	}

	#recall(data: string): boolean {
		if (this.isShowingAutocomplete()) return false;
		const keys = getKeybindings();
		const up = keys.matches(data, "tui.editor.cursorUp");
		const down = keys.matches(data, "tui.editor.cursorDown");
		if (!up && !down) return false;
		let index = this.#recalled;
		if (index === undefined) {
			if (!up || this.getText() !== "" || this.#prompts.length === 0) return false;
			index = this.#prompts.length;
		} else if (!this.#atBoundary(up)) return false;
		const next = Math.max(0, Math.min(this.#prompts.length, index + (up ? -1 : 1)));
		if (next === index) return true;
		super.setText(this.#prompts[next] ?? "");
		this.#recalled = next < this.#prompts.length ? next : undefined;
		return true;
	}

	/** Let Pi lay out the cursor, including wrapping and scrolling, using only its public render protocol. */
	#atBoundary(first: boolean): boolean {
		const rows = super.render(this.#editorWidth);
		const cursor = rows.findIndex((row) => row.includes(CURSOR_MARKER));
		return first ? this.#hiddenAbove === 0 && cursor === 1 : this.#hiddenBelow === 0 && cursor === rows.length - 2;
	}

	/**
	 * Out of sight while a question is open: it draws nothing and takes no key or click, so the question keeps them all.
	 * What it holds stays in it and shows again once it is back.
	 */
	get hidden(): boolean {
		return this.#questionOpen();
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.#hiddenAbove = hiddenLineCount;
		if (!this.#shade.on) return super.renderTopBorder(width, hiddenLineCount);
		return this.#border("↑", hiddenLineCount);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.#hiddenBelow = hiddenLineCount;
		if (!this.#shade.on) return super.renderBottomBorder(width, hiddenLineCount);
		return this.#border("↓", hiddenLineCount);
	}

	/** A shaded row, which says how many lines are out of sight above or below when some are. */
	#border(direction: string, hiddenLineCount: number): string {
		return `${BORDER}${hiddenLineCount > 0 ? this.#paint("dim", `${direction} ${hiddenLineCount} more`) : ""}`;
	}

	#before = "";

	/** The text as it stood before the last key, which is what Enter submitted, without the trimming `onSubmit` gets. */
	get untrimmed(): string {
		return this.#before;
	}

	override handleInput(data: string): void {
		if (this.hidden) return;
		this.#before = this.getExpandedText();
		if (!this.#recall(data)) super.handleInput(data);
	}

	override render(width: number): string[] {
		if (this.hidden) return [];
		this.#editorWidth = Math.max(1, width - (this.#shade.on ? MARK.length : 0));
		const shell = parseShell(this.getText());
		const notice =
			shell === undefined
				? []
				: [
						truncateToWidth(
							`${INDENT}${this.#paint("yellow", `${SHELL_NOTICE}${shell.exclude ? EXCLUDED_NOTICE : ""}`)}`,
							width,
							"",
						),
					];
		if (!this.#shade.on) return [...super.render(width), ...notice];
		const lines = super.render(Math.max(1, width - MARK.length));
		const empty = this.getText() === "";
		// The band ends at the bottom border; the rows under it are the completions, lined up with the text.
		const bottom = lines.findLastIndex((line) => line.startsWith(BORDER));
		let first = true;
		const rows = lines.map((line, index) => {
			if (index > bottom) return `${INDENT}${line}`;
			if (line.startsWith(BORDER)) return this.#band(`${INDENT}${line.slice(BORDER.length)}`, width);
			const text = first && empty ? `${line.trimEnd()}${this.#paint("dim", PLACEHOLDER)}` : line;
			const row = `${first ? this.#paint("bold", MARK) : INDENT}${text}`;
			first = false;
			return this.#band(row, width);
		});
		// The notice sits right under the band, over the completions.
		rows.splice(bottom + 1, 0, ...notice);
		return rows;
	}

	/** The pointer over the text is where the text is, after the mark. */
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.hidden) return undefined;
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
