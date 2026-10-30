import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { previewPanel, previewRows } from "../src/tui/preview-panel.ts";
import { painter } from "../src/tui/style.ts";

const ST = "\x1b\\";

for (const [name, start] of [
	["APC", "\x1b_"],
	["DCS", "\x1bP"],
] as const) {
	describe(`previewRows ${name}`, () => {
		it("keeps the issue's payload whole at four columns", () => {
			const sequence = `${start}abcdefghijk${ST}`;
			expect(previewRows(sequence, 4)).toEqual([sequence]);
		});

		it("wraps only visible text around the zero-column payload", () => {
			const sequence = `${start}abcdefghijk${ST}`;
			expect(previewRows(`ab${sequence}cdef`, 4)).toEqual([`ab${sequence}cd`, "ef"]);
		});

		it("keeps embedded escapes and BEL in the payload until ST", () => {
			const sequence = `${start}abc\x07def\x1b[31mghi${ST}`;
			expect(previewRows(`ab${sequence}cdef`, 4)).toEqual([`ab${sequence}cd`, "ef"]);
		});

		it("ends each string at its first ST, leaving the text between strings to wrap", () => {
			const first = `${start}first${ST}`;
			const second = `${start}second${ST}`;
			expect(previewRows(`${first}abcde${second}fg`, 4)).toEqual([`${first}abcd`, `e${second}fg`]);
		});

		it("wraps thousands of unterminated introductions as two-character escapes", () => {
			const input = `${start}x`.repeat(8_000);
			const rows = previewRows(input, 40);
			expect(rows).toHaveLength(200);
			expect(rows.join("")).toBe(input);
			for (const row of rows) expect(row.replaceAll(start, "")).toBe("x".repeat(40));
		});
	});

	describe(`previewPanel ${name}`, () => {
		const sequence = `${start}${"payload".repeat(1_000)}${ST}`;
		const panel = (text: string, width = 12) => previewPanel({ rows: [text], width, height: 1 }, painter(false));

		it("keeps a long zero-width control string whole and pads the right border to its column", () => {
			const rows = panel(`ab${sequence}界`);
			expect(rows).toEqual(["┌──────────┐", `│ ab${sequence}界     │`, "└──────────┘"]);
			for (const row of rows) expect(visibleWidth(row.replace(sequence, ""))).toBe(12);
		});

		it("clips only visible text, not the control string or its terminator", () => {
			const rows = panel(`ab${sequence}cdefghijk`);
			expect(rows[1]).toBe(`│ ab${sequence}cdefg… │`);
			expect(visibleWidth(rows[1]?.replace(sequence, "") ?? "")).toBe(12);
		});

		it("keeps the complete control string even when only an ellipsis fits", () => {
			expect(panel(`${sequence}abc`, 5)).toEqual(["┌───┐", `│ ${sequence}… │`, "└───┘"]);
		});

		it("uses the same zero-column rule for its title", () => {
			const rows = previewPanel({ title: `ab${sequence}cd`, rows: ["x"], width: 12, height: 1 }, painter(false));
			expect(rows[0]).toBe(`┌ ab${sequence}cd ────┐`);
			expect(visibleWidth(rows[0]?.replace(sequence, "") ?? "")).toBe(12);
		});

		it("closes a truncated style and hyperlink before the right border", () => {
			const open = "\x1b]8;;https://example.invalid/\x07";
			const close = "\x1b]8;;\x07";
			const rows = panel(`\x1b[31m${open}ab${sequence}cdefghijk${close}\x1b[0m`);
			expect(rows[1]).toBe(`│ \x1b[31m${open}ab${sequence}cdefg${close}\x1b[0m… │`);
		});
	});
}
