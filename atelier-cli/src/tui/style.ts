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

/** Whether `paint` styles anything: without color, it gives text back as it is. */
export const hasColor = (paint: Paint): boolean => paint("bold", "x") !== "x";

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
		return this.#ansi === undefined ? line : onBackground(this.#ansi, line);
	}
}

/** How far a card's background moves from the terminal's, and how much red or green a diff's band takes, on a dark and a light terminal. */
const CARD_MIX = { dark: 0.06, light: 0.03 };
const BAND_MIX = { dark: 0.22, light: 0.15 };
const RED = rgbColor(220, 50, 47);
const GREEN = rgbColor(40, 160, 60);

/** `line` on the background `ansi`, kept after every reset inside it. */
const onBackground = (ansi: string, line: string) =>
	`${ansi}${line.replace(BACKGROUND_RESET, (reset) => `${reset}${ansi}`)}${DEFAULT_BACKGROUND}`;

export type Band = "removed" | "added";

/**
 * The backgrounds of the tool cards, made from the terminal's own once it says it: the card's, a little lighter (or
 * darker on a light terminal) and subtler than the prompt's shade, and a diff's bands, red and green. Until then, when
 * the terminal never says it, and without color, there are none.
 */
export class Tones {
	readonly #color: boolean;
	#ansi: { card: string; removed: string; added: string } | undefined;

	constructor(color: boolean) {
		this.#color = color;
	}

	get on(): boolean {
		return this.#ansi !== undefined;
	}

	/** Makes the backgrounds from the one the terminal reported, in the colors it takes. */
	match(background: RgbColor | undefined, mode: TerminalColorMode): void {
		if (!this.#color || background === undefined) return;
		const base = rgbColor(background.r, background.g, background.b);
		const dark = colorToOklch(base).l < 0.5;
		const toward = dark ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
		const band = dark ? BAND_MIX.dark : BAND_MIX.light;
		this.#ansi = {
			card: backgroundAnsi(mixColors(base, toward, dark ? CARD_MIX.dark : CARD_MIX.light), mode),
			removed: backgroundAnsi(mixColors(base, RED, band), mode),
			added: backgroundAnsi(mixColors(base, GREEN, band), mode),
		};
	}

	/** `line` on the card's background, or as it is without one. */
	card(line: string): string {
		return this.#ansi === undefined ? line : onBackground(this.#ansi.card, line);
	}

	/** `line` on a diff's red or green band, or as it is without one. */
	band(band: Band, line: string): string {
		return this.#ansi === undefined ? line : onBackground(this.#ansi[band], line);
	}
}

export function editorTheme(paint: Paint): EditorTheme {
	return { borderColor: (text) => paint("dim", text), selectList: selectListTheme(paint) };
}
