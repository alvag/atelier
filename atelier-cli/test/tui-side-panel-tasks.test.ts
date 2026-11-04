import type { AtelierEvent, FeatureTask } from "@atelier/core";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { footerAfter, footerLine } from "../src/tui/footer.ts";
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
const stateOf = (tasks: FeatureTask[]) => sidePanelAfter(emptySidePanel(), featureEvent(tasks), 0);

function render(tasks: FeatureTask[], p = plain, view: Partial<PanelView> = {}) {
	return sidePanelLines({ state: stateOf(tasks), now: 0, startedAt: 0, tab: "status", ...view }, p.ink, p.paint, WIDTH);
}
const at = (left: string, right: string) =>
	`${left}${" ".repeat(WIDTH - visibleWidth(left) - visibleWidth(right))}${right}`;
const rgb = (hex: string) => `\x1b[38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;

describe("side panel tasks summary", () => {
	it("shows the header, the title, a full-width bar, the active rows, three pending and a tail", () => {
		const { lines, current } = render([
			task("T1", "done"),
			task("T2", "done"),
			task("T3", "in_progress", { note: "wiring the renderer" }),
			task("T4", "blocked", { note: "decide the scope" }),
			task("T5", "blocked"),
			...["T6", "T7", "T8", "T9", "T10"].map((id) => task(id, "pending")),
			task("T11", "dropped"),
		]);
		expect(lines).toEqual([
			at("TASKS", "2/10 · ctrl+t"),
			"The feature",
			`${"▰".repeat(7)}${"▱".repeat(30)}`,
			"◐ Title T3".padEnd(WIDTH),
			"  wiring the renderer",
			"⊘ Title T4",
			"  waiting: decide the scope",
			"⊘ Title T5",
			"○ Title T6",
			"○ Title T7",
			"○ Title T8",
			"+2 pending · 2 done · 1 dropped",
		]);
		expect(current).toEqual({ start: 3, end: 4 });
	});

	it("leaves out the tail's zero counts and the whole tail when nothing is hidden", () => {
		expect(render([task("T1", "in_progress"), task("T2", "pending")]).lines.at(-1)).toBe("○ Title T2");
		expect(render([task("T1", "done"), task("T2", "pending")]).lines.at(-1)).toBe("1 done");
	});

	it("keeps a task without state visible", () => {
		const { lines } = render([task("T1", undefined), task("T2", undefined)]);
		expect(lines.slice(3)).toEqual(["· Title T1", "· Title T2"]);
	});

	it("lists every task in progress, then every blocked one, then three pending, each group in document order", () => {
		const { lines, current } = render([
			task("P1", "pending"),
			task("B1", "blocked"),
			task("I1", "in_progress"),
			task("P2", "pending"),
			task("I2", "in_progress"),
			task("P3", "pending"),
			task("B2", "blocked"),
			task("P4", "pending"),
		]);
		expect(lines.slice(3).map((l) => l.trimEnd())).toEqual([
			"◐ Title I1",
			"◐ Title I2",
			"⊘ Title B1",
			"⊘ Title B2",
			"○ Title P1",
			"○ Title P2",
			"○ Title P3",
			"+1 pending",
		]);
		expect(current).toEqual({ start: 3, end: 3 });
	});

	it("keeps tasks without state and the blocked ones visible among three pending", () => {
		const { lines } = render([task("L1", undefined), task("P1", "pending"), task("B1", "blocked")]);
		expect(lines.slice(3)).toEqual(["⊘ Title B1", "· Title L1", "○ Title P1"]);
	});

	it("shows a blocked note on two rows at most, wrapped under its first words and cut with …", () => {
		const note = "the scope of the cache is open and the reviewer has not answered yet so nothing moves until they do";
		const { lines } = render([task("B1", "blocked", { note })]);
		expect(lines).toHaveLength(6);
		expect(lines[4]).toMatch(/^ {2}waiting: .+/);
		expect(lines[4]).not.toMatch(/…$/);
		expect(lines[5]).toMatch(/^ {2}\S.*…$/);
		expect(lines.map(visibleWidth).every((w) => w <= WIDTH)).toBe(true);
	});

	it("cuts a title to one row and a note to two rows", () => {
		const { lines } = render([
			task("T1", "in_progress", {
				title: "A title much too long for the one row the summary gives it",
				note: "first words of the note that fill a row and go on to a second one then a third row of it",
			}),
		]);
		expect(
			lines
				.slice(3)
				.map(visibleWidth)
				.every((w) => w <= WIDTH),
		).toBe(true);
		expect(lines.slice(3)).toHaveLength(3);
		expect(lines[3]).toMatch(/^◐ A title much .*…\s*$/);
		expect(lines[5]).toMatch(/…$/);
	});

	it("counts dropped tasks out of the total, and leaves the footer's progress and the feature panel's alone", () => {
		const tasks = [task("T1", "done"), task("T2", "dropped"), task("T3", "pending")];
		expect(render(tasks).lines[0]).toBe(at("TASKS", "1/2 · ctrl+t"));
		expect(render(tasks.slice(0, 2)).lines[2]).toBe("▰".repeat(WIDTH));
		const footer = footerAfter({}, featureEvent(tasks));
		expect(footer.task).toEqual({ done: 1, total: 3 });
		expect(footerLine(footer, 80, painter(false), ["task"])).toBe(" 1/3");
	});

	it("paints the bar and the marks, the running title bold on the surface across the row, a pending title as text", () => {
		const { lines } = render(
			[task("T1", "done"), task("T2", "in_progress"), task("T3", "blocked", { note: "x" }), task("T4", "pending")],
			colored,
		);
		expect(lines[2]).toContain(`${rgb(activeTheme.success)}${"▰".repeat(9)}`);
		expect(lines[2]).toContain(`${rgb(activeTheme.textSecondary)}${"▱".repeat(28)}`);
		const running = lines[3] ?? "";
		expect(running).toContain(`${rgb(activeTheme.textSecondary)}◐`);
		expect(running).toContain(`\x1b[1m${rgb(activeTheme.text)}Title T2`);
		expect(running).toContain("\x1b[48;2;47;56;63m");
		expect(visibleWidth(running)).toBe(WIDTH);
		expect(lines[4]).toContain(`${rgb(activeTheme.warning)}⊘`);
		expect(lines[4]).not.toContain("\x1b[1m");
		expect(lines[5]).toContain(`${rgb(activeTheme.warning)}waiting: x`);
		expect(lines[6]).toContain(`${rgb(activeTheme.textSecondary)}○`);
		expect(lines[6]).toContain(`${rgb(activeTheme.text)}Title T4`);
	});

	it.each([
		["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "ghijklmnopqrstuvwxyz"],
		["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".repeat(2), "ghijklmnopqrstuvwxyzABCDEFGHIJK…"],
	])("wraps an overlong first title word without losing characters: %s", (title, second) => {
		const { lines } = render([task("T1", "pending", { title })], plain, { tasksExpanded: true });
		expect(lines.slice(3, -1)).toEqual(["○ T1 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef", `     ${second}`]);
		expect(lines.join("\n")).not.toContain("\x1b");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});

	it.each([
		["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "jklmnopqrstuvwxyz"],
		["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".repeat(2), "jklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ…"],
	])("wraps an overlong first note word without losing characters: %s", (note, second) => {
		const { lines } = render([task("T1", "in_progress", { note })]);
		expect(lines.slice(4)).toEqual(["  ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", `  ${second}`]);
		expect(lines.join("\n")).not.toContain("\x1b");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});

	it.each([
		["plain pending", plain, "pending"],
		["colored pending", colored, "pending"],
		["plain done", plain, "done"],
		["colored done", colored, "done"],
	] as const)("keeps the title and commit inside 37 columns with a UUID: %s", (_label, p, status) => {
		const id = "123e4567-e89b-12d3-a456-426614174000";
		const { lines } = render([task(id, status, { title: "Keep title", commit: "abc1234def" })], p, {
			tasksExpanded: true,
		});
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		const first = stripTerminalSequences(lines[3] ?? "");
		expect(first).toContain("123e4567");
		expect(first).not.toContain(id);
		expect(first).toContain("… Keep title");
		if (status === "done") expect(first).toMatch(/Keep title\s+abc1234$/);
	});

	it("lists every task in order with its id after ctrl+t, and a hint to go back", () => {
		const { lines, current } = render(
			[
				task("T1", "done"),
				task("T2", "pending"),
				task("T3", "in_progress"),
				task("T4", "dropped"),
				task("T5", "pending"),
			],
			plain,
			{ tasksExpanded: true },
		);
		expect(lines.slice(3).map((l) => l.trimEnd())).toEqual([
			"✓ T1 Title T1",
			"○ T2 Title T2",
			"◐ T3 Title T3",
			"– T4 Title T4",
			"○ T5 Title T5",
			"ctrl+t summary",
		]);
		expect(current).toEqual({ start: 5, end: 5 });
	});
});
