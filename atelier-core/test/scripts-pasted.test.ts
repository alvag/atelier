import { describe, expect, it } from "vitest";
import { pastedLines, sourceLines } from "../scripts/pasted.ts";

const SOURCE = [
	"export function boundReport(text: string): { text: string; truncated: boolean } {",
	"	if (text.length <= REPORT_LIMIT) return { text, truncated: false };",
	"}",
	"",
].join("\n");

describe("pasted source lines in a delegation prompt", () => {
	it("counts the prompt's lines that repeat a long source line, however indented", () => {
		const lines = sourceLines([SOURCE]);
		const prompt = [
			"Rename boundReport to capReport. It reads:",
			"  export function boundReport(text: string): { text: string; truncated: boolean } {",
			"if (text.length <= REPORT_LIMIT) return { text, truncated: false };",
		].join("\n");
		expect(pastedLines(prompt, lines)).toBe(2);
	});

	it("ignores short lines, which any prompt may share with the code", () => {
		const lines = sourceLines([SOURCE]);
		expect(pastedLines("}\n\nRename boundReport in src/subagents/definitions.ts.", lines)).toBe(0);
	});
});
