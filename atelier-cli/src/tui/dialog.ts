import {
	type Component,
	type Focusable,
	Input,
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

/**
 * Drops what is pasted from the terminal's input: what lies between a paste's start marker and its end marker, which
 * may arrive in different chunks of input. Feeding it every chunk also tells whether a paste is open.
 */
export class PasteFilter {
	/** Between a paste's start marker and its end marker. */
	pasting = false;
	/** The end of a chunk that may be the start of a marker, kept until the next chunk says. */
	#pending = "";

	/** The keys in `data`, without what was pasted. */
	feed(data: string): string {
		let rest = this.#pending + data;
		this.#pending = "";
		let keys = "";
		while (rest !== "") {
			if (this.pasting) {
				const end = rest.indexOf(PASTE_END);
				if (end === -1) {
					// Everything in a paste is dropped; only a cut end marker is kept.
					this.#pending = rest.slice(rest.length - partialMarker(rest, PASTE_END, 1));
					break;
				}
				rest = rest.slice(end + PASTE_END.length);
				this.pasting = false;
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
			this.pasting = true;
		}
		return keys;
	}
}

export interface Choice<T extends string> {
	value: T;
	label: string;
	/** Shown dimmed after the label. */
	description?: string;
}

/** What a folded question shows: lines of one row each, and how many lines of the whole question it leaves out. */
export interface Folded {
	lines: readonly string[];
	hidden: number;
}

/**
 * A question with a list of answers, in a frame: `┌ title ─┐`, the question's lines, then the choices. The answer
 * selected at first is `initial`; Esc gives `cancel`. Text pasted into it answers nothing: only keys move or choose.
 * With `folded`, it shows that short form until `toggle()` opens the whole question. With `guardMs`, the keys that
 * arrive that long after `reveal()` are dropped, so a key typed before the question appeared does not answer it.
 */
export class ChoiceDialog<T extends string> implements Component, Focusable {
	focused = false;
	readonly #title: string;
	readonly #lines: readonly string[];
	readonly #list: SelectList;
	readonly #paint: Paint;
	readonly #folded: Folded | undefined;
	#open = false;
	readonly #guardMs: number;
	#revealedAt: number | undefined;
	readonly #paste: PasteFilter;

	constructor(
		options: {
			title: string;
			lines: readonly string[];
			choices: readonly Choice<T>[];
			initial: T;
			cancel: T;
			/** How many choices are shown at once; all of them by default. */
			rows?: number;
			folded?: Folded;
			guardMs?: number;
			/** The filter that followed the input before this question appeared; one of its own by default. */
			paste?: PasteFilter;
		},
		paint: Paint,
		answer: (value: T) => void,
	) {
		this.#title = options.title;
		this.#lines = options.lines;
		this.#paint = paint;
		this.#folded = options.folded;
		this.#guardMs = options.guardMs ?? 0;
		this.#paste = options.paste ?? new PasteFilter();
		const items = options.choices.map(({ value, label, description }) => ({
			value,
			label,
			...(description === undefined ? {} : { description }),
		}));
		this.#list = new SelectList(items, Math.min(items.length, options.rows ?? items.length), selectListTheme(paint));
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

	/** Starts the guard: called when the question is put on screen. */
	reveal(now = Date.now()): void {
		this.#revealedAt ??= now;
	}

	/** Opens the whole question, or folds it again; false when there is nothing folded. */
	toggle(): boolean {
		if (this.#folded === undefined) return false;
		this.#open = !this.#open;
		return true;
	}

	#guarded(): boolean {
		return this.#revealedAt !== undefined && Date.now() - this.#revealedAt < this.#guardMs;
	}

	handleInput(data: string): void {
		const keys = this.#paste.feed(data);
		if (keys !== "" && !this.#guarded()) this.#list.handleInput(keys);
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
		const body =
			this.#folded !== undefined && !this.#open
				? foldedRows(this.#folded, inner)
				: this.#lines.flatMap((line) => wrapTextWithAnsi(line, inner));
		return [
			truncateToWidth(top, width),
			...body.map(row),
			...this.#list.render(inner).map(row),
			truncateToWidth(paint("yellow", `└${"─".repeat(Math.max(0, width - 2))}┘`), width),
		];
	}
}

/** The folded lines, one row each; the last one says what is left out and that Ctrl+O shows it. */
function foldedRows(folded: Folded, width: number): string[] {
	const cut = folded.lines.some((line) => visibleWidth(line) > width);
	const note =
		folded.hidden > 0
			? ` … ${folded.hidden} more ${folded.hidden === 1 ? "line" : "lines"} (Ctrl+O)`
			: cut
				? " (Ctrl+O)"
				: "";
	return folded.lines.map((line, index) => {
		if (index !== folded.lines.length - 1 || note === "") return truncateToWidth(line, width, "…");
		return truncateToWidth(line, Math.max(1, width - visibleWidth(note)), "…") + note;
	});
}

/**
 * A secret typed without showing it, in a frame like a question's: only how many characters it has so far. Typing,
 * pasting and editing are the input line's; Enter answers what was typed, Esc answers nothing.
 */
export class SecretDialog implements Component, Focusable {
	focused = false;
	readonly #title: string;
	readonly #paint: Paint;
	readonly #input = new Input();

	constructor(title: string, paint: Paint, answer: (value: string | undefined) => void) {
		this.#title = title;
		this.#paint = paint;
		this.#input.onSubmit = (value) => answer(value);
		this.#input.onEscape = () => answer(undefined);
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}

	/** As a question's: nothing to guard, since a key typed early only adds a character the frame counts. */
	reveal(): void {}

	/** Nothing is folded: Ctrl+O opens the cards instead. */
	toggle(): boolean {
		return false;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = this.#paint;
		const inner = Math.max(1, width - 4);
		const title = truncateToWidth(` ${this.#title} `, inner);
		const fill = Math.max(0, width - 2 - visibleWidth(title));
		const typed = Array.from(this.#input.getValue()).length;
		const line = truncateToWidth(
			`${typed} ${typed === 1 ? "character" : "characters"} (hidden) · Enter saves · Esc cancels`,
			inner,
			"…",
			true,
		);
		return [
			truncateToWidth(paint("yellow", `┌${title}${"─".repeat(fill)}┐`), width),
			`${paint("yellow", "│")} ${line} ${paint("yellow", "│")}`,
			truncateToWidth(paint("yellow", `└${"─".repeat(Math.max(0, width - 2))}┘`), width),
		];
	}
}

/**
 * A line to paste: the URL a browser sign-in ended on. Unlike a secret, it shows what was typed; it closes by itself
 * when the browser finishes first.
 */
export class PasteDialog implements Component, Focusable {
	focused = false;
	readonly #title: string;
	readonly #paint: Paint;
	readonly #input = new Input();

	constructor(title: string, paint: Paint, answer: (value: string | undefined) => void) {
		this.#title = title;
		this.#paint = paint;
		this.#input.onSubmit = (value) => answer(value);
		this.#input.onEscape = () => answer(undefined);
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}

	reveal(): void {}

	toggle(): boolean {
		return false;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = this.#paint;
		const inner = Math.max(1, width - 4);
		const title = truncateToWidth(` ${this.#title} `, inner);
		const fill = Math.max(0, width - 2 - visibleWidth(title));
		const hint = truncateToWidth(
			"Finish in the browser, or paste the URL it ends on · Enter sends · Esc cancels",
			inner,
		);
		const typed = this.#input.getValue();
		// The end of a long URL is what changes as it is typed or pasted.
		const shown = typed.length > inner - 2 ? `…${typed.slice(typed.length - (inner - 3))}` : typed;
		const line = (text: string) =>
			`${paint("yellow", "│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${paint("yellow", "│")}`;
		return [
			truncateToWidth(paint("yellow", `┌${title}${"─".repeat(fill)}┐`), width),
			line(hint),
			line(`> ${shown}`),
			truncateToWidth(paint("yellow", `└${"─".repeat(Math.max(0, width - 2))}┘`), width),
		];
	}
}
