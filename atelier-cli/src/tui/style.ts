import { styleText } from "node:util";
import {
	backgroundAnsi,
	type Color,
	colorToOklch,
	type EditorTheme,
	type MarkdownTheme,
	mixColors,
	type RgbColor,
	rgbColor,
	type SelectListTheme,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.ts";

export type Style = Parameters<typeof styleText>[0];

/** Styles text for the terminal, or leaves it plain without color. */
export type Paint = (style: Style, text: string) => string;

export const painter =
	(color: boolean): Paint =>
	(style, text) =>
		color ? styleText(style, text) : text;

export function markdownTheme(paint: Paint): MarkdownTheme {
	return {
		heading: (text) => paint(["bold", "cyan"], text),
		link: (text) => paint("underline", text),
		linkUrl: (text) => paint("dim", text),
		code: (text) => paint("yellow", text),
		codeBlock: (text) => text,
		codeBlockBorder: (text) => paint("dim", text),
		highlightCode: (code, lang) => highlightCode(paint, code, lang),
		quote: (text) => paint("italic", text),
		quoteBorder: (text) => paint("dim", text),
		hr: (text) => paint("dim", text),
		listBullet: (text) => paint("cyan", text),
		bold: (text) => paint("bold", text),
		italic: (text) => paint("italic", text),
		strikethrough: (text) => paint("strikethrough", text),
		underline: (text) => paint("underline", text),
	};
}

export function selectListTheme(paint: Paint): SelectListTheme {
	return {
		selectedPrefix: (text) => paint("cyan", text),
		selectedText: (text) => paint(["bold", "cyan"], text),
		description: (text) => paint("dim", text),
		scrollInfo: (text) => paint("dim", text),
		noMatch: (text) => paint("dim", text),
	};
}

/** The palette's bright black: the shade until the terminal says its own background, or when it never does. */
const FALLBACK_SHADE = "\x1b[100m";
const DEFAULT_BACKGROUND = "\x1b[49m";
/** A reset inside a shaded line, after which the shade is set again. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the resets are what is matched
const BACKGROUND_RESET = /\x1b\[(?:0|49)?m/g;

/** The terminal's background a little lighter, or a little darker on a light terminal. */
export function shadeOf(background: RgbColor): Color {
	const base = rgbColor(background.r, background.g, background.b);
	const dark = colorToOklch(base).l < 0.5;
	return dark ? mixColors(base, rgbColor(255, 255, 255), 0.1) : mixColors(base, rgbColor(0, 0, 0), 0.05);
}

/**
 * The subtle background of the user's prompts and of the editor, as Codex shows them: none without color, the
 * palette's bright black at first, and the terminal's own background shaded once it says it.
 */
export class Shade {
	#ansi: string | undefined;
	constructor(color: boolean) {
		this.#ansi = color ? FALLBACK_SHADE : undefined;
	}

	get on(): boolean {
		return this.#ansi !== undefined;
	}

	/** Shades the background the terminal reported, in the colors it takes; without color it stays off. */
	match(background: RgbColor | undefined, mode: TerminalColorMode): void {
		if (this.#ansi === undefined || background === undefined) return;
		this.#ansi = backgroundAnsi(shadeOf(background), mode);
	}

	/** `line` on the shade, kept after every reset inside it. */
	paint(line: string): string {
		const ansi = this.#ansi;
		if (ansi === undefined) return line;
		return `${ansi}${line.replace(BACKGROUND_RESET, (reset) => `${reset}${ansi}`)}${DEFAULT_BACKGROUND}`;
	}
}

export function editorTheme(paint: Paint): EditorTheme {
	return { borderColor: (text) => paint("dim", text), selectList: selectListTheme(paint) };
}
