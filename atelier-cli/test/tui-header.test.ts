import { styleText } from "node:util";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Header, StatusBar, type StatusBarState } from "../src/tui/header.ts";
import { painter } from "../src/tui/style.ts";

const state = {
	cwd: "/home/me/code/app",
	home: "/home/me",
	branch: "feature/fixed-status-bar",
	changes: 3,
	model: "claude-opus-5-5",
	effort: "high",
	profile: "claude",
	context: { tokens: 110_000, window: 1_000_000, compactAt: 983_616 },
	costUsd: 0.42,
} satisfies StatusBarState;
const right = "ctx ▰▱▱▱▱▱▱▱ 11% · 1M · $0.42";
const bar = (value: StatusBarState = state, color = false) =>
	new StatusBar(
		color ? (style, text) => styleText(style, text, { validateStream: false }) : painter(false),
		() => value,
	);

describe("status bar", () => {
	it("shows the full home-relative path and right-aligns the context and cost at 120 columns", () => {
		const left = "~/code/app feature/fixed-status-bar ±3 · claude-opus-5-5 high · profile claude";
		expect(bar().render(120)).toEqual([left + " ".repeat(120 - left.length - right.length) + right]);
	});

	it("shortens the path before the branch, then cuts the branch before other fields", () => {
		const left = "app feature/fixed-status-bar ±3 · claude-opus-5-5 high · profile claude";
		expect(bar().render(left.length + right.length + 1)).toEqual([`${left} ${right}`]);
		expect(bar().render(80).map(stripTerminalSequences)).toEqual([
			`app fe… ±3 · claude-opus-5-5 high · profile claude ${right}`,
		]);
	});

	it("keeps the whole right block when it exactly fits the terminal", () => {
		expect(bar().render(right.length)).toEqual([right]);
		const halfDollar = right.replace("$0.42", "$0.50");
		expect(bar({ ...state, costUsd: 0.5 }).render(halfDollar.length)).toEqual([halfDollar]);
	});

	it("protects the right block at tiny widths and measures styled Unicode in terminal cells", () => {
		const unicode = bar({ ...state, cwd: "/work/日本語", branch: "開発/界" }, true);
		for (const width of [0, 1, 10, 31, 40, 60, 80, 120]) {
			const lines = unicode.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
			if (width >= 40)
				expect(stripTerminalSequences(lines[0] ?? "")).toMatch(new RegExp(`${right.replace("$", "\\$")}$`));
		}
	});

	it("leaves unknown data out, uses the backend for a default model and marks control characters", () => {
		const line =
			bar({ cwd: "/work/app", backend: "fake", branch: "bad\nbranch", profile: "a\x1b[2J" }).render(80)[0] ?? "";
		expect(line).toContain("/work/app bad␊branch · fake · profile a␛[2J");
		expect(line).not.toContain("ctx");
		expect(line).not.toContain("$");
	});

	it("reuses the gauge's compaction marker and warning/danger colors", () => {
		for (const [tokens, color] of [
			[150_000, "33"],
			[190_000, "31"],
		] as const) {
			const lines = bar({ ...state, context: { tokens, window: 1_000_000, compactAt: 200_000 } }, true).render(120);
			expect(lines[0]).toContain(`\x1b[${color}mctx`);
		}
		expect(bar({ ...state, context: { ...state.context, unknown: true } }).render(120)[0]).toContain(
			"ctx ▱▱▱▱▱▱▱▱ ? · 1M",
		);
	});

	it("omits the counter for clean or unknown status", () => {
		expect(bar({ ...state, changes: 0 }).render(120)[0]).not.toContain("±");
		const { changes: _changes, ...unknown } = state;
		expect(bar(unknown).render(120)[0]).not.toContain("±");
	});

	it("preserves the scrolling header outside fullscreen", () => {
		expect(new Header(painter(false), () => ({ ...state, version: "0.5.0" })).render(120)).toEqual([
			" Atelier 0.5.0 · ~/code/app",
			" claude-opus-5-5 high",
			"",
		]);
	});
});
