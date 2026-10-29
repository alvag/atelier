import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AskAnswer, AskDialog, type AskQuestion } from "../src/tui/ask-dialog.ts";
import { type Paint, painter } from "../src/tui/style.ts";

const plain = painter(false);
/** Paints with SGR codes, which take no columns: bold 1, dim 2, inverse 7, the colors as the terminal numbers them. */
const SGR: Record<string, number> = { bold: 1, dim: 2, inverse: 7, red: 31, green: 32, yellow: 33, cyan: 36 };
const sgr: Paint = (style, text) =>
	`\x1b[${[style]
		.flat()
		.map((name) => SGR[name] ?? 0)
		.join(";")}m${text}\x1b[0m`;

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";

const language: AskQuestion = {
	header: "Language",
	question: "Which language should commit messages use?",
	options: [
		{ label: "English", description: "What the project's AGENTS.md asks for.", recommended: true },
		{ label: "Spanish" },
	],
};
const checks: AskQuestion = {
	header: "Checks",
	question: "Which checks should run before each commit?",
	options: [{ label: "pnpm check", recommended: true }, { label: "Only Vitest" }],
};

function asked(questions: AskQuestion[], options: { guardMs?: number } = {}, paint = plain) {
	const sent: (AskAnswer[] | null)[] = [];
	const dialog = new AskDialog({ questions, ...options }, paint, (answers) => sent.push(answers));
	dialog.reveal();
	const lines = (width: number) => dialog.render(width).map((line) => line.trimEnd());
	return { dialog, sent, lines };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("AskDialog", () => {
	it("asks a single question without tabs and sends it at once", () => {
		const { dialog, sent, lines } = asked([language]);
		expect(lines(120).join("\n")).not.toContain("Language");
		expect(lines(120)[1]).toBe(" Which language should commit messages use?");
		dialog.handleInput("2");
		expect(sent).toEqual([[{ option: 1 }]]);
	});

	it("shows a tab for each question of a batch, by its header, and the keys to move among them", () => {
		const { lines } = asked([language, checks]);
		expect(lines(120).slice(0, 4)).toEqual([
			"─".repeat(120),
			" ←  ○ Language   ○ Checks   ✔ Submit  →",
			"",
			" Which language should commit messages use?",
		]);
		expect(lines(120)).toContain(" ←→ tabs · ↑↓ move · 1-3 pick · enter select · esc cancel");
	});

	it("names a tab Q1, Q2… when its question has no header", () => {
		const { header: _language, ...first } = language;
		const { header: _checks, ...second } = checks;
		expect(asked([first, second]).lines(120)[1]).toBe(" ←  ○ Q1   ○ Q2   ✔ Submit  →");
	});

	it("highlights the tab you are on, marks answered tabs in the success color and the others dimmed", () => {
		const { dialog, lines } = asked([language, checks], {}, sgr);
		expect(lines(120)[1]).toContain("\x1b[7m ○ Language \x1b[0m");
		dialog.handleInput("1");
		const bar = lines(120)[1] ?? "";
		expect(bar).toContain("\x1b[32m✔\x1b[0m");
		expect(bar).toContain("\x1b[7m ○ Checks \x1b[0m");
	});

	it("moves to the next question once one is answered, goes back with ←, keeps and replaces answers", () => {
		const { dialog, sent, lines } = asked([language, checks]);
		dialog.handleInput("1");
		expect(lines(120)[1]).toBe(" ←  ✔ Language   ○ Checks   ✔ Submit  →");
		expect(lines(120)[3]).toBe(" Which checks should run before each commit?");
		dialog.handleInput(LEFT);
		// The answer given is where the cursor is.
		expect(lines(120)[5]).toMatch(/^ ❯ 1\. English/);
		dialog.handleInput("2");
		expect(sent).toEqual([]);
		dialog.handleInput("3");
		dialog.handleInput("only Vitest");
		dialog.handleInput("\r");
		// The last question leads to the review, which sends with Submit answers.
		expect(sent).toEqual([]);
		expect(lines(120)[3]).toBe(" Review your answers");
		dialog.handleInput("\r");
		expect(sent).toEqual([[{ option: 1 }, { other: "only Vitest" }]]);
	});

	it("moves with → too, and leaves ← and → to the text while there is text to edit", () => {
		const { dialog, sent } = asked([language, checks]);
		dialog.handleInput(RIGHT);
		dialog.handleInput(UP);
		dialog.handleInput("ac");
		dialog.handleInput(LEFT);
		dialog.handleInput("b");
		dialog.handleInput("\r");
		// Back on Checks the cursor is on the text again, where ← edits: Up leaves it first.
		dialog.handleInput(LEFT);
		dialog.handleInput(UP);
		dialog.handleInput(LEFT);
		dialog.handleInput("1");
		dialog.handleInput(RIGHT);
		dialog.handleInput("1");
		expect(sent).toEqual([[{ option: 0 }, { other: "abc" }]]);
	});

	it("cancels the whole batch on Esc, on any tab", () => {
		const { dialog, sent } = asked([language, checks]);
		dialog.handleInput("1");
		dialog.handleInput("\x1b");
		expect(sent).toEqual([null]);
		dialog.handleInput("1");
		expect(sent).toEqual([null]);
	});

	it("starts the guard again on each question it shows", () => {
		vi.useFakeTimers();
		const { dialog, sent, lines } = asked([language, checks], { guardMs: 400 });
		dialog.handleInput("1");
		expect(lines(120)[1]).toBe(" ←  ○ Language   ○ Checks   ✔ Submit  →");
		vi.advanceTimersByTime(500);
		dialog.handleInput("1");
		expect(lines(120)[1]).toBe(" ←  ✔ Language   ○ Checks   ✔ Submit  →");
		dialog.handleInput("1");
		expect(lines(120)[1]).toBe(" ←  ✔ Language   ○ Checks   ✔ Submit  →");
		vi.advanceTimersByTime(500);
		dialog.handleInput("1");
		// The review guards its Enter too: a second Enter right after the last answer sends nothing.
		dialog.handleInput("\r");
		expect(sent).toEqual([]);
		vi.advanceTimersByTime(500);
		dialog.handleInput("\r");
		expect(sent).toEqual([[{ option: 0 }, { option: 0 }]]);
	});

	it("fits the tabs of a batch in a very narrow terminal, cut with … or as Q1, Q2…", () => {
		const long = (index: number): AskQuestion => ({ ...checks, header: `Header number ${index}!` });
		const questions = [long(1), long(2), long(3), long(4)];
		for (const width of [60, 40, 24]) {
			const { lines } = asked(questions);
			for (const line of lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(lines(width)[1]).toMatch(/…|Q1/);
		}
		const { dialog, lines } = asked(questions);
		dialog.handleInput(RIGHT);
		dialog.handleInput(RIGHT);
		// The tab you are on stays in sight.
		expect(lines(40)[1]).toMatch(/○ (Q3|He)/);
		expect(lines(40)[1]).not.toContain("\x1b");
	});

	it("reviews the answers before sending, saying which question has none", () => {
		const { dialog, lines } = asked([language, checks]);
		dialog.handleInput("1");
		dialog.handleInput(RIGHT);
		expect(lines(120)).toEqual([
			"─".repeat(120),
			" ←  ✔ Language   ○ Checks   ✔ Submit  →",
			"",
			" Review your answers",
			" ⚠ 1 question has no answer",
			"",
			"  ✔ Language   English",
			"  ○ Checks     — no answer",
			"",
			" ❯ 1. Submit answers",
			"   2. Cancel",
			"",
			" ←→ tabs · ↑↓ move · 1-2 pick · enter select · esc cancel",
			"─".repeat(120),
		]);
	});

	it("paints the warning in the warning color, the answered rows in the success color and the others dimmed", () => {
		const { dialog, lines } = asked([language, checks], {}, sgr);
		dialog.handleInput("1");
		dialog.handleInput(RIGHT);
		const text = lines(120).join("\n");
		expect(text).toContain("\x1b[33m⚠ 1 question has no answer\x1b[0m");
		expect(text).toContain("\x1b[32m✔ Language\x1b[0m");
		expect(text).toContain("\x1b[2m○ Checks  \x1b[0m");
		expect(text).toContain("\x1b[7m ✔ Submit \x1b[0m");
	});

	it("goes to the question with no answer on Submit, says so, and sends only once every question has one", () => {
		const { dialog, sent, lines } = asked([language, checks]);
		dialog.handleInput(RIGHT);
		dialog.handleInput(RIGHT);
		expect(lines(120)).toContain(" ⚠ 2 questions have no answer");
		dialog.handleInput("1");
		expect(sent).toEqual([]);
		expect(lines(120)[3]).toBe(" Which language should commit messages use?");
		expect(lines(120)).toContain(" Answer this question to submit");
		dialog.handleInput("2");
		dialog.handleInput("2");
		expect(lines(120)).not.toContain(" ⚠ 1 question has no answer");
		expect(lines(120).join("\n")).not.toContain("⚠");
		expect(lines(120)).toContain("  ✔ Checks     Only Vitest");
		dialog.handleInput("1");
		expect(sent).toEqual([[{ option: 1 }, { option: 1 }]]);
	});

	it("cancels the whole batch with Cancel", () => {
		const { dialog, sent } = asked([language, checks]);
		dialog.handleInput("1");
		dialog.handleInput("1");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		expect(sent).toEqual([null]);
	});

	it("shows the user's own text in the review on one line, and fits a very narrow terminal", () => {
		const { dialog, lines } = asked([language, checks]);
		dialog.handleInput("1");
		dialog.handleInput("3");
		dialog.handleInput("\x1b[200~a long answer that goes\non\x1b[201~");
		dialog.handleInput("\r");
		expect(lines(120)).toContain("  ✔ Checks     Type something: a long answer that goes on");
		for (const width of [40, 24])
			for (const line of lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(lines(40).join("\n")).toContain("Review your answers");
	});
});
