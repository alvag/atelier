import type { AtelierEvent, JsonValue } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type Paint, painter } from "../src/tui/style.ts";
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
	{ took = 0, width = 80, paint = plain }: { took?: number; width?: number; paint?: Paint } = {},
) {
	const time = clock();
	const view = { expanded: true };
	const tc = new ToolCard(tool, input, view, paint, "c1", time.now);
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
		expect(ok[1]).toMatch(/^ <green>▎<\/> <dim>\$<\/> /);
		const failed = card("bash", { command: "ls" }, { ok: false, summary: "ls (exit 1)" }, { paint: tagged });
		expect(failed.lines[0]).toBe(" <red>✗</> <bold>bash</> ls <red>· exit 1</>");
		expect(failed.lines[1]).toMatch(/^ <red>▎<\/>/);
		expect(failed.card.alerts()).toEqual(["<red>✗</> <bold>bash</> <red>ls · exit 1</>"]);
		const grep = card("grep", { pattern: "mode" }, { summary: "mode: 1 match" }, { paint: tagged }).lines;
		expect(grep[1]).toContain("<dim>pattern</> <yellow>mode</>");
		const memory = card("memory", { action: "get", id: 7 }, { summary: "get" }, { paint: tagged }).lines;
		expect(memory.join("\n")).toContain("<dim>id    </> <yellow>7</>");
	});

	it("highlights a command as bash", () => {
		const { lines } = card("bash", { command: 'echo "hi" # greet' }, { summary: "echo (exit 0)" }, { paint: tagged });
		expect(lines[1]).toContain("<dim># greet</>");
	});
});
