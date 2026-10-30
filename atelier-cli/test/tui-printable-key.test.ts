import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type AskAnswer, AskDialog } from "../src/tui/ask-dialog.ts";
import { painter } from "../src/tui/style.ts";
import { PRINTABLE_KEYS } from "./support/printable-keys.ts";

it("loads the TUI when only the public pi-tui entry point is available", () => {
	const app = new URL("../src/tui/app.ts", import.meta.url).href;
	const script = `
		import { registerHooks } from 'node:module';
		registerHooks({ resolve(specifier, context, next) {
			if (specifier.startsWith('@earendil-works/pi-tui/')) throw new Error('Private pi-tui entry point');
			return next(specifier, context);
		} });
		await import(${JSON.stringify(app)});
		process.stdout.write('loaded');
	`;
	expect(
		execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 }),
	).toBe("loaded");
});

for (const multiSelect of [false, true]) {
	describe(`printable keys, ${multiSelect ? "multi-select" : "single-choice"}`, () => {
		it.each(PRINTABLE_KEYS)("types %s as before", (_name, input, decoded) => {
			const sent: (AskAnswer[] | null)[] = [];
			const dialog = new AskDialog(
				{ questions: [{ question: "Which checks?", options: [{ label: "Biome" }], multiSelect }] },
				painter(false),
				(answers) => sent.push(answers),
			);
			// Raw UTF-8 is not decoded: the dialog keeps it as typed. An unrecognized escape is not text.
			const inserted = decoded ?? (input.startsWith("\x1b") ? "" : input);
			const text = `x${inserted}y`;
			dialog.handleInput("2");
			dialog.handleInput("x");
			dialog.handleInput(input);
			dialog.handleInput("y");
			expect(dialog.render(120).join("\n")).toContain(`2. ${multiSelect ? "[✓] " : ""}${text}`);
			expect(sent).toEqual([]);
			dialog.handleInput("\r");
			if (multiSelect) dialog.handleInput("\r");
			expect(sent).toEqual([[multiSelect ? { options: [], other: text } : { other: text }]]);
		});
	});
}
