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

	it("types printable keys as the prompt editor takes them: Kitty CSI-u and modifyOtherKeys too", () => {
		const { shown, answers, lines } = dialog();
		shown.handleInput("3");
		// a, A (Shift with its shifted key), é, a space, Ñ, then B as xterm's modifyOtherKeys sends it.
		for (const key of ["\x1b[97u", "\x1b[97:65;2u", "\x1b[233u", "\x1b[32u", "Ñ", "\x1b[27;2;66~"])
			shown.handleInput(key);
		expect(typeRow(lines(120))).toBe(" ❯ 3. aAé ÑB");
		shown.handleInput("\r");
		expect(answers).toEqual([{ other: "aAé ÑB" }]);
	});

	it("picks with a number key sent as Kitty CSI-u", () => {
		const { shown, answers } = dialog();
		shown.handleInput("\x1b[50u");
		expect(answers).toEqual([{ option: 1 }]);
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

describe("QuestionDialog, multi-select", () => {
	const checks = {
		question: "Which checks should run before each commit?",
		multiSelect: true,
		options: [
			{ label: "Biome", description: "Lint and format", recommended: true },
			{ label: "TypeScript", description: "Core, CLI and desktop", recommended: true },
			{ label: "Vitest", description: "The whole suite, about three minutes" },
		],
	};
	const SPACE = " ";

	it("shows a box before each option and Type something…, then Submit, with descriptions beside or under", () => {
		const { lines } = dialog(checks);
		expect(lines(120).slice(3, 9)).toEqual([
			"   1. [ ] Biome       Recommended   Lint and format",
			"   2. [ ] TypeScript  Recommended   Core, CLI and desktop",
			"   3. [ ] Vitest                    The whole suite, about three minutes",
			"   4. [ ] Type something…",
			"      Submit",
			"",
		]);
		expect(lines(120)[9]).toBe(" ↑↓ move · space/1-4 toggle · enter select · esc cancel");
		expect(lines(60).slice(3, 11)).toEqual([
			"   1. [ ] Biome  Recommended",
			"          Lint and format",
			"   2. [ ] TypeScript  Recommended",
			"          Core, CLI and desktop",
			"   3. [ ] Vitest",
			"          The whole suite, about three minutes",
			"   4. [ ] Type something…",
			"      Submit",
		]);
		expect(dialog({ ...checks, last: false }).lines(120)[7]).toBe("      Next →");
	});

	it("toggles a box with Space, Enter or its number, and sends what is checked from Submit, none included", () => {
		const none = dialog(checks);
		none.shown.handleInput(UP);
		expect(none.lines(120)[7]).toBe(" ❯    Submit");
		none.shown.handleInput("\r");
		expect(none.answers).toEqual([{ options: [] }]);
		const some = dialog(checks);
		// Vitest by its number, TypeScript by Space, Biome on and off by its number and by Enter.
		for (const key of ["3", UP, SPACE, "1", "1", "\r", "\r", DOWN]) some.shown.handleInput(key);
		expect(some.lines(120).slice(3, 6)).toEqual([
			"   1. [ ] Biome       Recommended   Lint and format",
			" ❯ 2. [✓] TypeScript  Recommended   Core, CLI and desktop",
			"   3. [✓] Vitest                    The whole suite, about three minutes",
		]);
		expect(some.answers).toEqual([]);
		for (const key of [DOWN, DOWN, DOWN, "\r"]) some.shown.handleInput(key);
		expect(some.answers).toEqual([{ options: [1, 2] }]);
	});

	it("checks Type something… as you type there, sends the text with the options, and leaves it out unchecked", () => {
		const { shown, answers, lines } = dialog(checks);
		shown.handleInput("1");
		shown.handleInput("4");
		for (const key of ["a", " ", "b"]) shown.handleInput(key);
		expect(lines(120)[6]).toBe(" ❯ 4. [✓] a b");
		shown.handleInput("\r");
		expect(lines(120)[7]).toBe(" ❯    Submit");
		shown.handleInput("\r");
		expect(answers).toEqual([{ options: [0], other: "a b" }]);
		const unchecked = dialog(checks);
		unchecked.shown.handleInput("4");
		unchecked.shown.handleInput("x");
		unchecked.shown.handleInput(DOWN);
		unchecked.shown.handleInput(DOWN);
		unchecked.shown.handleInput("4");
		expect(unchecked.lines(120)[6]).toBe(" ❯ 4. [ ] x");
		unchecked.shown.handleInput(DOWN);
		unchecked.shown.handleInput("\r");
		expect(unchecked.answers).toEqual([{ options: [] }]);
	});

	it("does not send Type something… checked with nothing typed, and says why", () => {
		const { shown, answers, lines } = dialog(checks);
		shown.handleInput("4");
		shown.handleInput(SPACE);
		expect(lines(120)[6]).toMatch(/^ ❯ 4\. \[ \] /);
		shown.handleInput(SPACE);
		expect(lines(120)[6]).toMatch(/^ ❯ 4\. \[✓\] /);
		shown.handleInput(DOWN);
		shown.handleInput("\r");
		expect(answers).toEqual([]);
		expect(lines(120).join("\n")).toContain("Type an answer, or uncheck Type something");
	});

	it("goes from an empty Type something… to Submit with Enter without checking it, and the next Enter sends none", () => {
		const { shown, answers, lines } = dialog({ ...checks, options: checks.options.slice(0, 2) });
		for (const key of [DOWN, DOWN, DOWN, "\r"]) shown.handleInput(key);
		expect(lines(120).slice(5, 7)).toEqual(["   3. [ ] Type something…", " ❯    Submit"]);
		expect(answers).toEqual([]);
		shown.handleInput("\r");
		expect(answers).toEqual([{ options: [] }]);
	});

	it("never overflows a very narrow terminal", () => {
		const { shown, lines } = dialog(checks);
		shown.handleInput("2");
		for (const width of [40, 24])
			for (const line of lines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(lines(40).join("\n")).toContain("[✓] TypeScript");
	});

	it("takes no key during the guard, and checks nothing with pasted text", () => {
		const answers: QuestionAnswer[] = [];
		const shown = new QuestionDialog({ ...checks, guardMs: 60_000 }, plain, (answer) => answers.push(answer));
		shown.reveal();
		for (const key of ["1", SPACE, UP, "\r"]) shown.handleInput(key);
		const pasted = dialog(checks);
		pasted.shown.handleInput("\x1b[200~1 \r\x1b[201~");
		expect(pasted.lines(120).join("\n")).not.toContain("✓");
		expect(answers).toEqual([]);
		expect(pasted.answers).toEqual([]);
	});
});

describe("QuestionDialog option previews", () => {
	const CALL = 'web_fetch("http://10.0.0.1")';
	const ERROR = "→ Error: refused to fetch a private or internal address";
	const explicit = {
		label: "Explicit error",
		description: "Says why it failed.",
		recommended: true,
		preview: `${CALL}\n${ERROR}`,
	};
	const empty = { label: "Empty response", preview: `${CALL}\n→ "" (no error, no content)\n` };
	const fetch = {
		question: "How should web_fetch answer a private address?",
		options: [explicit, empty, { label: "Ask first" }],
	};
	/** A row of the panel, 55 columns of content between its sides. */
	const row = (text: string) => `│ ${text.padEnd(55)} │`;
	const top = (title?: string) =>
		title === undefined ? `┌${"─".repeat(57)}┐` : `┌ ${title} ${"─".repeat(55 - title.length)}┐`;
	const bottom = `└${"─".repeat(57)}┘`;

	it("shows the focused option's preview in a panel beside the options when the width allows", () => {
		const { shown, lines } = dialog(fetch);
		shown.handleInput(DOWN);
		expect(lines(120)).toEqual([
			"─".repeat(120),
			" How should web_fetch answer a private address?",
			"",
			` ❯ 1. Explicit error  Recommended  ${top("1. Explicit error")}`,
			`${"      Says why it failed.".padEnd(35)}${row(CALL)}`,
			`${"   2. Empty response".padEnd(35)}${row(ERROR)}`,
			`${"   3. Ask first".padEnd(35)}${bottom}`,
			"   4. Type something…",
			"",
			" ↑↓ move · 1-4 pick · enter select · esc cancel",
			"─".repeat(120),
		]);
	});

	it("says how to see the previews before the cursor is on an option, and when one has none", () => {
		const { shown, lines } = dialog(fetch);
		expect(lines(120).slice(3, 7)).toEqual([
			`   1. Explicit error  Recommended  ${top()}`,
			`${"      Says why it failed.".padEnd(35)}${row("↑↓ to see each option's preview")}`,
			`${"   2. Empty response".padEnd(35)}${row("")}`,
			`${"   3. Ask first".padEnd(35)}${bottom}`,
		]);
		for (const key of [DOWN, DOWN, DOWN]) shown.handleInput(key);
		expect(lines(120).slice(3, 5)).toEqual([
			`   1. Explicit error  Recommended  ${top("3. Ask first")}`,
			`${"      Says why it failed.".padEnd(35)}${row("No preview")}`,
		]);
		shown.handleInput(DOWN);
		expect(lines(120)[3]).toContain(top("4. Type something…"));
	});

	it("puts the panel under the options when the width leaves no room beside them", () => {
		const { shown, lines } = dialog(fetch);
		shown.handleInput(DOWN);
		shown.handleInput(DOWN);
		expect(lines(60)).toEqual([
			"─".repeat(60),
			" How should web_fetch answer a private address?",
			"",
			"   1. Explicit error  Recommended   Says why it failed.",
			" ❯ 2. Empty response",
			"   3. Ask first",
			"   4. Type something…",
			"",
			` ${top("2. Empty response")}`,
			` ${row(CALL)}`,
			` ${row('→ "" (no error, no content)')}`,
			` ${bottom}`,
			"",
			" ↑↓ move · 1-4 pick · enter select · esc cancel",
			"─".repeat(60),
		]);
	});

	it("keeps its height as the cursor moves, as tall as the tallest preview", () => {
		const tall = { ...fetch, options: [explicit, empty, { label: "Ask first", preview: "a\nb\nc\nd" }] };
		for (const width of [120, 60]) {
			const { shown, lines } = dialog(tall);
			const heights = [lines(width).length];
			for (const _ of [0, 1, 2, 3]) {
				shown.handleInput(DOWN);
				heights.push(lines(width).length);
			}
			expect(new Set(heights).size, `${width}: ${heights}`).toBe(1);
		}
	});

	it("wraps a long line inside the panel and shows a tab as two spaces", () => {
		const config = '{\n\t"linter": { "rules": { "recommended": true, "suspicious": { "noExplicitAny": "error" } } }\n}';
		const { shown, lines } = dialog({ ...fetch, options: [{ ...explicit, preview: config }, empty] });
		shown.handleInput(DOWN);
		const panel = lines(60).filter((line) => line.startsWith(" │"));
		expect(panel[0]).toBe(` ${row("{")}`);
		expect(panel[1]).toMatch(/^ │ {3}"linter": \{/);
		expect(panel.length).toBeGreaterThan(3);
		for (const line of lines(60)) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(panel.join("")).toContain("error");
	});

	it("cuts the panel to the rows a short terminal leaves, never the question, the options or the hint", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const options = [{ ...explicit, preview: long }, empty, { label: "Ask first" }];
		// The panel is as wide as its longest line: the hint before the cursor is on an option.
		const narrow = (text: string) => `│ ${text.padEnd(31)} │`;
		const short = dialog({ ...fetch, options, height: () => 24 });
		short.shown.handleInput(DOWN);
		const below = short.lines(60);
		expect(below).toHaveLength(24);
		expect(below.slice(0, 7)).toEqual([
			"─".repeat(60),
			" How should web_fetch answer a private address?",
			"",
			" ❯ 1. Explicit error  Recommended   Says why it failed.",
			"   2. Empty response",
			"   3. Ask first",
			"   4. Type something…",
		]);
		expect(below.slice(-3)).toEqual(["", " ↑↓ move · 1-4 pick · enter select · esc cancel", "─".repeat(60)]);
		expect(below.slice(9, 21)).toEqual([
			...Array.from({ length: 10 }, (_, index) => ` ${narrow(`line ${index + 1}`)}`),
			` ${narrow("… 10 more lines")}`,
			` └${"─".repeat(33)}┘`,
		]);
		const beside = short.lines(120);
		expect(beside).toHaveLength(24);
		expect(beside.join("\n")).toContain(narrow("… 5 more lines"));
		expect(beside.at(-2)).toBe(" ↑↓ move · 1-4 pick · enter select · esc cancel");
		const tall = dialog({ ...fetch, options, height: () => 40 });
		tall.shown.handleInput(DOWN);
		expect(tall.lines(60).join("\n")).toContain(narrow("line 20"));
	});

	it("leaves the panel out when not even its borders fit, rather than push the hint or the question off screen", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const crowded = (preview: boolean) => ({
			question: "Which approach?",
			height: () => 24,
			options: [1, 2, 3, 4].map((number) => ({
				label: `Option ${number}`,
				description: "description ".repeat(9).trim(),
				...(number === 1 ? { recommended: true } : {}),
				...(number === 1 && preview ? { preview: long } : {}),
			})),
		});
		for (const width of [60, 120]) {
			const without = dialog(crowded(false));
			const withPreview = dialog(crowded(true));
			for (const shown of [without, withPreview]) shown.shown.handleInput(DOWN);
			const plainLines = without.lines(width);
			const previewed = withPreview.lines(width);
			expect(previewed.length, `${width}`).toBeLessThanOrEqual(Math.max(24, plainLines.length));
			expect(previewed[1]).toBe(" Which approach?");
			expect(previewed.at(-2)).toBe(plainLines.at(-2));
			expect(previewed.join("\n")).toContain("4. Option 4");
		}
		const at60 = dialog(crowded(true));
		at60.shown.handleInput(DOWN);
		expect(at60.lines(60).join("\n")).not.toContain("┌");
	});

	it("keeps a panel that only fits with its rows cut", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const options = [{ ...explicit, preview: long }, empty, { label: "Ask first" }];
		const short = dialog({ ...fetch, options, height: () => 16 });
		short.shown.handleInput(DOWN);
		const shown = short.lines(60);
		expect(shown).toHaveLength(16);
		expect(shown.slice(9, 12)).toEqual([
			" │ line 1                          │",
			" │ line 2                          │",
			" │ … 18 more lines                 │",
		]);
		expect(shown.at(-2)).toBe(" ↑↓ move · 1-4 pick · enter select · esc cancel");
	});

	describe("with short labels", () => {
		const short = (preview: string) => ({
			question: "Which one?",
			height: () => 40,
			options: [{ label: "A", recommended: true, preview }, { label: "B" }],
		});
		/** The text between a panel row's sides, wherever the row is. */
		const inside = (lines: string[]) =>
			lines.flatMap((line) => {
				const match = /│ (.*) │$/.exec(line);
				return match ? [match[1] ?? ""] : [];
			});
		/** The rows a panel `content` columns wide shows of a preview of one-column characters: each line cut in full rows. */
		const cut = (preview: string, content: number) =>
			preview
				.replaceAll("\t", "  ")
				.split("\n")
				.flatMap((line) =>
					Array.from({ length: Math.max(1, Math.ceil(line.length / content)) }, (_, row) =>
						line.slice(row * content, (row + 1) * content).padEnd(content),
					),
				);
		/** Focuses the option with `preview` and renders the dialog `width` columns wide. */
		const focused = (preview: string, width: number) => {
			const { shown, lines } = dialog(short(preview));
			shown.handleInput(DOWN);
			return lines(width);
		};

		it("keeps every space of a preview cut by columns, at the start and the end of each row", () => {
			const preview = `const value = "${" ".repeat(40)}";`;
			const rows = inside(focused(preview, 60));
			const content = rows[0]?.length ?? 0;
			expect(rows.join("")).toBe(preview.padEnd(rows.length * content));
			expect(rows.length).toBe(Math.ceil(preview.length / content));
		});

		it("keeps the indentation of each line of an indented preview longer than the panel", () => {
			const preview = [
				"{",
				'  "compilerOptions": {',
				'    "paths": { "@atelier/core": ["./atelier-core/src/index.ts"], "@atelier/core/protocol": ["./x.ts"] },',
				'    "strict": true',
				"  }",
				"}",
			].join("\n");
			for (const width of [60, 120]) {
				const rows = inside(focused(preview, width));
				expect(rows, `${width}`).toEqual(cut(preview, rows[0]?.length ?? 0));
			}
		});

		it("loses nothing of a three-line preview beside the options at 60 columns", () => {
			const preview = `first line\n${"x".repeat(38)}CD\nthird`;
			const { shown, lines } = dialog(short(preview));
			shown.handleInput(DOWN);
			const shownLines = lines(60);
			for (const line of shownLines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			const rows = inside(shownLines);
			expect(rows).toEqual(cut(preview, rows[0]?.length ?? 0));
			expect(rows.join("")).toContain("CD");
			expect(shownLines.join("\n")).toContain("3. Type something…");
		});

		it("keeps the Type something row whole beside the panel", () => {
			const { shown, lines } = dialog(short("one\ntwo\nthree"));
			shown.handleInput(DOWN);
			const row = lines(120).find((line) => line.includes("3. Type something…"));
			expect(row).toMatch(/^ {3}3\. Type something… +│ two +│$/);
		});

		it("shows the draft typed there whole, the panel beside it while it fits and under the options after", () => {
			const { shown, lines } = dialog(short("one\ntwo\nthree"));
			for (const key of [DOWN, DOWN, DOWN]) shown.handleInput(key);
			shown.handleInput("use a third approach");
			const besideIt = lines(80);
			// The panel says the row has no preview; the draft's row is beside its last, blank row.
			expect(besideIt.join("\n")).toContain("┌ 3. Type something…");
			expect(besideIt.find((line) => line.includes("3. use a third approach"))).toMatch(/approach +│ +│$/);
			// 41 characters leave the panel too few columns beside the draft: it goes under the options.
			shown.handleInput(" and keep the old one");
			const under = lines(80);
			expect(under.find((line) => line.startsWith(" ❯ 3. "))).toBe(" ❯ 3. use a third approach and keep the old one");
			expect(under.join("\n")).toContain(" ┌ 3. Type something…");
			for (const line of under) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		});

		it.each([40, 60, 80, 120])("loses no character of a valid preview at %i columns", (width) => {
			const preview = [
				'const answer = await fetch("https://example.com/a/very/long/path/that/keeps/going/on", {',
				'\tmethod: "POST",   ',
				"});",
				"x".repeat(70),
			].join("\n");
			const shownLines = focused(preview, width);
			for (const line of shownLines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const rows = inside(shownLines);
			expect(rows).toEqual(cut(preview, rows[0]?.length ?? 0));
		});

		it("cuts a line of wide characters between them, never through one", () => {
			const wide = "漢字かな交じりの行も切れずに残ります。".repeat(3);
			const shownLines = focused(`a\n${wide}`, 60);
			const rows = inside(shownLines).slice(1);
			for (const line of shownLines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			expect(rows.map((row) => row.trimEnd()).join("")).toBe(wide);
			expect(rows.length).toBeGreaterThan(1);
		});

		it("never splits a hyperlink's sequence, and closes and reopens it around each row break", () => {
			const open = "\x1b]8;;https://example.com\x07";
			const close = "\x1b]8;;\x07";
			const shownLines = focused(`${"x".repeat(30)}${open}link${close}tail`, 60);
			const rows = shownLines.filter((line) => line.includes("x".repeat(30)) || line.includes("tail"));
			expect(rows).toHaveLength(2);
			// What is left once the whole sequences are taken out has no escape character.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: a hyperlink's sequence starts with the escape character
			const sequences = /\x1b\]8;;[^\x07]*\x07/g;
			for (const row of rows) expect(row.replace(sequences, "")).not.toContain("\x1b");
			expect(rows[0]).toContain(`${open}lin${close} `);
			expect(rows[1]).toContain(`│ ${open}k${close}tail`);
			expect(rows.map((row) => row.replace(sequences, "")).join("\n")).toContain("xlin │");
		});

		it("ends a color at each row break and starts it again on the next row, before the panel's side", () => {
			const shownLines = focused(`\x1b[31m${"r".repeat(40)}\x1b[0m`, 60);
			const rows = shownLines.filter((line) => line.includes("rrr"));
			expect(rows).toHaveLength(2);
			expect(rows[0]).toContain(`│ \x1b[31m${"r".repeat(33)}\x1b[0m │`);
			expect(rows[1]).toContain(`│ \x1b[31m${"r".repeat(7)}\x1b[0m`);
		});

		it("keeps a marker of the sanitizer whole on one row", () => {
			const marker = "⟨U+061C⟩";
			const preview = `${"x".repeat(30)}${marker}tail`;
			const rows = inside(focused(preview, 60));
			expect(rows.some((row) => row.includes(marker))).toBe(true);
			expect(rows.map((row) => row.trimEnd()).join("")).toBe(preview);
		});
	});
});
