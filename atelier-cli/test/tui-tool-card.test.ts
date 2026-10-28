import { styleText } from "node:util";
import type { AtelierEvent, JsonValue } from "@atelier/core";
import { backgroundAnsi, rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type Paint, painter, Tones } from "../src/tui/style.ts";
import { ToolCard } from "../src/tui/tool-card.ts";

const plain = painter(false);
/** Marks each painted piece with its style, so a test sees which color each part asked for. */
const tagged: Paint = (style, text) => `<${[style].flat().join("+")}>${text}</>`;

type Finished = Extract<AtelierEvent, { type: "tool_call_finished" }>;

/** A clock the test moves: the card measures its call from start to finish with it. */
function clock() {
	let ms = 0;
	return { now: () => new Date(ms), advance: (by: number) => (ms += by) };
}

/** The open card of one call that took `took` ms, at `width`, its lines without trailing blanks. */
function card(
	tool: string,
	input: JsonValue,
	finished?: Partial<Finished>,
	{ took = 0, width = 80, paint = plain, tones }: { took?: number; width?: number; paint?: Paint; tones?: Tones } = {},
) {
	const time = clock();
	const view = { expanded: true };
	const tc = new ToolCard(tool, input, view, paint, "c1", time.now, tones);
	time.advance(took);
	if (finished)
		tc.finish({
			type: "tool_call_finished",
			callId: "c1",
			ok: true,
			summary: "",
			truncated: false,
			seq: 1,
			turnId: "t",
			...finished,
		} as Finished);
	return { card: tc, lines: tc.render(width).map((line) => line.trimEnd()) };
}

describe("ToolCard", () => {
	it("leads with the call's state and keeps a command's lines under a bar, with how long it took", () => {
		const { lines } = card(
			"bash",
			{ command: "pnpm test --run\n  --reporter=dot" },
			{ summary: "pnpm test --run (exit 0)" },
			{ took: 4200 },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ bash pnpm test --run · exit 0 · 4.2s
			   │ $ pnpm test --run
			   │     --reporter=dot"
		`);
	});

	it("leaves out a time under a second", () => {
		const { lines } = card("bash", { command: "ls" }, { summary: "ls (exit 0)" }, { took: 300 });
		expect(lines[0]).toBe(" ✓ bash ls · exit 0");
	});

	it("marks a call that runs and one that failed", () => {
		expect(card("bash", { command: "pnpm test" }).lines[0]).toBe(" ◐ bash pnpm test");
		const { lines } = card(
			"bash",
			{ command: "pnpm check" },
			{ ok: false, summary: "pnpm check (exit 1)" },
			{ took: 12000 },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✗ bash pnpm check · exit 1 · 12.0s
			   │ $ pnpm check"
		`);
	});

	it("shows a search's pattern, folder and glob on one line", () => {
		const { lines } = card(
			"grep",
			{ pattern: "toolCard", path: "atelier-cli/src", glob: "*.ts" },
			{ summary: "toolCard: 3 matches" },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ grep toolCard: 3 matches
			   │ pattern toolCard  in atelier-cli/src  glob *.ts"
		`);
	});

	it("shows a read as its header alone", () => {
		const { lines } = card("read", { path: "src/a.ts" }, { summary: "src/a.ts (262 lines)" });
		expect(lines).toEqual([" ✓ read src/a.ts · 262 lines"]);
	});

	it("shows any other tool's input as keys and values instead of JSON", () => {
		const { lines } = card(
			"memory",
			{ action: "search", query: "TUI tool rendering colors", limit: 5, tags: ["a", "b"] },
			{ summary: "search (1 result)" },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ memory search · 1 result
			   │ action search
			   │ query  TUI tool rendering colors
			   │ limit  5
			   │ tags   ["a","b"]"
		`);
	});

	it("names what another tool works on while it runs", () => {
		expect(card("memory", { action: "search", query: "x" }).card.current()).toBe("memory search");
	});

	it("cuts what the call works on, never its state, at a narrow width", () => {
		const { lines } = card(
			"bash",
			{ command: "x".repeat(100) },
			{ summary: `${"x".repeat(100)} (exit 0)` },
			{ took: 2000, width: 40 },
		);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
		expect(lines[0]).toMatch(/^ ✓ bash x+… · exit 0 · 2\.0s$/);
	});

	it("colors the mark, the name, the details and the bar by the call's state", () => {
		const ok = card("bash", { command: "ls" }, { summary: "ls (exit 0)" }, { paint: tagged }).lines;
		expect(ok[0]).toBe(" <green>✓</> <bold>bash</> ls <dim>· exit 0</>");
		expect(ok[1]).toMatch(/^ {3}<green>▎<\/> <dim>\$<\/> /);
		const failed = card("bash", { command: "ls" }, { ok: false, summary: "ls (exit 1)" }, { paint: tagged });
		expect(failed.lines[0]).toBe(" <red>✗</> <bold>bash</> ls <red>· exit 1</>");
		expect(failed.lines[1]).toMatch(/^ {3}<red>▎<\/>/);
		expect(failed.card.alerts()).toEqual(["<red>✗</> <bold>bash</> <red>ls · exit 1</>"]);
		const grep = card("grep", { pattern: "mode" }, { summary: "mode: 1 match" }, { paint: tagged }).lines;
		expect(grep[1]).toContain("<dim>pattern</> <yellow>mode</>");
		const memory = card("memory", { action: "get", id: 7 }, { summary: "get" }, { paint: tagged }).lines;
		expect(memory.join("\n")).toContain("<dim>id    </> <yellow>7</>");
	});

	it("numbers a written file's lines and says how many more there are", () => {
		const content = Array.from({ length: 14 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
		const { lines } = card("write", { path: "a.ts", content }, { summary: "a.ts (1.2 KB)" });
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ write a.ts · 1.2 KB
			   │  1 const v1 = 1;
			   │  2 const v2 = 2;
			   │  3 const v3 = 3;
			   │  4 const v4 = 4;
			   │  5 const v5 = 5;
			   │  6 const v6 = 6;
			   │  7 const v7 = 7;
			   │  8 const v8 = 8;
			   │  9 const v9 = 9;
			   │ 10 const v10 = 10;
			   │ 11 const v11 = 11;
			   │ 12 const v12 = 12;
			   │    … 2 more lines"
		`);
	});

	it("shows an edit as a numbered diff, the lines both sides share as context", () => {
		const { lines } = card(
			"edit",
			{
				path: "src/style.ts",
				edits: [
					{
						oldText: "export const painter =\n  (color: boolean): Paint =>\n    (style, text) =>",
						newText: "export const painter =\n  (color: boolean, tones?: Tones): Paint =>\n    (style, text) =>",
					},
				],
			},
			{ summary: "src/style.ts (1 edit)", startLines: [21], newStartLines: [21] },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ edit src/style.ts · 1 edit
			   │ 21   export const painter =
			   │ 22 -   (color: boolean): Paint =>
			   │ 22 +   (color: boolean, tones?: Tones): Paint =>
			   │ 23       (style, text) =>"
		`);
	});

	it("numbers what an edit adds after the lines the earlier edits added or removed", () => {
		const { lines } = card(
			"edit",
			{
				path: "a.txt",
				edits: [
					{ oldText: "z", newText: "Z" },
					{ oldText: "a", newText: "a1\na2" },
				],
			},
			{ summary: "a.txt (2 edits)", startLines: [10, 1], newStartLines: [11, 1] },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ edit a.txt · 2 edits
			   │  1 - a
			   │  1 + a1
			   │  2 + a2
			   │    ⋮
			   │ 10 - z
			   │ 11 + Z"
		`);
	});

	it("numbers what each edit adds where the call says it starts after the edits before it, on the same line too", () => {
		const { lines } = card(
			"edit",
			{
				path: "a.txt",
				edits: [
					{ oldText: "a", newText: "a\nA" },
					{ oldText: "b", newText: "B" },
					{ oldText: "z", newText: "Z" },
				],
			},
			// The file was `a b` on line 1: `B` lands on line 2, after the `A` the first edit added.
			{ summary: "a.txt (3 edits)", startLines: [1, 1, 5], newStartLines: [1, 2, 6] },
		);
		expect(lines.join("\n")).toContain("   │ 1 - b\n   │ 2 + B");
		expect(lines.join("\n")).toContain("   │ 5 - z\n   │ 6 + Z");
	});

	it("keeps a change past the cut of a long line as a removed and an added line", () => {
		const long = "a".repeat(600);
		const { lines } = card(
			"edit",
			{ path: "a.txt", edits: [{ oldText: long, newText: `${long}b` }] },
			{ summary: "a.txt (1 edit)", startLines: [1], newStartLines: [1] },
		);
		const rows = lines.slice(1);
		expect(rows.some((line) => line.startsWith("   │ 1 - aaa"))).toBe(true);
		expect(rows.some((line) => line.startsWith("   │ 1 + aaa"))).toBe(true);
		expect(rows.join("\n")).toContain("…");
	});

	it("shows an edit without numbers when the call does not say where it starts", () => {
		const { lines } = card("edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] });
		expect(lines.slice(1)).toEqual(["   │ - old", "   │ + new"]);
	});

	it("wraps a long line of a diff under its text, not under its number", () => {
		const { lines } = card(
			"edit",
			{ path: "a.txt", edits: [{ oldText: "x", newText: "word ".repeat(10).trim() }] },
			{ summary: "a.txt (1 edit)", startLines: [7], newStartLines: [7] },
			{ width: 30 },
		);
		expect(lines.join("\n")).toMatchInlineSnapshot(`
			" ✓ edit a.txt · 1 edit
			   │ 7 - x
			   │ 7 + word word word word
			   │     word word word word
			   │     word word"
		`);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("highlights a written file by its extension and colors a diff's marks", () => {
		const write = card(
			"write",
			{ path: "a.ts", content: "const a = 1;" },
			{ summary: "a.ts (12 B)" },
			{ paint: tagged },
		);
		expect(write.lines[1]).toContain("<dim>1</> <magenta>const</>");
		const edit = card(
			"edit",
			{ path: "a.ts", edits: [{ oldText: "keep\nold", newText: "keep\nnew" }] },
			{ summary: "a.ts (1 edit)", startLines: [3], newStartLines: [3] },
			{ paint: tagged },
		).lines.join("\n");
		expect(edit).toContain("<dim>3</>   <dim>keep</>");
		expect(edit).toContain("<dim>4</> <red>-</> <red>old</>");
		expect(edit).toContain("<dim>4</> <green>+</> <green>new</>");
	});

	it("highlights a command as bash", () => {
		const { lines } = card("bash", { command: 'echo "hi" # greet' }, { summary: "echo (exit 0)" }, { paint: tagged });
		expect(lines[1]).toContain("<dim># greet</>");
	});
});

describe("ToolCard backgrounds", () => {
	/** Colors as a terminal would get them, which `styleText` leaves out when the tests' output is not one. */
	const colored: Paint = (style, text) => styleText(style, text, { validateStream: false });
	const DARK = { r: 30, g: 30, b: 30 };
	const LIGHT = { r: 255, g: 255, b: 255 };
	const edit = {
		path: "a.ts",
		edits: [{ oldText: "const a = 1;\nkeep();", newText: "const a = 2;\nkeep();" }],
	};
	const done = { summary: "a.ts (1 edit)", startLines: [1], newStartLines: [1] };

	function tones(background: typeof DARK | undefined, mode: "truecolor" | "256color" = "truecolor") {
		const t = new Tones(true);
		t.match(background, mode);
		return t;
	}

	/** Each 24-bit background a line sets, as `r,g,b`. */
	const backgrounds = (line: string) =>
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the background's sequence is what is matched
		[...line.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) => m.slice(1).map(Number));

	it("puts every line of the card on its own background, the terminal's a little lighter, full width", () => {
		const { lines } = card("edit", edit, done, { paint: colored, tones: tones(DARK), width: 60 });
		for (const line of lines) {
			expect(line.startsWith("\x1b[48;2;")).toBe(true);
			expect(line.endsWith("\x1b[49m")).toBe(true);
			expect(visibleWidth(line)).toBe(60);
		}
		const [card0] = backgrounds(lines[0] ?? "");
		for (const channel of card0 ?? []) expect(channel).toBeGreaterThan(30);
	});

	it("darkens the card's background on a light terminal", () => {
		const { lines } = card(
			"bash",
			{ command: "ls" },
			{ summary: "ls (exit 0)" },
			{ paint: colored, tones: tones(LIGHT) },
		);
		const [card0] = backgrounds(lines[0] ?? "");
		for (const channel of card0 ?? []) expect(channel).toBeLessThan(255);
	});

	it("bands a diff's removed lines in dark red and added lines in dark green, highlighting their code over the band", () => {
		const bands = (background: typeof DARK) => {
			const { lines } = card("edit", edit, done, { paint: colored, tones: tones(background) });
			const find = (text: string) => lines.find((line) => stripTerminalSequences(line).includes(text)) ?? "";
			const removed = find("1 - const");
			const added = find("1 + const");
			const kept = find("keep");
			expect(new Set(backgrounds(kept).map(String)).size).toBe(1);
			expect(removed).toContain("\x1b[35mconst\x1b[39m");
			expect(added).toContain("\x1b[35mconst\x1b[39m");
			for (const line of [removed, added]) expect(visibleWidth(line)).toBe(80);
			return { removed: backgrounds(removed)[1], added: backgrounds(added)[1] };
		};
		const dark = bands(DARK);
		expect(dark).toEqual({ removed: [122, 41, 54], added: [34, 92, 43] });
		// The same red and green whatever the terminal's hue: never mixed into a violet or a teal.
		expect(bands({ r: 40, g: 44, b: 52 })).toEqual(dark);
		expect(bands({ r: 0, g: 43, b: 54 })).toEqual(dark);
	});

	it("bands a diff in light red and light green on a light terminal", () => {
		const { lines } = card("edit", edit, done, { paint: colored, tones: tones(LIGHT) });
		const find = (text: string) => lines.find((line) => stripTerminalSequences(line).includes(text)) ?? "";
		expect(backgrounds(find("1 - const"))[1]).toEqual([255, 205, 210]);
		expect(backgrounds(find("1 + const"))[1]).toEqual([205, 240, 205]);
	});

	it("uses the terminal's 256 colors when it has no more, a fixed red and green for a diff", () => {
		const { lines } = card("edit", edit, done, { paint: colored, tones: tones(DARK, "256color") });
		const text = lines.join("\n");
		expect(text).toContain("\x1b[48;5;");
		expect(text).not.toContain("\x1b[48;2;");
		const find = (line: string) => lines.find((l) => stripTerminalSequences(l).includes(line)) ?? "";
		expect(find("1 - const")).toContain("\x1b[48;5;52m");
		expect(find("1 + const")).toContain("\x1b[48;5;22m");
		const light = card("edit", edit, done, { paint: colored, tones: tones(LIGHT, "256color") }).lines;
		expect(light.find((l) => stripTerminalSequences(l).includes("1 - const"))).toContain("\x1b[48;5;224m");
		expect(light.find((l) => stripTerminalSequences(l).includes("1 + const"))).toContain("\x1b[48;5;194m");
	});

	it("adds no background until the terminal says its own, and colors a diff's text instead", () => {
		const { lines } = card("edit", edit, done, { paint: colored, tones: tones(undefined) });
		const text = lines.join("\n");
		expect(text).not.toContain("\x1b[48");
		expect(text).not.toContain("\x1b[10");
		expect(text).toContain(colored("red", "const a = 1;"));
	});

	it("adds no escape without color", () => {
		const off = new Tones(false);
		off.match(DARK, "truecolor");
		const { lines } = card("edit", edit, done, { tones: off });
		expect(lines.join("\n")).not.toContain("\x1b[");
	});

	it("keeps a diff's bands apart from the card and from each other in 256 colors, on any background", () => {
		for (const background of [
			{ r: 40, g: 44, b: 52 },
			{ r: 0, g: 0, b: 0 },
			{ r: 30, g: 30, b: 30 },
			{ r: 255, g: 255, b: 255 },
			{ r: 253, g: 246, b: 227 },
		]) {
			const { lines } = card("edit", edit, done, { paint: colored, tones: tones(background, "256color") });
			const codes = (text: string) =>
				[...(lines.find((line) => stripTerminalSequences(line).includes(text)) ?? "").matchAll(/48;5;(\d+)m/g)].map(
					(m) => m[1],
				);
			const [cardCode] = codes("✓ edit");
			const [, removedCode] = codes("1 - const");
			const [, addedCode] = codes("1 + const");
			const terminal = /48;5;(\d+)m/.exec(
				backgroundAnsi(rgbColor(background.r, background.g, background.b), "256color"),
			)?.[1];
			expect(new Set([cardCode, removedCode, addedCode]).size, JSON.stringify(background)).toBe(3);
			expect([removedCode, addedCode], JSON.stringify(background)).not.toContain(terminal);
		}
	});
});

describe("ToolCard with large input", () => {
	const colored: Paint = (style, text) => styleText(style, text, { validateStream: false });
	const long = "a".repeat(200_000);
	const quickly = (render: () => string[]) => {
		const start = performance.now();
		const lines = render();
		expect(performance.now() - start).toBeLessThan(1000);
		return lines;
	};

	it("cuts a very long line of a written file, an edit or a command instead of hanging on it", () => {
		const tones = new Tones(true);
		tones.match({ r: 30, g: 30, b: 30 }, "truecolor");
		const write = quickly(() => card("write", { path: "a.ts", content: long }, { summary: "a.ts (195 KB)" }).lines);
		expect(write.length).toBeLessThan(20);
		expect(write.join("\n")).toContain("…");
		const edit = quickly(
			() =>
				card(
					"edit",
					{ path: "a.ts", edits: [{ oldText: long, newText: `${long}b` }] },
					{ summary: "a.ts (1 edit)", startLines: [1], newStartLines: [1] },
					{ paint: colored, tones },
				).lines,
		);
		expect(edit.length).toBeLessThan(30);
		const bash = quickly(() => card("bash", { command: `echo ${long}` }, { summary: "echo (exit 0)" }).lines);
		expect(bash.length).toBeLessThan(20);
	});

	it("keeps another tool's JSON values within the card's lines, however long", () => {
		const lines = quickly(
			() =>
				card(
					"memory",
					{ action: "save", tags: Array.from({ length: 20_000 }, (_, i) => `tag${i}`), meta: { body: long } },
					{ summary: "save (1 memory)" },
				).lines,
		);
		expect(lines.length).toBeLessThan(25);
		expect(lines.join("\n")).toContain("…");
	});

	it("numbers an edit of thousands of edits without slowing down", () => {
		const count = 2000;
		// Each edit adds forty lines: what it moves the edits after it by is counted once, not once for each of them.
		const extra = Array.from({ length: 39 }, (_, k) => `more${k}`).join("\n");
		const edits = Array.from({ length: count }, (_, i) => ({ oldText: `l${i}`, newText: `L${i}\n${extra}` }));
		// The file's order is the reverse of the call's.
		const startLines = edits.map((_, i) => 2 * (count - i));
		// Each edit before it in the file added 39 lines.
		const newStartLines = startLines.map((start, i) => start + 39 * (count - 1 - i));
		const lines = quickly(
			() =>
				card("edit", { path: "a.txt", edits }, { summary: `a.txt (${count} edits)`, startLines, newStartLines }).lines,
		);
		const text = lines.join("\n");
		// The first in the file moves nothing; the last moves by 39 lines for each edit before it.
		expect(text).toContain(`   │     2 - l${count - 1}\n   │     2 + L${count - 1}\n   │     3 + more0`);
		expect(text).toContain(`   │  ${2 * count} - l0\n   │ ${2 * count + 39 * (count - 1)} + L0`);
	});
});
