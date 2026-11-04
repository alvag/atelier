/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: the screen is read from the terminal's escape codes */
import type { AtelierEvent } from "@atelier/core";
import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SidePanel } from "../src/tui/side-panel-view.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const COLUMNS = 40;

const styles = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** The panel in the TUI, on a terminal of `rows` rows, and the screen its writes leave. */
function mounted(rows: number, agents: number) {
	const grid: string[] = Array.from({ length: rows }, () => "");
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
		rows,
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
	const tui = new TuiAltScreen(terminal);
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
	tui.setLayoutRoot(panel.component);
	tui.start();
	tui.renderNow();
	const settle = () => {
		// A render the panel asks for after a layout comes in the next turns.
		for (let i = 0; i < 4; i++) tui.renderNow();
	};
	return {
		panel,
		/** The rows as text, without the rule and the space after it. */
		screen: () => grid.map((line) => line.replace(/^\s*│\s?/, "").trimEnd()),
		ctrlN: () => {
			panel.toggleTab();
			tui.requestRender();
			settle();
		},
		click: (label: string) => {
			const x = grid[0]?.replace(styles, "").indexOf(label) ?? -1;
			expect(x).toBeGreaterThanOrEqual(0);
			onInput(`\x1b[<0;${x + 1};1M`);
			onInput(`\x1b[<0;${x + 1};1m`);
			settle();
		},
		wheel: (lines: number) => {
			for (let i = 0; i < lines; i++) onInput(`\x1b[<65;${COLUMNS - 5};5M`);
			settle();
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

type View = ReturnType<typeof mounted>;
const switches: Record<string, (view: View, label: string) => void> = {
	"ctrl+n": (view) => view.ctrlN(),
	click: (view, label) => view.click(label),
};
const SESSION = ["Session", " n", " 0m · 0 turns · #abc", "Permissions", " m"];

describe("side panel tab overflow", () => {
	for (const [how, go] of Object.entries(switches)) {
		// The Status tab before: it fits (1 agent, 2 rows) or overflows (5 agents, 6 rows).
		for (const agents of [1, 5]) {
			it(`Status to Session, one row over, from ${agents} agents, by ${how}`, () => {
				// The viewport is 4 rows and Session holds 5, so one row less than they need: the indicator takes one more.
				const view = track(mounted(6, agents));
				go(view, "Session");
				expect(view.screen()[0]).toBe("Status  Session");
				expect(view.screen().slice(2)).toEqual([...SESSION.slice(0, 3), "↑↓ 1–3/5"]);
				// Repeated renders keep it.
				view.ctrlN();
				view.ctrlN();
				expect(view.screen().slice(2)).toEqual([...SESSION.slice(0, 3), "↑↓ 1–3/5"]);
			});
		}

		it(`Session to Status, one row over, by ${how}`, () => {
			// The viewport is 5 rows: Session fits exactly, Status holds 6 (5 agents).
			const view = track(mounted(7, 5));
			go(view, "Session");
			expect(view.screen().slice(2)).toEqual(SESSION);
			go(view, "Status");
			const rows = view.screen().slice(2);
			expect(rows.at(-1)).toBe("↑↓ 1–4/6");
			expect(rows.slice(0, -1)).toHaveLength(4);
			view.ctrlN();
			view.ctrlN();
			expect(view.screen().slice(2).at(-1)).toBe("↑↓ 1–4/6");
		});
	}

	it("scrolls to the last row of a tab one row over", async () => {
		const view = track(mounted(6, 1));
		view.ctrlN();
		view.wheel(5);
		const deadline = performance.now() + 15_000;
		while (view.screen().at(-1) !== "↑↓ 3–5/5" && performance.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(view.screen().slice(2)).toEqual([...SESSION.slice(2), "↑↓ 3–5/5"]);
	});

	it("shows no indicator when the rows fit exactly", () => {
		const view = track(mounted(7, 1));
		view.ctrlN();
		expect(view.screen().slice(2)).toEqual(SESSION);
	});
});
