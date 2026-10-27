import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type FeatureState, featureAfter, featurePanelLines, featureProgress } from "../src/tui/feature-panel.ts";
import { footerAfter } from "../src/tui/footer.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (body: Body) => ({ ...body, seq: 1, turnId: "t" }) as AtelierEvent;
const text = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");

const changed: Body = {
	type: "feature_changed",
	name: "m14-tui",
	path: "odd/tasks/m14-tui.md",
	title: "M14 – TUI",
	tasks: [
		{ id: "T1", title: "Hot model", specs: ["S2"], status: "done", commit: "34e37d5" },
		{ id: "T2", title: "Hot profile", specs: ["S3"], status: "in_progress" },
		{ id: "T3", title: "Hot backend", specs: ["S4"], status: "blocked" },
		{ id: "T10", title: "Sessions", specs: ["S5"], status: "dropped" },
		{ id: "T5", title: "TUI base", specs: ["S6"] },
	],
};
const state = featureAfter(undefined, stamp(changed)) as FeatureState;

describe("feature state", () => {
	it("is what the main agent's latest feature_changed said", () => {
		expect(state).toEqual({
			name: "m14-tui",
			path: "odd/tasks/m14-tui.md",
			title: "M14 – TUI",
			tasks: (changed as Extract<Body, { type: "feature_changed" }>).tasks,
		});
		const next = featureAfter(state, stamp({ ...changed, title: "M15", tasks: [] }));
		expect(next?.title).toBe("M15");
		expect(next?.tasks).toEqual([]);
	});

	it("ignores a subagent's feature and every other event", () => {
		expect(featureAfter(state, stamp({ ...changed, title: "child", parentCallId: "c1", agent: "worker" }))).toBe(state);
		expect(featureAfter(state, stamp({ type: "phase_changed", phase: "planning", source: "inferred" }))).toBe(state);
		expect(featureAfter(undefined, stamp({ type: "phase_changed", phase: "planning", source: "inferred" }))).toBe(
			undefined,
		);
	});

	it("gives the footer the same progress the panel shows", () => {
		expect(featureProgress(state)).toEqual({ id: "T2", done: 1, total: 5 });
		expect(featureProgress({ ...state, tasks: [] })).toEqual({ done: 0, total: 0 });
		expect(footerAfter({}, stamp(changed)).task).toEqual(featureProgress(state));
	});
});

describe("feature panel", () => {
	it("says nothing while no feature is active", () => {
		expect(featurePanelLines(undefined, true, 80, plain)).toEqual([]);
	});

	it("is one line folded: the title, the tasks done and the one in progress", () => {
		expect(text(featurePanelLines(state, false, 100, plain))).toBe(
			" ◆ M14 – TUI · 1/5 done · now T2 Hot profile · Ctrl+T or /feature: tasks",
		);
	});

	it("unfolds into a table of every task's id, state and deliverable, marking the one in progress", () => {
		expect(text(featurePanelLines(state, true, 100, plain))).toBe(
			[
				" ◆ M14 – TUI · 1/5 done · now T2 Hot profile · odd/tasks/m14-tui.md",
				"     ID   State        Deliverable",
				"     T1   done         Hot model",
				"   ▸ T2   in progress  Hot profile",
				"     T3   blocked      Hot backend",
				"     T10  dropped      Sessions",
				"     T5   —            TUI base",
			].join("\n"),
		);
	});

	it("leaves out the task in progress when there is none, and the table when there are no tasks", () => {
		const idle = { ...state, tasks: [{ id: "T1", title: "Hot model", specs: [], status: "pending" }] };
		expect(text(featurePanelLines(idle, true, 100, plain))).toBe(
			[
				" ◆ M14 – TUI · 0/1 done · odd/tasks/m14-tui.md",
				"     ID  State    Deliverable",
				"     T1  pending  Hot model",
			].join("\n"),
		);
		expect(featurePanelLines({ ...state, tasks: [] }, true, 100, plain)).toHaveLength(1);
	});

	it("fits every line in a narrow terminal", () => {
		for (const width of [1, 8, 20, 33])
			for (const open of [false, true])
				for (const line of featurePanelLines(state, open, width, plain))
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("shows control characters in the feature's strings as markers", () => {
		const hostile = featureAfter(
			undefined,
			stamp({
				...changed,
				title: "x\u001b[31my",
				path: "p\u001b",
				tasks: [{ id: "T\u001b1", title: "t\u0007", specs: [], status: "in\u001bprogress" }],
			}),
		) as FeatureState;
		const shown = [...featurePanelLines(hostile, true, 100, plain), ...featurePanelLines(hostile, false, 100, plain)];
		expect(text(shown)).toContain("x␛[31my");
		expect(text(shown)).toContain("T␛1");
		expect(text(shown)).toContain("in␛progress");
		expect(text(shown)).not.toContain("\u001b");
		expect(text(shown)).not.toContain("\u0007");
	});
});
