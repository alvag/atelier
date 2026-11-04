/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: the screen is read from the terminal's escape codes */
import type { Component, Terminal } from "@earendil-works/pi-tui";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { mount } from "../src/tui/layout.ts";
import { SIDE_PANEL_WIDTH, SidePanel } from "../src/tui/side-panel-view.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const COLUMNS = 120;
const ROWS = 12;
const styles = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

async function until(done: () => boolean): Promise<void> {
	const deadline = performance.now() + 2000;
	while (!done() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
}

let stop: () => void = () => {};
afterEach(() => stop());

it("sends the first wheel tick on the panel's rule to the conversation", async () => {
	const grid: string[] = Array.from({ length: ROWS }, () => "");
	let onInput: (data: string) => void = () => {};
	const terminal: Terminal = {
		start: (input) => {
			onInput = input;
		},
		stop: () => {},
		drainInput: async () => {},
		write: (data) => {
			for (const part of data.split(/(?=\x1b\[\d+;1H)/)) {
				const row = /^\x1b\[(\d+);1H/.exec(part);
				if (row?.[1] !== undefined) grid[Number(row[1]) - 1] = part.replace(styles, "");
			}
		},
		columns: COLUMNS,
		rows: ROWS,
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
		context: () => ({}),
	});
	const document: Component = {
		render: () => Array.from({ length: 100 }, (_, i) => `line ${i}`),
		invalidate: () => {},
	};
	const header: Component = { render: () => ["header"], invalidate: () => {} };
	mount(tui, document, [], header, {
		component: panel.component,
		width: SIDE_PANEL_WIDTH,
		shown: () => panel.shown(),
	});
	stop = () => {
		panel.stop();
		tui.stop();
	};
	tui.start();
	await until(() => grid.some((line) => line.includes("line 99")));
	const conversation = () => grid.slice(1).map((line) => line.slice(0, COLUMNS - SIDE_PANEL_WIDTH).trimEnd());
	const wheel = async (button: number, column: number) => {
		const before = conversation().join("\n");
		onInput(`\x1b[<${button};${column};5M`);
		await until(() => conversation().join("\n") !== before);
	};
	expect(conversation().join("\n")).toContain("line 99");
	// Up over the conversation, then down over the rule (the panel's first column, below the header).
	await wheel(64, 5);
	const before = conversation();
	expect(before.join("\n")).not.toContain("line 99");
	await wheel(65, COLUMNS - SIDE_PANEL_WIDTH + 1);
	expect(conversation()).not.toEqual(before);
});
