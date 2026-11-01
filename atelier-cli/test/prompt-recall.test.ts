import type { AutocompleteProvider, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PromptEditor } from "../src/tui/prompt.ts";
import { editorTheme, painter, Shade } from "../src/tui/style.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const UNDO = "\x1f";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

function setup(history: string[] = [], width = 30, color = false) {
	const paint = painter(color);
	const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
	let open = false;
	const editor = new PromptEditor(tui, editorTheme(paint), paint, new Shade(color), () => open);
	editor.focused = true;
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	for (const text of history) editor.addToHistory(text);
	const press = (...keys: string[]) => {
		for (const key of keys) {
			editor.handleInput(key);
			editor.render(width);
		}
	};
	editor.render(width);
	return {
		editor,
		press,
		submitted,
		setOpen: (value: boolean) => (open = value),
		resize: (next: number) => {
			width = next;
			editor.render(width);
		},
	};
}

/** How many visual rows the text takes at `width`: the render minus the two borders. */
const rows = (editor: PromptEditor, width: number) => editor.render(width).length - 2;

/** Presses `key` until the text changes from `from`, and says how many presses it took. */
function pressesUntilChange(s: ReturnType<typeof setup>, key: string, from: string, limit = 30): number {
	for (let count = 1; count <= limit; count++) {
		s.press(key);
		if (s.editor.getText() !== from) return count;
	}
	return Number.POSITIVE_INFINITY;
}
const upsUntilChange = (s: ReturnType<typeof setup>, from: string) => pressesUntilChange(s, UP, from);
const downsUntilChange = (s: ReturnType<typeof setup>, from: string) => pressesUntilChange(s, DOWN, from);

describe("recalling earlier prompts", () => {
	it("recalls the newest on Up in an empty editor, then older ones, with the cursor at the end", () => {
		const s = setup(["first", "second"]);
		s.press(UP);
		expect(s.editor.getText()).toBe("second");
		expect(s.editor.getCursor()).toEqual({ line: 0, col: 6 });
		s.press(UP);
		expect(s.editor.getText()).toBe("first");
	});

	it("keeps the cursor on the first visual row at the oldest entry", () => {
		const s = setup(["one\ntwo"]);
		s.press(UP, UP);
		const cursor = s.editor.getCursor();
		expect(cursor.line).toBe(0);
		s.press(UP);
		expect(s.editor.getText()).toBe("one\ntwo");
		expect(s.editor.getCursor()).toEqual(cursor);
	});

	it("returns to an empty editor on Down past the newest", () => {
		const s = setup(["first", "second"]);
		s.press(UP, UP, DOWN);
		expect(s.editor.getText()).toBe("second");
		s.press(DOWN);
		expect(s.editor.getText()).toBe("");
		s.press(DOWN);
		expect(s.editor.getText()).toBe("");
	});

	it("never replaces a normal draft, even on its first row with the cursor at the start", () => {
		const s = setup(["old"]);
		s.press("d", "r", "a", "f", "t");
		s.press(UP);
		expect(s.editor.getText()).toBe("draft");
		s.press(LEFT, LEFT, LEFT, LEFT, LEFT, UP);
		expect(s.editor.getText()).toBe("draft");
		s.press(UP, UP);
		expect(s.editor.getText()).toBe("draft");
	});

	it("never replaces a pasted multiline draft on Up", () => {
		const s = setup(["old"]);
		s.press(paste("one\ntwo"));
		s.press(UP, UP, UP, UP);
		expect(s.editor.getText()).toBe("one\ntwo");
	});

	it("leaves recall on any edit, so Up no longer swaps the text", () => {
		const s = setup(["older", "old"]);
		s.press(UP);
		s.press("x");
		expect(s.editor.getText()).toBe("oldx");
		s.press(LEFT, LEFT, LEFT, LEFT, UP);
		expect(s.editor.getText()).toBe("oldx");
		s.press(UP, UP);
		expect(s.editor.getText()).toBe("oldx");
	});

	it("does not restore the unedited recall when an edit is undone", () => {
		const s = setup(["older", "old"]);
		s.press(UP, "x", UNDO);
		expect(s.editor.getText()).toBe("old");
		s.press(UP, UP, UP);
		expect(s.editor.getText()).toBe("old");
	});

	it("leaves programmatic edits as a draft even after the original text is restored", () => {
		const s = setup(["older", "old"]);
		s.press(UP);
		s.editor.insertTextAtCursor("x");
		s.editor.setText("old");
		s.press(UP, UP, UP);
		expect(s.editor.getText()).toBe("old");
	});

	it("keeps recall while only the cursor moves", () => {
		const s = setup(["older", "old"]);
		s.press(UP, LEFT, LEFT, RIGHT);
		expect(s.editor.getText()).toBe("old");
		s.press(UP);
		expect(s.editor.getText()).toBe("older");
		s.press(LEFT, DOWN);
		expect(s.editor.getText()).toBe("old");
		s.press(DOWN);
		expect(s.editor.getText()).toBe("");
	});

	it("moves Down through a recalled prompt before selecting a newer entry", () => {
		const s = setup(["one\ntwo\nthree", "newer"]);
		s.press(UP, UP, UP, UP);
		expect(s.editor.getCursor().line).toBe(0);
		s.press(DOWN);
		expect(s.editor.getText()).toBe("one\ntwo\nthree");
		expect(s.editor.getCursor().line).toBe(1);
		s.press(DOWN, DOWN);
		expect(s.editor.getText()).toBe("newer");
	});

	it("moves through the lines of a recalled multiline prompt before changing it", () => {
		const s = setup(["older", "one\ntwo\nthree"]);
		s.press(UP);
		expect(s.editor.getCursor()).toEqual({ line: 2, col: 5 });
		s.press(UP, UP);
		expect(s.editor.getText()).toBe("one\ntwo\nthree");
		expect(s.editor.getCursor().line).toBe(0);
		s.press(UP);
		expect(s.editor.getText()).toBe("older");
		s.press(DOWN);
		expect(s.editor.getText()).toBe("one\ntwo\nthree");
		expect(s.editor.getCursor().line).toBe(2);
	});
});

describe("recalling a wrapped prompt", () => {
	const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa";

	it("counts wrapped rows: Up crosses all of them, Down crosses all of them", () => {
		const width = 16;
		const s = setup(["older", long], width);
		s.press(UP);
		expect(s.editor.getText()).toBe(long);
		const count = rows(s.editor, width);
		expect(count).toBeGreaterThan(2);
		expect(upsUntilChange(s, long)).toBe(count);
		expect(s.editor.getText()).toBe("older");
		s.press(DOWN);
		expect(s.editor.getText()).toBe(long);
		expect(downsUntilChange(s, long)).toBe(1);
	});

	it("does not mistake the scrolled viewport edges for the prompt's edges", () => {
		const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
		const s = setup(["older", text]);
		s.press(UP);
		expect(rows(s.editor, 30)).toBeLessThan(25);
		expect(upsUntilChange(s, text)).toBe(25);
		expect(s.editor.getText()).toBe("older");
	});

	it.each([false, true])("uses the actual render width, with color %s and padding", (color) => {
		const s = setup(["older", long], 18, color);
		s.editor.setPaddingX(2);
		s.press(UP);
		const count = rows(s.editor, 18);
		expect(upsUntilChange(s, long)).toBe(count);
	});

	it("follows a resize between presses", () => {
		const s = setup(["older", long], 80);
		s.press(UP);
		expect(rows(s.editor, 80)).toBe(1);
		s.resize(12);
		const count = rows(s.editor, 12);
		expect(count).toBeGreaterThan(3);
		expect(upsUntilChange(s, long)).toBe(count);
		expect(s.editor.getText()).toBe("older");
		s.press(DOWN);
		expect(s.editor.getText()).toBe(long);
		expect(downsUntilChange(s, long)).toBe(1);
		expect(s.editor.getText()).toBe("");
	});

	const family = "👨‍👩‍👧‍👦";
	for (const [name, text, width] of [
		["wide characters", "你好世界你好世界你好世界你好世界", 12],
		["grapheme clusters", `${family} ${family} ${family} ${family} ${family}`, 10],
	] as const) {
		it(`counts rows by columns for ${name}`, () => {
			const s = setup(["older", text], width);
			s.press(UP);
			const count = rows(s.editor, width);
			expect(count).toBeGreaterThan(1);
			expect(upsUntilChange(s, text)).toBe(count);
			expect(s.editor.getText()).toBe("older");
			s.press(DOWN);
			expect(s.editor.getText()).toBe(text);
			expect(downsUntilChange(s, text)).toBe(1);
		});
	}
});

describe("recall around other features", () => {
	it("lets an open list of completions take the arrows first", async () => {
		const s = setup(["old"]);
		const provider: AutocompleteProvider = {
			async getSuggestions(lines, _line, col) {
				const prefix = (lines[0] ?? "").slice(0, col);
				return prefix === "/"
					? {
							prefix,
							items: [
								{ value: "/one", label: "/one" },
								{ value: "/two", label: "/two" },
							],
						}
					: null;
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		s.editor.setAutocompleteProvider(provider);
		s.press("/");
		for (let i = 0; i < 100 && !s.editor.isShowingAutocomplete(); i++) await new Promise((r) => setTimeout(r, 5));
		expect(s.editor.isShowingAutocomplete()).toBe(true);
		s.press(UP, DOWN, UP);
		expect(s.editor.getText()).toBe("/");
		expect(s.editor.isShowingAutocomplete()).toBe(true);
	});

	it("recalls the full text of a large paste, with no marker left in it", () => {
		const full = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
		const s = setup();
		s.press(paste(full));
		s.press(ENTER);
		expect(s.submitted).toEqual([full]);
		s.editor.addToHistory(s.submitted[0] ?? "");
		s.press(UP);
		expect(s.editor.getExpandedText()).toBe(full);
		expect(s.editor.getText()).toBe(full);
		expect(s.editor.getText()).not.toContain("[paste #");
	});

	it("keeps the editor out of reach of Up while a question is open", () => {
		const s = setup(["old"]);
		s.setOpen(true);
		s.press(UP);
		expect(s.editor.render(30)).toEqual([]);
		s.setOpen(false);
		expect(s.editor.getText()).toBe("");
		s.press(UP);
		expect(s.editor.getText()).toBe("old");
	});
});
