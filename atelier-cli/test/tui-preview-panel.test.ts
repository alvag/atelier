import { describe, expect, it } from "vitest";
import { previewRows } from "../src/tui/preview-panel.ts";

const ST = "\x1b\\";

for (const [name, start] of [
	["APC", "\x1b_"],
	["DCS", "\x1bP"],
]) {
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
	});
}
