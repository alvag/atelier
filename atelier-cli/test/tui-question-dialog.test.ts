import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PasteFilter } from "../src/tui/dialog.ts";
import { type QuestionAnswer, QuestionDialog } from "../src/tui/question-dialog.ts";
import { type Paint, painter } from "../src/tui/style.ts";

const plain = painter(false);
/** Paints with SGR codes, which take no columns: bold 1, dim 2, inverse 7, the colors as the terminal numbers them. */
const SGR: Record<string, number> = { bold: 1, dim: 2, inverse: 7, red: 31, green: 32, yellow: 33, cyan: 36 };
const sgr: Paint = (style, text) =>
	`\x1b[${[style]
		.flat()
		.map((name) => SGR[name] ?? 0)
		.join(";")}m${text}\x1b[0m`;

const DOWN = "\x1b[B";
const UP = "\x1b[A";

const question = {
	question: "Which language should commit messages use?",
	options: [
		{ label: "English", description: "What the project's AGENTS.md asks for.", recommended: true },
		{ label: "Spanish" },
	],
};

function dialog(options: Partial<ConstructorParameters<typeof QuestionDialog>[0]> = {}, paint = plain) {
	const answers: QuestionAnswer[] = [];
	const shown = new QuestionDialog({ ...question, ...options }, paint, (answer) => answers.push(answer));
	shown.reveal();
	const lines = (width: number) => shown.render(width).map((line) => line.trimEnd());
	return { shown, answers, lines };
}

describe("QuestionDialog", () => {
	it("shows the question between two rules, its options numbered, the recommended tag and the description beside", () => {
		const { lines } = dialog();
		expect(lines(120)).toEqual([
			"─".repeat(120),
			" Which language should commit messages use?",
			"",
			"   1. English  Recommended   What the project's AGENTS.md asks for.",
			"   2. Spanish",
			"   3. Type something…",
			"",
			" ↑↓ move · 1-3 pick · enter select · esc cancel",
			"─".repeat(120),
		]);
	});

	it("puts descriptions under their labels when the width leaves no room beside them", () => {
		const { lines } = dialog();
		expect(lines(60)).toEqual([
			"─".repeat(60),
			" Which language should commit messages use?",
			"",
			"   1. English  Recommended",
			"      What the project's AGENTS.md asks for.",
			"   2. Spanish",
			"   3. Type something…",
			"",
			" ↑↓ move · 1-3 pick · enter select · esc cancel",
			"─".repeat(60),
		]);
	});

	it("never overflows a very narrow terminal, and shortens its hint first", () => {
		const long = {
			question: "Before changing the production database, should we keep every existing record?",
			options: [
				{ label: "Keep every record and back them up first", description: "Slower, but safe.", recommended: true },
				{ label: "Drop them" },
			],
		};
		const { lines } = dialog(long);
		for (const width of [40, 24])
			for (const line of lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		const text = lines(40).join("\n");
		expect(text).toContain("esc cancel");
		expect(text).not.toContain("enter select");
		expect(text.replace(/\s+/g, " ")).toContain("Keep every record and back them up first");
	});

	it("paints the rules and the cursor in the accent color, the question bold and the tag dimmed in the accent", () => {
		const { shown, lines } = dialog({}, sgr);
		shown.handleInput(DOWN);
		const text = lines(120).join("\n");
		expect(text).toContain(`\x1b[36m${"─".repeat(120)}\x1b[0m`);
		expect(text).toContain("\x1b[1mWhich language should commit messages use?\x1b[0m");
		expect(text).toContain("\x1b[36m❯\x1b[0m");
		expect(text).toContain("\x1b[2;36mRecommended\x1b[0m");
	});

	it("selects nothing at first: Enter answers nothing until Up or Down puts the cursor on a row", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("\r");
		expect(answers).toEqual([]);
		expect(lines(120).join("\n")).not.toContain("❯");
		shown.handleInput(DOWN);
		expect(lines(120)[3]).toMatch(/^ ❯ 1\. English/);
		shown.handleInput(DOWN);
		shown.handleInput(UP);
		shown.handleInput("\r");
		expect(answers).toEqual([{ option: 0 }]);
	});

	it("goes to the last row with the first Up, where Enter with nothing typed sends nothing", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput(UP);
		expect(lines(120)[5]).toBe(" ❯ 3. Type something…");
		shown.handleInput("\r");
		expect(answers).toEqual([]);
	});

	it("picks with a number key, and ignores a number with no row", () => {
		const { shown, answers } = dialog();
		shown.handleInput("9");
		shown.handleInput("0");
		expect(answers).toEqual([]);
		shown.handleInput("2");
		expect(answers).toEqual([{ option: 1 }]);
		const other = dialog();
		other.shown.handleInput("3");
		expect(other.answers).toEqual([]);
	});

	it("takes no key during the guard after it appears, numbers and Enter included", () => {
		const answers: QuestionAnswer[] = [];
		const shown = new QuestionDialog({ ...question, guardMs: 60_000 }, plain, (answer) => answers.push(answer));
		shown.reveal();
		for (const key of ["1", DOWN, "\r", "\x1b"]) shown.handleInput(key);
		expect(answers).toEqual([]);
	});

	it("answers nothing with pasted text, and cancels on Esc", () => {
		const { shown, answers } = dialog();
		shown.handleInput("\x1b[200~1\r\x1b[201~");
		expect(answers).toEqual([]);
		shown.handleInput("\x1b");
		expect(answers).toEqual(["cancel"]);
		shown.handleInput("1");
		expect(answers).toEqual(["cancel"]);
	});
});

describe("QuestionDialog's Type something row", () => {
	const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;
	const typeRow = (lines: string[]) => lines.find((line) => /^ [❯ ] 3\. /.test(line)) ?? "";

	it("takes the user's text in place once the cursor is on it, and sends it with Enter as written", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("3");
		expect(answers).toEqual([]);
		expect(lines(120)).toContain(" enter send · ↑↓ move · esc cancel");
		for (const key of ["  only", " ", "Vitest "]) shown.handleInput(key);
		expect(typeRow(lines(120))).toBe(" ❯ 3.   only Vitest");
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "  only Vitest " }]);
	});

	it("types digits there instead of picking, and edits with Left, Right and Backspace", () => {
		const { shown, answers } = dialog();
		shown.handleInput("\x1b[A");
		for (const key of ["1", "3", "\x1b[D", "2", "\x1b[C", "4", "\x7f", "\x1b[D", "\x1b[D", "\x1b[3~"])
			shown.handleInput(key);
		shown.handleInput("\r");
		// 13, 123, 1234, 123, then Delete takes the 2 after the cursor.
		expect(answers).toEqual([{ other: "13" }]);
	});

	it("needs a text that is not blank and at most 2000 characters, and says so in the hint line", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("3");
		shown.handleInput("   ");
		shown.handleInput("\r");
		expect(answers).toEqual([]);
		expect(lines(120)).toContain(" Type an answer, or esc to cancel");
		for (let i = 0; i < 3; i++) shown.handleInput("\x7f");
		shown.handleInput("x".repeat(2001));
		shown.handleInput("\r");
		expect(answers).toEqual([]);
		expect(lines(120)).toContain(" Too long: 2001 of 2000 characters");
		shown.handleInput("\x7f");
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "x".repeat(2000) }]);
	});

	it("keeps the draft while the cursor is on another row", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("3");
		shown.handleInput("draft");
		shown.handleInput("\x1b[A");
		expect(typeRow(lines(120))).toBe("   3. draft");
		expect(lines(120)).toContain(" ↑↓ move · 1-3 pick · enter select · esc cancel");
		shown.handleInput("\x1b[B");
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "draft" }]);
	});

	it("takes a paste there, even one split across chunks, but not a paste begun before the cursor got there", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("\x1b[200~ignored");
		shown.handleInput(" still\x1b[201~");
		shown.handleInput("3");
		expect(typeRow(lines(120))).toBe(" ❯ 3. Type something…");
		shown.handleInput("\x1b[200~one ");
		shown.handleInput("two\x1b[201~");
		shown.handleInput(PASTE(" three"));
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "one two three" }]);
	});

	it("keeps no paste for a later question that another list took while the filter was shared", () => {
		const paste = new PasteFilter();
		const first: QuestionAnswer[] = [];
		const one = new QuestionDialog({ ...question, paste }, plain, (answer) => first.push(answer));
		one.reveal();
		one.handleInput("3");
		one.handleInput("x");
		one.handleInput("\r");
		expect(first).toEqual([{ other: "x" }]);
		// An approval after it, on the same filter, gets a paste: it answers nothing there, and is not kept.
		paste.feed(PASTE("stale"));
		const later: QuestionAnswer[] = [];
		const two = new QuestionDialog({ ...question, paste }, plain, (answer) => later.push(answer));
		two.reveal();
		two.handleInput("3");
		two.handleInput("y");
		two.handleInput("\r");
		expect(later).toEqual([{ other: "y" }]);
	});

	it("takes a chunk's keys and pastes in the order they came: an Enter before a paste does not send it", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("3");
		shown.handleInput(`\r${PASTE("evil")}`);
		expect(answers).toEqual([]);
		expect(typeRow(lines(120))).toBe(" ❯ 3. evil");
		expect(lines(120)).toContain(" Type an answer, or esc to cancel");
		const ordered = dialog();
		ordered.shown.handleInput("3");
		ordered.shown.handleInput(`a${PASTE("b")}c`);
		ordered.shown.handleInput("\r");
		expect(ordered.answers).toEqual([{ other: "abc" }]);
	});

	it("takes a paste that starts after a number put the cursor on the text, in the same chunk", () => {
		const { shown, answers } = dialog();
		shown.handleInput(`3${PASTE("x")}`);
		expect(answers).toEqual([]);
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "x" }]);
	});

	it("drops the rest of a chunk once it answered", () => {
		const { shown, answers } = dialog();
		shown.handleInput("3");
		shown.handleInput("y");
		shown.handleInput(`\r${PASTE("more")}\r`);
		expect(answers).toEqual([{ other: "y" }]);
	});

	it("shows control characters as markers and sends them as typed", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("3");
		shown.handleInput(PASTE("a\x1b[2Jb"));
		expect(typeRow(lines(120))).toBe(" ❯ 3. a␛[2Jb");
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "a\x1b[2Jb" }]);
	});

	it("never overflows a very narrow terminal with a long text, and keeps the cursor's end in sight", () => {
		const { shown, lines } = dialog();
		shown.handleInput("3");
		shown.handleInput(`${"a".repeat(80)}END`);
		for (const line of lines(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(typeRow(lines(40))).toMatch(/^ ❯ 3\. …a+END$/);
	});

	it("cancels the whole question on Esc while typing", () => {
		const { shown, answers } = dialog();
		shown.handleInput("3");
		shown.handleInput("abc");
		shown.handleInput("\x1b");
		expect(answers).toEqual(["cancel"]);
	});
});
