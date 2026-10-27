import { styleText } from "node:util";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
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

export function editorTheme(paint: Paint): EditorTheme {
	return { borderColor: (text) => paint("dim", text), selectList: selectListTheme(paint) };
}
