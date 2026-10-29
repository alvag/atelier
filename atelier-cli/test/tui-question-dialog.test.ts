import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
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

	it("goes to the last row with the first Up, and answers Type something there", () => {
		const { shown, answers } = dialog();
		shown.handleInput(UP);
		shown.handleInput("\r");
		expect(answers).toEqual(["other"]);
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
		expect(other.answers).toEqual(["other"]);
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

	it("shows a title over the question when it has one", () => {
		const { lines } = dialog({ title: "Question 1 of 2" });
		expect(lines(80).slice(0, 3)).toEqual([
			"─".repeat(80),
			" Question 1 of 2",
			" Which language should commit messages use?",
		]);
	});
});
