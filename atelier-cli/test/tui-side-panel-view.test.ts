/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: the screen is read from the terminal's escape codes */
import type { AtelierEvent } from "@atelier/core";
import { type Component, type Terminal, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SidePanel } from "../src/tui/side-panel-view.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const COLUMNS = 40;

const styles = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Waits for a condition the TUI reaches by its own renders. */
async function until(done: () => boolean): Promise<void> {
	const deadline = performance.now() + 2000;
	while (!done() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
}

/** A TUI that counts the renders asked of it. */
class CountingTui extends TuiAltScreen {
	requests = 0;
	override requestRender(force?: boolean): void {
		this.requests++;
		super.requestRender(force);
	}
}

/** The panel in the TUI, on a terminal of `rows` rows, and the screen its writes leave. */
async function mounted(rows: number, agents: number, topRows = 0) {
	let height = rows + topRows;
	let grid: string[] = Array.from({ length: height }, () => "");
	let onInput: (data: string) => void = () => {};
	const terminal: Terminal = {
		start: (input) => {
			onInput = input;
		},
		stop: () => {},
		drainInput: async () => {},
		write: (data) => {
			// Each repainted row is written as `ESC[row;1H`, `ESC[2K` and its text.
			for (const part of data.split(/(?=\x1b\[\d+;1H)/)) {
				const row = /^\x1b\[(\d+);1H/.exec(part);
				if (row?.[1] !== undefined) grid[Number(row[1]) - 1] = part.replace(styles, "");
			}
		},
		columns: COLUMNS,
		get rows() {
			return height;
		},
		kittyProtocolActive: false,
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: () => {},
		setProgress: () => {},
		setProgramStatus: () => {},
	};
	const tui = new CountingTui(terminal);
	const panel = new SidePanel(tui, ink(activeTheme, false, "truecolor"), painter(false), {
		open: true,
		columns: () => COLUMNS,
		context: () => ({ name: "n", savedId: "abc", mode: "m" }),
	});
	// The AGENTS header and one row for each running agent.
	for (let i = 0; i < agents; i++)
		panel.event({
			type: "tool_call_started",
			callId: `c${i}`,
			tool: "task",
			input: { agent: "worker", prompt: `job ${i}` },
			seq: i + 1,
			turnId: "t",
		} as AtelierEvent);
	// Counts the frames: it is laid out in each one.
	let frames = 0;
	const probe: Component = {
		render: () => {
			frames++;
			return [];
		},
		invalidate: () => {},
	};
	tui.setLayoutRoot(
		new VStack([
			{
				component: { render: () => Array.from({ length: topRows }, () => "header"), invalidate: () => {} },
				basis: topRows,
				shrink: 0,
			},
			{ component: panel.component, grow: 1 },
			{ component: probe, basis: 0, shrink: 0 },
		]),
	);
	tui.start();
	await until(() => frames > 0);
	return {
		panel,
		/** The renders asked for since the first frame. */
		requests: () => tui.requests,
		frames: () => frames,
		/** Asks for a render and waits for its frame. */
		frame: async () => {
			const before = frames;
			tui.requestRender();
			await until(() => frames > before);
		},
		/** Waits for the renders the panel asks for itself. */
		until,
		resize: (to: number) => {
			height = to + topRows;
			grid = Array.from({ length: height }, () => "");
			tui.requestRender();
		},
		/** The rows as text, without the rule and the space after it. */
		screen: () => grid.slice(topRows).map((line) => line.replace(/^\s*│\s?/, "").trimEnd()),
		ctrlN: () => {
			panel.toggleTab();
			tui.requestRender();
		},
		click: (label: string) => {
			const x = grid[topRows]?.replace(styles, "").indexOf(label) ?? -1;
			expect(x).toBeGreaterThanOrEqual(0);
			onInput(`\x1b[<0;${x + 1};${topRows + 1}M`);
			onInput(`\x1b[<0;${x + 1};${topRows + 1}m`);
		},
		wheel: (lines: number) => {
			for (let i = 0; i < lines; i++) onInput(`\x1b[<65;${COLUMNS - 5};5M`);
		},
		stop: () => {
			panel.stop();
			tui.stop();
		},
	};
}

let open: { stop: () => void } | undefined;
afterEach(() => open?.stop());
const track = <T extends { stop: () => void }>(view: T): T => {
	open = view;
	return view;
};

type View = Awaited<ReturnType<typeof mounted>>;
const switches: Record<string, (view: View, label: string) => void> = {
	"ctrl+n": (view) => view.ctrlN(),
	click: (view, label) => view.click(label),
};
const SESSION = ["Session", " n", " 0m · 0 turns · #abc", "Permissions", " m"];
const TABS = "Status  Session";

/** The panel asks for no render of its own: each frame asked for is the only one. */
async function expectStable(view: View): Promise<void> {
	const before = view.requests();
	await view.frame();
	await view.frame();
	expect(view.requests() - before).toBe(2);
}

describe("side panel tab overflow", () => {
	for (const [how, go] of Object.entries(switches)) {
		// The Status tab before: it fits (1 agent, 2 rows) or overflows (5 agents, 6 rows).
		for (const agents of [1, 5]) {
			it(`Status to Session, one row over, from ${agents} agents, by ${how}`, async () => {
				// The viewport is 4 rows and Session holds 5, so one row less than they need: the indicator takes one more.
				const view = track(await mounted(6, agents));
				go(view, "Session");
				await view.until(() => view.screen()[5] === "↑↓ 1–3/5");
				expect(view.screen()[0]).toBe(TABS);
				expect(view.screen().slice(2)).toEqual([...SESSION.slice(0, 3), "↑↓ 1–3/5"]);
				await expectStable(view);
				expect(view.screen().slice(2)).toEqual([...SESSION.slice(0, 3), "↑↓ 1–3/5"]);
			});
		}

		it(`Session to Status, one row over, by ${how}`, async () => {
			// The viewport is 5 rows: Session fits exactly, Status holds 6 (5 agents).
			const view = track(await mounted(7, 5));
			go(view, "Session");
			await view.until(() => view.screen()[2] === "Session");
			expect(view.screen().slice(2)).toEqual(SESSION);
			go(view, "Status");
			await view.until(() => view.screen().at(-1) === "↑↓ 1–4/6");
			const rows = view.screen().slice(2);
			expect(rows.at(-1)).toBe("↑↓ 1–4/6");
			expect(rows.slice(0, -1)).toHaveLength(4);
			await expectStable(view);
			expect(view.screen().slice(2).at(-1)).toBe("↑↓ 1–4/6");
		});
	}

	it("asks for one more render when a layout finds the rows over its height", async () => {
		const view = track(await mounted(6, 1));
		const before = view.requests();
		view.ctrlN();
		await view.until(() => view.screen()[5] === "↑↓ 1–3/5");
		// The switch's own request, and the panel's: the indicator is only known after the layout.
		expect(view.requests() - before).toBe(2);
		expect(view.screen()[5]).toBe("↑↓ 1–3/5");
	});

	it("scrolls to the last row of a tab one row over", async () => {
		const view = track(await mounted(6, 1));
		view.ctrlN();
		await view.until(() => view.screen()[5] === "↑↓ 1–3/5");
		view.wheel(5);
		await view.until(() => view.screen().at(-1) === "↑↓ 3–5/5");
		expect(view.screen().slice(2)).toEqual([...SESSION.slice(2), "↑↓ 3–5/5"]);
	});

	it("shows no indicator when the rows fit exactly", async () => {
		const view = track(await mounted(7, 1));
		view.ctrlN();
		await view.until(() => view.screen()[2] === "Session");
		expect(view.screen().slice(2)).toEqual(SESSION);
		await expectStable(view);
	});
});

describe("followed task render convergence", () => {
	const feature = (tasks: number, current: number): AtelierEvent => ({
		type: "feature_changed",
		name: "followed",
		path: "odd/tasks/followed.md",
		title: "Followed tasks",
		tasks: Array.from({ length: tasks }, (_, i) => ({
			id: `T${i + 1}`,
			title: `Task ${i + 1}`,
			specs: [],
			status: i === current ? "in_progress" : "pending",
		})),
		seq: 1,
		turnId: "t",
	});

	it("settles a followed task and its new indicator in at most one extra frame", async () => {
		const view = track(await mounted(6, 0));
		const requests = view.requests();
		const frames = view.frames();
		view.panel.event(feature(3, 2));
		view.panel.toggleTasks();
		await view.frame();
		await view.until(() => view.screen().at(-1) === "↑↓ 4–6/7");
		expect(view.screen()).toContain("◐ T3 Task 3");
		expect(view.screen().at(-1)).toBe("↑↓ 4–6/7");
		expect(view.requests() - requests).toBeLessThanOrEqual(2);
		expect(view.frames() - frames).toBeLessThanOrEqual(2);
		await expectStable(view);
	});

	it("settles a followed task and its indicator after shrinking in at most one extra frame", async () => {
		const view = track(await mounted(14, 0));
		view.panel.event(feature(8, 7));
		view.panel.toggleTasks();
		await view.frame();
		expect(view.screen()).toContain("◐ T8 Task 8");
		expect(view.screen().some((row) => row.startsWith("↑↓"))).toBe(false);
		await expectStable(view);
		const requests = view.requests();
		const frames = view.frames();
		view.resize(12);
		await view.until(() => view.screen().at(-1) === "↑↓ 3–11/12");
		expect(view.screen()).toContain("◐ T8 Task 8");
		expect(view.screen().at(-1)).toBe("↑↓ 3–11/12");
		expect(view.requests() - requests).toBeLessThanOrEqual(2);
		expect(view.frames() - frames).toBeLessThanOrEqual(2);
		await expectStable(view);
	});
});

describe("side panel in 1 to 3 rows", () => {
	// Status holds 2 rows with 1 agent: none fits beside the tabs and the indicator, so the indicator says so.
	const shows: Record<number, string[]> = {
		3: [TABS, "─".repeat(37), "↑↓ 0–0/2"],
		2: [TABS, "↑↓ 0–0/2"],
		1: ["↑↓ 0–0/2"],
	};
	it("does not request another render on every frame at minimum height", async () => {
		const view = track(await mounted(3, 1));
		await expectStable(view);
	});

	it("requests at most one corrective render when content crosses the height limit", async () => {
		const view = track(await mounted(3, 0));
		view.panel.event({
			type: "tool_call_started",
			callId: "first",
			tool: "task",
			input: { agent: "worker", prompt: "first" },
			seq: 1,
			turnId: "t",
		} as AtelierEvent);
		let before = view.requests();
		await view.frame();
		await view.until(() => view.screen().at(-1) === "↑↓ 0–0/2");
		expect(view.requests() - before).toBe(2);
		await expectStable(view);
		view.panel.reset();
		before = view.requests();
		await view.frame();
		await view.until(() => !view.screen().some((row) => row.startsWith("↑↓")));
		expect(view.requests() - before).toBe(2);
		await expectStable(view);
	});

	it("measures the allocated panel height below a fixed header, not the terminal height", async () => {
		const view = track(await mounted(3, 1, 2));
		await view.until(() => view.screen().at(-1) === "↑↓ 0–0/2");
		expect(view.screen()).toEqual(shows[3]);
		await expectStable(view);
	});

	for (const rows of [3, 2, 1]) {
		it(`says the rows are over and settles, in ${rows} rows`, async () => {
			const view = track(await mounted(rows, 1));
			await view.until(() => view.screen().at(-1) === "↑↓ 0–0/2");
			expect(view.screen()).toEqual(shows[rows]);
			await expectStable(view);
			expect(view.screen()).toEqual(shows[rows]);
		});

		it(`follows the rows and the height, in ${rows} rows`, async () => {
			const view = track(await mounted(rows, 1));
			await view.until(() => view.screen().at(-1) === "↑↓ 0–0/2");
			view.panel.event({
				type: "tool_call_started",
				callId: "more",
				tool: "task",
				input: { agent: "worker", prompt: "more" },
				seq: 9,
				turnId: "t",
			} as AtelierEvent);
			let before = view.requests();
			await view.frame();
			await view.until(() => view.screen().at(-1) === "↑↓ 0–0/3");
			expect(view.requests() - before).toBeLessThanOrEqual(2);
			await expectStable(view);
			before = view.requests();
			view.resize(10);
			await view.until(() => view.screen()[0] === TABS && !view.screen().some((row) => row.startsWith("↑↓")));
			expect(view.screen().slice(2, 5)).toHaveLength(3);
			expect(view.requests() - before).toBe(2);
			await expectStable(view);
			before = view.requests();
			view.resize(rows);
			await view.until(() => view.screen().at(-1) === "↑↓ 0–0/3");
			expect(view.screen().at(-1)).toBe("↑↓ 0–0/3");
			expect(view.requests() - before).toBe(2);
			await expectStable(view);
		});
	}
});
