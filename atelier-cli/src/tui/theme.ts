import { backgroundAnsi, foregroundAnsi, parseColor, type TerminalColorMode } from "@earendil-works/pi-tui";
import { onBackground, onForeground } from "./style.ts";

type Hex = `#${string}`;

/**
 * The colors a theme supplies, each by its use (see docs/theme.md). The aliases are not among them: they take the
 * value of the token they stand for, so no theme can set them apart.
 */
export type Theme = Readonly<{
	background: Hex;
	surface: Hex;
	border: Hex;
	separator: Hex;
	text: Hex;
	textSecondary: Hex;
	brand: Hex;
	focus: Hex;
	success: Hex;
	warning: Hex;
	error: Hex;
	diffAddedBackground: Hex;
	diffRemovedBackground: Hex;
	diffAddedText: Hex;
	diffRemovedText: Hex;
}>;

/** Tokens that stand for another: work in progress is painted as secondary text, always with a symbol. */
const ALIASES = { running: "textSecondary" } as const satisfies Record<string, keyof Theme>;

export type ThemeToken = keyof Theme | keyof typeof ALIASES;

const isAlias = (token: ThemeToken): token is keyof typeof ALIASES => Object.hasOwn(ALIASES, token);

/** The HEX of `token` in `theme`, an alias's being the one of the token it stands for. */
export const hexOf = (theme: Theme, token: ThemeToken): Hex => theme[isAlias(token) ? ALIASES[token] : token];

/** Atelier's dark palette. */
export const atelierDark = {
	background: "#252D33",
	surface: "#2F383F",
	border: "#87939C",
	separator: "#46525B",
	text: "#FFFFFF",
	textSecondary: "#A3ADB5",
	brand: "#E58F72",
	focus: "#B1B9F9",
	success: "#4EBA65",
	warning: "#FFC107",
	error: "#FF7A8C",
	diffAddedBackground: "#225C2B",
	diffRemovedBackground: "#7A2936",
	diffAddedText: "#9FEBB0",
	diffRemovedText: "#FFC2CB",
} as const satisfies Theme;

/** Every theme, by name. */
export const themes = { atelierDark } satisfies Record<string, Theme>;

/** The theme the TUI paints with: the only one for now, with no setting to pick another. */
export const activeTheme: Theme = themes.atelierDark;

/** Paints text or its background with a theme's token, or leaves it plain without color. */
export type Ink = { fg(token: ThemeToken, text: string): string; bg(token: ThemeToken, text: string): string };

/** Paints with `theme` in the colors the terminal takes (`getTerminalColorMode()`), or not at all without `color`. */
export function ink(theme: Theme, color: boolean, mode: TerminalColorMode): Ink {
	const parsed = (token: ThemeToken) => parseColor(hexOf(theme, token));
	return {
		fg: (token, text) => (color ? onForeground(foregroundAnsi(parsed(token), mode), text) : text),
		bg: (token, text) => (color ? onBackground(backgroundAnsi(parsed(token), mode), text) : text),
	};
}
