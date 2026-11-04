import type { AtelierEvent, FeatureTask } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type PanelView, sidePanelLines } from "../src/tui/side-panel.ts";
import { emptySidePanel, sidePanelAfter } from "../src/tui/side-panel-state.ts";
import { type Paint, painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const WIDTH = 37;
const plain = { ink: ink(activeTheme, false, "truecolor"), paint: painter(false) };
/** Fixed SGR codes: `styleText` drops styles when the test run is not a terminal. */
const sgr: Paint = (style, text) =>
	style === "bold" ? `\x1b[1m${text}\x1b[22m` : style === "strikethrough" ? `\x1b[9m${text}\x1b[29m` : text;
const colored = { ink: ink(activeTheme, true, "truecolor"), paint: sgr };

const task = (id: string, status: string | undefined, extra: Partial<FeatureTask> = {}): FeatureTask => ({
	id,
	title: `Title ${id}`,
	specs: [],
	...(status === undefined ? {} : { status }),
	...extra,
});
const featureEvent = (tasks: FeatureTask[]): AtelierEvent => ({
	type: "feature_changed",
	name: "f",
	path: "odd/tasks/f.md",
	title: "The feature",
	tasks,
	seq: 1,
	turnId: "t",
});

function full(tasks: FeatureTask[], p = plain, view: Partial<PanelView> = {}) {
	const state = sidePanelAfter(emptySidePanel(), featureEvent(tasks), 0);
	const { lines, current } = sidePanelLines(
		{ state, now: 0, startedAt: 0, tab: "status", tasksExpanded: true, ...view },
		p.ink,
		p.paint,
		WIDTH,
	);
	return { rows: lines.slice(3, -1), lines, current };
}
const at = (left: string, right: string) =>
	`${left}${" ".repeat(WIDTH - visibleWidth(left) - visibleWidth(right))}${right}`;
const rgb = (hex: string) => `\x1b[38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const LONG = "Wire the renderer into the side panel and keep every title on two rows";

describe("side panel full task list", () => {
	it("lists every task in document order with its id and ends with the way back", () => {
		const { rows, lines } = full([
			task("T1", "pending"),
			task("T2", "dropped"),
			task("T3", "in_progress"),
			task("T4", "blocked"),
			task("T5", undefined),
			task("T6", "done"),
			task("T7", "pending"),
			task("T8", "pending"),
			task("T9", "pending"),
			task("T10", "pending"),
		]);
		expect(rows.map((row) => row.trimEnd())).toEqual([
			"○ T1 Title T1",
			"– T2 Title T2",
			"◐ T3 Title T3",
			"⊘ T4 Title T4",
			"· T5 Title T5",
			"✓ T6 Title T6",
			"○ T7 Title T7",
			"○ T8 Title T8",
			"○ T9 Title T9",
			"○ T10 Title T10",
		]);
		expect(lines.at(-1)).toBe("ctrl+t summary");
	});

	it("shows a done task's commit, seven characters, at the right", () => {
		const { rows } = full([
			task("T1", "done", { commit: "0123456789abcdef" }),
			task("T2", "pending", { commit: "abcdef0" }),
		]);
		expect(rows[0]).toBe(at("✓ T1 Title T1", "0123456"));
		expect(rows[1]).toBe("○ T2 Title T2");
	});

	it("wraps a title on two rows at most and cuts the second with …", () => {
		const { rows } = full([
			task("T1", "pending", { title: "Wire the renderer into the panel today" }),
			task("T2", "pending", { title: `${LONG} ${LONG}` }),
		]);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toMatch(/^○ T1 Wire the renderer/);
		expect(rows[1]).toMatch(/^ {5}\S.*[^…]$/);
		expect(rows[3]).toMatch(/…$/);
		expect(rows.every((row) => visibleWidth(row) <= WIDTH)).toBe(true);
	});

	it("never cuts the commit of a done task: the first row leaves room, the second uses the width", () => {
		const { rows } = full([task("T1", "done", { title: LONG, commit: "abcdef01" })]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatch(/ abcdef0$/);
		expect(visibleWidth(rows[0] ?? "")).toBe(WIDTH);
		expect(rows[0]).toMatch(/^✓ T1 Wire the renderer/);
		expect(rows[0]?.slice(0, -8).trimEnd().length).toBeLessThanOrEqual(WIDTH - 8);
		expect(rows[1]?.length).toBeGreaterThan(WIDTH - 12);
		expect(visibleWidth(rows[1] ?? "")).toBeLessThanOrEqual(WIDTH);
	});

	it("keeps every row within 37 columns with wide characters, notes and ANSI ids", () => {
		const { rows } = full(
			[
				task("T1", "done", {
					title: "日本語のタイトルをここに書いて、とても長いので二行になります、さらに続く",
					commit: "abcdef0123",
				}),
				task("T2", "in_progress", { title: LONG, note: `${LONG} ${LONG} ${LONG}` }),
				task("T3", "blocked", { title: LONG, note: LONG + LONG }),
				task("\x1b[31mT4\x1b[0m", "dropped", { title: LONG }),
			],
			colored,
		);
		expect(rows.every((row) => visibleWidth(row) <= WIDTH)).toBe(true);
		const noteRows = rows.filter((row) => row.startsWith("  ") || row.includes("\x1b[48"));
		expect(noteRows.length).toBeGreaterThan(0);
	});

	it("limits a note to two rows under a long title", () => {
		const { rows } = full([task("T1", "in_progress", { title: LONG, note: `${LONG} ${LONG} ${LONG} ${LONG}` })]);
		expect(rows).toHaveLength(4);
		expect(rows[2]).toMatch(/^ {2}\S/);
		expect(rows[3]).toMatch(/^ {2}\S.*…$/);
	});

	it("colors the id and the commit dim, and keeps the marks, the strike and the surface across every title row", () => {
		const { rows } = full(
			[
				task("T1", "done", { title: LONG, commit: "abcdef0" }),
				task("T2", "dropped", { title: LONG }),
				task("T3", "in_progress", { title: LONG }),
			],
			colored,
		);
		const dim = rgb(activeTheme.textSecondary);
		expect(rows[0]).toContain(`${rgb(activeTheme.success)}✓`);
		expect(rows[0]).toContain(`${dim}T1`);
		expect(rows[0]).toContain(`${dim}abcdef0`);
		// Dropped: both title rows struck through.
		expect(rows[2]).toContain("\x1b[9m");
		expect(rows[3]).toContain("\x1b[9m");
		// In progress: both rows bold, on the surface, padded to the width.
		expect(rows[4]).toContain("\x1b[1m");
		expect(rows[5]).toContain("\x1b[1m");
		expect(rows[4]).toContain("\x1b[48;");
		expect(rows[5]).toContain("\x1b[48;");
		expect(visibleWidth(rows[4] ?? "")).toBe(WIDTH);
		expect(visibleWidth(rows[5] ?? "")).toBe(WIDTH);
	});

	it("reports the rows of the task in progress", () => {
		const { current } = full([task("T1", "done"), task("T2", "in_progress", { title: LONG })]);
		expect(current).toEqual({ start: 4, end: 5 });
	});

	it("lists tasks without state in the full list too", () => {
		expect(full([task("T1", undefined)]).rows).toEqual(["· T1 Title T1"]);
	});
});
