import type { AtelierEvent } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { sidePanelLines } from "../src/tui/side-panel.ts";
import { emptySidePanel, type SidePanelState, sidePanelAfter } from "../src/tui/side-panel-state.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const WIDTH = 37;
const plain = ink(activeTheme, false, "truecolor");
const colored = ink(activeTheme, true, "truecolor");
const fg = (hex: string) => `\x1b[38;2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";")}m`;

const at = (left: string, right: string, width = WIDTH) =>
	`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

/** The state after the job `id` started at second 0 and, unless `end` is absent, ended with `extra`. */
function stateOf(label: string, end?: Record<string, unknown>, id = "j"): SidePanelState {
	const started = { type: "job_started", jobId: id, label, command: label, outputPath: "/tmp/x", running: 1 };
	const finished = {
		type: "job_finished",
		jobId: id,
		label,
		status: "exited",
		exitCode: 0,
		durationMs: 3000,
		outputPath: "/tmp/x",
		notified: false,
		running: 0,
		waiting: 0,
		...end,
	};
	return [started, ...(end === undefined ? [] : [finished])].reduce(
		(state, body, i) => sidePanelAfter(state, { ...body, seq: i + 1, turnId: "t" } as AtelierEvent, i * 1000),
		emptySidePanel(),
	);
}

function jobs(state: SidePanelState, now = 5000, color = false) {
	const view = { state, now, startedAt: 0, tab: "status" as const };
	return sidePanelLines(view, color ? colored : plain, painter(color), WIDTH).lines;
}

describe("side panel jobs", () => {
	it("shows only the name in the header and `◐` with the live time for a running job", () => {
		expect(jobs(stateOf("dev"), 134_000)).toEqual(["JOBS", at("◐ dev", "2m14s")]);
	});

	it("shows `✓ name` with just the time for a job that exited 0", () => {
		expect(jobs(stateOf("lint", {}))).toEqual(["JOBS", at("✓ lint", "0m03s")]);
	});

	it("shows the exit code, `failed` without one, and the signal, with the time", () => {
		expect(jobs(stateOf("a", { exitCode: 2 }))[1]).toBe(at("✗ a", "exit 2 0m03s"));
		expect(jobs(stateOf("a", { status: "failed", exitCode: undefined }))[1]).toBe(at("✗ a", "failed 0m03s"));
		expect(jobs(stateOf("a", { status: "exited", exitCode: undefined }))[1]).toBe(at("✗ a", "failed 0m03s"));
		expect(jobs(stateOf("a", { exitCode: undefined, signal: "SIGKILL" }))[1]).toBe(at("✗ a", "SIGKILL 0m03s"));
	});

	it("shows `■ name` with `stopped` and the time for a stopped job", () => {
		expect(jobs(stateOf("a", { status: "stopped", exitCode: undefined }))[1]).toBe(at("■ a", "stopped 0m03s"));
	});

	it("replaces the mark with `●` for an unread notice and keeps the outcome, `✓` included, on the right", () => {
		const unread = { notified: true, waiting: 1 };
		expect(jobs(stateOf("a", { ...unread }))[1]).toBe(at("● a", "✓ 0m03s"));
		expect(jobs(stateOf("a", { ...unread, exitCode: 1 }))[1]).toBe(at("● a", "exit 1 0m03s"));
		expect(jobs(stateOf("a", { ...unread, exitCode: undefined, signal: "SIGTERM" }))[1]).toBe(
			at("● a", "SIGTERM 0m03s"),
		);
		expect(jobs(stateOf("a", { ...unread, status: "failed", exitCode: undefined }))[1]).toBe(at("● a", "failed 0m03s"));
		expect(jobs(stateOf("a", { ...unread, status: "stopped", exitCode: undefined }))[1]).toBe(
			at("● a", "stopped 0m03s"),
		);
	});

	it("cuts a long name to one row with `…` and never cuts the right side at 37 columns", () => {
		const name = "a very long job name that goes past the panel\nsecond line";
		for (const end of [undefined, {}, { exitCode: 12 }, { notified: true, waiting: 1 }]) {
			const lines = jobs(stateOf(name, end), end === undefined ? 3_725_000 : 5000);
			expect(lines).toHaveLength(2);
			expect(visibleWidth(lines[1] as string)).toBe(WIDTH);
			expect(lines[1]).toContain("…");
			expect(lines[1]).toMatch(/(1h02m|0m03s|exit 12 0m03s)$/);
		}
	});

	it("paints each part with its token and no other color", () => {
		const text = (state: SidePanelState) => jobs(state, 5000, true).join("\n");
		const reset = "\x1b[39m";
		const run = text(stateOf("a"));
		expect(run).toContain(`${fg(activeTheme.textSecondary)}◐${reset}`);
		expect(run).toContain(`${fg(activeTheme.textSecondary)}0m05s${reset}`);
		expect(run).not.toContain("running");
		const ok = text(stateOf("a", {}));
		expect(ok).toContain(`${fg(activeTheme.success)}✓${reset}`);
		expect(ok).not.toContain("success");
		const bad = text(stateOf("a", { exitCode: 2 }));
		expect(bad).toContain(`${fg(activeTheme.error)}✗${reset}`);
		expect(bad).toContain(`${fg(activeTheme.error)}exit 2${reset}`);
		expect(text(stateOf("a", { exitCode: undefined, signal: "SIGKILL" }))).toContain(
			`${fg(activeTheme.error)}SIGKILL${reset}`,
		);
		expect(text(stateOf("a", { status: "failed", exitCode: undefined }))).toContain(
			`${fg(activeTheme.error)}failed${reset}`,
		);
		const stopped = text(stateOf("a", { status: "stopped", exitCode: undefined }));
		expect(stopped).toContain(`${fg(activeTheme.textSecondary)}■`);
		expect(stopped).toContain(`${fg(activeTheme.textSecondary)}stopped${reset}`);
		const unread = text(stateOf("a", { notified: true, waiting: 1 }));
		expect(unread).toContain(`${fg(activeTheme.warning)}●${reset}`);
		expect(unread).toContain(`${fg(activeTheme.success)}✓${reset}`);
		expect(unread).not.toContain("◐");
		for (const code of [...Array(8).keys()].flatMap((n) => [30 + n, 90 + n]))
			for (const each of [ok, bad, unread]) expect(each).not.toContain(`\x1b[${code}m`);
	});
});
