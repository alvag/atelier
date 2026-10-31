import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PromptEditor } from "../src/tui/prompt.ts";
import { editorTheme, painter, Shade } from "../src/tui/style.ts";

const editorFor = (text: string, color: boolean) => {
	const paint = painter(color);
	const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
	const editor = new PromptEditor(tui, editorTheme(paint), paint, new Shade(color), () => false);
	editor.setText(text);
	return editor;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip the notice's ANSI styles before checking its text
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("the shell notice", () => {
	for (const color of [true, false]) {
		for (const [text, full] of [
			["!ls", "Shell · outside sandbox"],
			["!!ls", "Shell · outside sandbox · excluded from context"],
		] as const) {
			for (const width of [80, 40, 20, 12, 7]) {
				it(`fits ${width} columns for ${JSON.stringify(text)} with color ${color ? "on" : "off"}`, () => {
					const lines = editorFor(text, color).render(width);
					const notice = lines.filter((line) => strip(line).trimStart().startsWith("Shell"));
					expect(notice).toHaveLength(1);
					const shown = strip(notice[0] ?? "").trim();
					expect(full.startsWith(shown)).toBe(true);
					if (width === 80) expect(shown).toBe(full);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				});
			}
		}
	}
});
