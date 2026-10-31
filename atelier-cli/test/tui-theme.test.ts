import { describe, expect, it } from "vitest";
import { activeTheme, atelierDark, hexOf, ink, type ThemeToken, themes } from "../src/tui/theme.ts";

const PALETTE: Record<ThemeToken, string> = {
	background: "#252D33",
	surface: "#2F383F",
	border: "#87939C",
	separator: "#46525B",
	text: "#FFFFFF",
	textSecondary: "#A3ADB5",
	running: "#A3ADB5",
	brand: "#E58F72",
	focus: "#B1B9F9",
	success: "#4EBA65",
	warning: "#FFC107",
	error: "#FF7A8C",
	diffAddedBackground: "#225C2B",
	diffRemovedBackground: "#7A2936",
	diffAddedText: "#9FEBB0",
	diffRemovedText: "#FFC2CB",
};

describe("theme", () => {
	it("gives every token of atelierDark its exact HEX", () => {
		for (const [token, hex] of Object.entries(PALETTE))
			expect(hexOf(atelierDark, token as ThemeToken), token).toBe(hex);
	});

	it("is atelierDark today, the one theme there is", () => {
		expect(activeTheme).toBe(atelierDark);
		expect(Object.keys(themes)).toEqual(["atelierDark"]);
	});

	it("paints a token's text in truecolor", () => {
		expect(ink(atelierDark, true, "truecolor").fg("brand", "x")).toBe("\x1b[38;2;229;143;114mx\x1b[39m");
	});

	it("paints a token's text in 256 colors", () => {
		expect(ink(atelierDark, true, "256color").fg("brand", "x")).toBe("\x1b[38;5;173mx\x1b[39m");
	});

	it("paints a token's background in truecolor and in 256 colors", () => {
		expect(ink(atelierDark, true, "truecolor").bg("diffAddedBackground", "x")).toBe("\x1b[48;2;34;92;43mx\x1b[49m");
		expect(ink(atelierDark, true, "256color").bg("diffAddedBackground", "x")).toBe("\x1b[48;5;22mx\x1b[49m");
	});

	it("leaves text as it is without color", () => {
		const plain = ink(atelierDark, false, "truecolor");
		expect(plain.fg("brand", "a \x1b[1mb\x1b[0m")).toBe("a \x1b[1mb\x1b[0m");
		expect(plain.bg("surface", "a b")).toBe("a b");
	});

	it("keeps the background after every reset inside it", () => {
		const on = "\x1b[48;2;47;56;63m";
		expect(ink(atelierDark, true, "truecolor").bg("surface", "a\x1b[0mb\x1b[49mc\x1b[md")).toBe(
			`${on}a\x1b[0m${on}b\x1b[49m${on}c\x1b[m${on}d\x1b[49m`,
		);
	});

	it("keeps the text's color after every reset inside it, so it nests", () => {
		const paint = ink(atelierDark, true, "truecolor");
		const secondary = "\x1b[38;2;163;173;181m";
		const brand = "\x1b[38;2;229;143;114m";
		expect(paint.fg("textSecondary", `a ${paint.fg("brand", "x")} b`)).toBe(
			`${secondary}a ${brand}x\x1b[39m${secondary} b\x1b[39m`,
		);
		expect(paint.fg("textSecondary", "a\x1b[0mb\x1b[mc")).toBe(
			`${secondary}a\x1b[0m${secondary}b\x1b[m${secondary}c\x1b[39m`,
		);
	});

	it("paints running as textSecondary", () => {
		const paint = ink(atelierDark, true, "256color");
		expect(hexOf(atelierDark, "running")).toBe(hexOf(atelierDark, "textSecondary"));
		expect(paint.fg("running", "x")).toBe(paint.fg("textSecondary", "x"));
	});
});
