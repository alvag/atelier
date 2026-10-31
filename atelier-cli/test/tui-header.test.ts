import { stripTerminalSequences, type TerminalColorMode, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { GitChanges } from "../src/tui/git-branch.ts";
import { Header, StatusBar, type StatusBarState } from "../src/tui/header.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink, type ThemeToken } from "../src/tui/theme.ts";

const state = {
	cwd: "/home/me/Projects/gentle-shell-pi-desktop/atelier",
	home: "/home/me",
	version: "0.6.0",
	branch: "feat/semantic-header",
	git: { lines: { added: 12, removed: 4 }, commits: { ahead: 2, behind: 1 } },
	model: "claude-opus-5-5",
	effort: "medium",
	profile: "claude-gpt",
	context: { tokens: 250_000, window: 1_000_000, compactAt: 983_616 },
	costUsd: 0.07,
} satisfies StatusBarState;

const header = (value: StatusBarState = state, mode?: TerminalColorMode) =>
	new StatusBar(ink(activeTheme, mode !== undefined, mode ?? "truecolor"), () => value);
const plain =
	(value: StatusBarState = state) =>
	(width: number) =>
		header(value).render(width);
/** The text a token paints, as the header paints it in truecolor. */
const painted = (token: ThemeToken, text: string) => ink(activeTheme, true, "truecolor").fg(token, text);
/** The SGR sequence that starts `token`'s color. */
const opening = (token: ThemeToken) => painted(token, "x").split("x")[0] ?? "";

/** The background parameters of a row's SGR sequences: the extended colors' own numbers are skipped. */
function backgrounds(row: string): string[] {
	const found: string[] = [];
	// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences.
	for (const [, params = ""] of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
		const list = params.split(";").map(Number);
		for (let i = 0; i < list.length; i++) {
			const param = list[i] ?? 0;
			if (param === 48 || (param >= 40 && param <= 47) || (param >= 100 && param <= 107)) found.push(params);
			if (param === 38 || param === 48 || param === 58) i += list[i + 1] === 5 ? 2 : 4;
		}
	}
	return found;
}

describe("fullscreen header", () => {
	it("shows the three blocks in two rows under a rule at 120 and 200 columns", () => {
		expect(plain()(120)).toEqual([
			"Atelier │ ~/Projects/gentle-shell-pi-desktop/atelier                       │ claude-opus-5-5 medium · Profile claude-gpt",
			"v0.6.0  │ feat/semantic-header · +12 −4 · ↑2 ↓1                            │ ctx ▰▰▱▱▱▱▱▱ 25% · 1M · cost $0.07",
			"─".repeat(120),
		]);
		const wide = plain()(200);
		expect(wide[0]).toBe(
			`Atelier │ ~/Projects/gentle-shell-pi-desktop/atelier${" ".repeat(103)}│ claude-opus-5-5 medium · Profile claude-gpt`,
		);
		expect(wide[1]).toBe(
			`v0.6.0  │ feat/semantic-header · +12 −4 · ↑2 ↓1${" ".repeat(108)}│ ctx ▰▰▱▱▱▱▱▱ 25% · 1M · cost $0.07`,
		);
		expect(wide[2]).toBe("─".repeat(200));
	});

	it("sizes the identity block by its longest text plus one column", () => {
		expect(plain({ ...state, version: "10.20.300" })(120)[0]).toMatch(/^Atelier {4}│ ~/);
		expect(plain({ ...state, version: "10.20.300" })(120)[1]).toMatch(/^v10\.20\.300 │ feat/);
		const { version: _version, ...unknown } = state;
		expect(plain(unknown)(120)[0]).toMatch(/^Atelier │ ~/);
		expect(plain(unknown)(120)[1]).toMatch(/^ {8}│ feat/);
	});

	it("shortens the path to its folder before anything else", () => {
		const rows = plain()(95);
		expect(rows[0]).toMatch(/^Atelier │ atelier +│ claude-opus-5-5 medium · Profile claude-gpt$/);
		expect(rows[1]).toContain("│ feat/semantic-header · +12 −4 · ↑2 ↓1 ");
	});

	it("cuts the folder with … before dropping the Profile label", () => {
		const long = { ...state, cwd: "/home/me/a-very-long-project-folder-name", branch: "main" };
		const rows = plain(long)(81);
		expect(rows[0]).toMatch(/^Atelier │ a-very-long-project-fold… +│ claude-opus-5-5 medium · Profile claude-gpt$/);
		expect(rows[1]).toContain("│ main · +12 −4 · ↑2 ↓1 ");
	});

	it("drops the Profile label before cutting the branch", () => {
		const rows = plain()(88);
		expect(rows[0]).toMatch(/│ claude-opus-5-5 medium · claude-gpt$/);
		expect(rows[1]).toContain("│ feat/semantic-header · +12 −4 · ↑2 ↓1 ");
	});

	it("cuts the branch last at 80 columns, keeping the Git counters", () => {
		expect(plain()(80)).toEqual([
			`Atelier │ atelier${" ".repeat(26)}│ claude-opus-5-5 medium · claude-gpt`,
			"v0.6.0  │ feat/semantic-… · +12 −4 · ↑2 ↓1 │ ctx ▰▰▱▱▱▱▱▱ 25% · 1M · cost $0.07",
			"─".repeat(80),
		]);
	});

	it("then drops whole right-hand items: the profile name, the cost, the window, never cutting a word", () => {
		const seen: string[][] = [];
		for (let width = 80; width >= 30; width--) {
			const rows = plain()(width);
			const right = rows.slice(0, 2).map((row) => row.slice(row.lastIndexOf("│ ") + 2));
			const items = [
				right[0]?.includes("claude-gpt") && "profile",
				right[1]?.includes("cost $0.07") && "cost",
				right[1]?.includes("· 1M") && "window",
			].filter((item) => typeof item === "string");
			if (!rows.some((row) => row.endsWith("…"))) {
				// Until the rows are cut, the model, its effort, the bar and the percentage stay whole.
				expect(right[0]).toMatch(/^claude-opus-5-5 medium( · claude-gpt)?$/);
				expect(right[1]).toMatch(/^ctx ▰▰▱▱▱▱▱▱ 25%( · 1M)?( · cost \$0\.07)?$/);
				expect(rows[1]).toContain("+12 −4 · ↑2 ↓1");
			}
			if (seen.at(-1)?.join() !== items.join()) seen.push(items);
		}
		expect(seen).toEqual([["profile", "cost", "window"], ["cost", "window"], ["window"], []]);
	});

	it("never goes past the width, measuring wide characters in cells, and cuts each row last", () => {
		const wide = { ...state, cwd: "/work/日本語のプロジェクト", branch: "開発/界面" };
		for (const value of [state, wide])
			for (let width = 0; width <= 200; width++) {
				const rows = header(value, "truecolor").render(width);
				expect(rows).toHaveLength(3);
				for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		expect(plain()(40)[1]).toMatch(/^v0\.6\.0 {2}│ f… · \+12 −4 · ↑2 ↓1 /);
	});

	it("leaves unknown or zero data out, never showing it as zero", () => {
		const counters = (git: GitChanges) =>
			plain({ ...state, git })(120)[1]
				?.split("│")[1]
				?.trim();
		expect(counters({ lines: { added: 0, removed: 0 }, commits: { ahead: 0, behind: 0 } })).toBe(
			"feat/semantic-header",
		);
		expect(counters({ lines: { added: 0, removed: 4 }, commits: { ahead: 0, behind: 1 } })).toBe(
			"feat/semantic-header · −4 · ↓1",
		);
		expect(counters({ commits: { ahead: 2, behind: 0 } })).toBe("feat/semantic-header · ↑2");
		expect(counters({})).toBe("feat/semantic-header");
		const { context: _context, costUsd: _cost, profile: _profile, effort: _effort, ...bare } = state;
		expect(plain(bare)(120).slice(0, 2)).toEqual([
			`Atelier │ ~/Projects/gentle-shell-pi-desktop/atelier${" ".repeat(51)}│ claude-opus-5-5`,
			`v0.6.0  │ feat/semantic-header · +12 −4 · ↑2 ↓1${" ".repeat(56)}│`,
		]);
		expect(plain({ cwd: "/work/app" })(80)).toEqual(["Atelier │ /work/app", "        │", "─".repeat(80)]);
	});

	it("uses the backend for a default model and marks control characters", () => {
		const rows = plain({ cwd: "/work/a\tb", backend: "fake", branch: "bad\nbranch", profile: "a\x1b[2J" })(80);
		expect(rows[0]).toMatch(/^Atelier │ \/work\/a␉b +│ fake · Profile a␛\[2J$/);
		expect(rows[1]).toMatch(/^ {8}│ bad␊branch +│$/);
	});

	it("paints each element with its token and no background", () => {
		const rows = header(state, "truecolor").render(120);
		const [top = "", bottom = "", rule = ""] = rows;
		expect(top).toContain(painted("brand", "Atelier"));
		expect(top).toContain(painted("separator", "│"));
		expect(top).toContain(painted("text", "~/Projects/gentle-shell-pi-desktop/atelier"));
		expect(top).toContain(painted("text", "claude-opus-5-5"));
		expect(top).toContain(painted("focus", "medium"));
		expect(top).toContain(painted("separator", "·"));
		expect(top).toContain(painted("textSecondary", "Profile claude-gpt"));
		expect(bottom).toContain(painted("textSecondary", "v0.6.0"));
		expect(bottom).toContain(painted("text", "feat/semantic-header"));
		expect(bottom).toContain(painted("success", "+12"));
		expect(bottom).toContain(painted("error", "−4"));
		expect(bottom).toContain(painted("focus", "↑2 ↓1"));
		expect(bottom).toContain(painted("textSecondary", "ctx"));
		expect(bottom).toContain(painted("text", "1M"));
		expect(bottom).toContain(painted("textSecondary", "cost"));
		expect(bottom).toContain(painted("text", "$0.07"));
		expect(rule).toBe(painted("separator", "─".repeat(120)));
		for (const row of rows) expect(backgrounds(row)).toEqual([]);
	});

	it("colors the filled cells and the percentage by how close compaction is, and an unknown context gray", () => {
		const gauge = (context: StatusBarState["context"]) =>
			header({ ...state, ...(context === undefined ? {} : { context }) }, "truecolor").render(120)[1] ?? "";
		const at = (tokens: number) => gauge({ tokens, window: 1_000_000, compactAt: 200_000 });
		expect(gauge(state.context)).toContain(`${painted("success", "▰▰")}${painted("textSecondary", "▱▱▱▱▱▱")}`);
		expect(gauge(state.context)).toContain(painted("success", "25%"));
		expect(at(150_000)).toContain(`${painted("warning", "▰")}${painted("textSecondary", "▱▱▱▱▱▱▱")}`);
		expect(at(150_000)).toContain(painted("warning", "15%"));
		expect(at(190_000)).toContain(painted("error", "19%"));
		const row = gauge({ ...state.context, unknown: true });
		const unknown = row.slice(row.indexOf("ctx"));
		expect(stripTerminalSequences(unknown)).toContain("ctx ▱▱▱▱▱▱▱▱ ? · 1M");
		expect(unknown).toContain(painted("textSecondary", "▱▱▱▱▱▱▱▱"));
		expect(unknown).toContain(painted("textSecondary", "?"));
		expect(unknown).not.toContain(opening("success"));
	});

	it("keeps the same structure without color and maps the tokens to 256 colors", () => {
		for (const width of [200, 120, 80, 64])
			expect(header(state, "truecolor").render(width).map(stripTerminalSequences)).toEqual(plain()(width));
		const indexed = header(state, "256color").render(120);
		expect(indexed[0]).toContain("\x1b[38;5;173mAtelier");
		expect(indexed[0]).toContain("\x1b[38;5;147mmedium");
		expect(indexed[1]).toContain("\x1b[38;5;71m+12");
		expect(indexed[2]).toContain("\x1b[38;5;59m─");
		expect(plain()(120).join("")).not.toContain("\x1b");
	});

	it("preserves the scrolling header outside fullscreen", () => {
		expect(
			new Header(painter(false), () => ({ ...state, cwd: "/home/me/code/app", effort: "high" })).render(120),
		).toEqual([" Atelier 0.6.0 · ~/code/app", " claude-opus-5-5 high", ""]);
	});
});
