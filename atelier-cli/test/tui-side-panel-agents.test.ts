import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { sidePanelLines } from "../src/tui/side-panel.ts";
import { emptySidePanel, type PanelAgent } from "../src/tui/side-panel-state.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const WIDTH = 37;
const plain = { ink: ink(activeTheme, false, "truecolor"), paint: painter(false) };
const colored = ink(activeTheme, true, "truecolor");
const rgb = (hex: string) =>
	`\x1b[38;2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";")}m`;

const at = (left: string, right: string, width = WIDTH) =>
	`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

const agent = (extra: Partial<PanelAgent> = {}): PanelAgent => ({
	key: "k",
	agent: "worker",
	label: "fix footer",
	background: false,
	status: "running",
	startedAt: 0,
	...extra,
});

function render(agents: PanelAgent[], unread: string[] = [], now = 10_000, useInk = plain.ink, width = WIDTH) {
	const state = { ...emptySidePanel(), agents, unread };
	const paint = useInk === plain.ink ? plain.paint : painter(true);
	return sidePanelLines({ state, now, startedAt: 0, tab: "status" }, useInk, paint, width).lines;
}

const ended = (extra: Partial<PanelAgent>) =>
	agent({ status: "finished", durationMs: 65_000, endedAt: 9000, ...extra });

describe("Agents section", () => {
	it("has a header with only its name, no counts", () => {
		expect(render([agent(), ended({ key: "e" })])[0]).toBe("AGENTS");
	});

	it("shows a running foreground agent with its model and tool on the second row", () => {
		expect(render([agent({ model: "sonnet-5-5", tool: { callId: "c", label: "edit footer.ts" } })])).toEqual([
			"AGENTS",
			at("◐ worker · fix footer", "0m10s"),
			"  sonnet-5-5 · ▸ edit footer.ts",
		]);
		expect(render([agent({ tool: { callId: "c", label: "read a" } })])[2]).toBe("  ▸ read a");
		expect(render([agent({ model: "m" })])[2]).toBe("  m");
		expect(render([agent()])).toHaveLength(2);
	});

	it("shows a background agent with ◷ and only its model, never its tool", () => {
		expect(render([agent({ background: true, model: "m", tool: { callId: "c", label: "edit a" } })]).slice(1)).toEqual([
			at("◐ worker · fix footer", "◷  0m10s"),
			"  m",
		]);
	});

	it("shows a finished agent with its model, tokens and cost, and no second row when it has none", () => {
		const usage = { input: 2000, output: 20_000, cacheRead: 300_000, cacheWrite: 0 };
		expect(render([ended({ model: "opus-5-5", usage, costUsd: 0.11 })]).slice(1)).toEqual([
			at("✓ worker · fix footer", "1m05s"),
			"  opus-5-5 · 322k · $0.11",
		]);
		expect(render([ended({ background: true })]).slice(1)).toEqual([at("✓ worker · fix footer", "◷  1m05s")]);
		expect(render([ended({ costUsd: 0.5 })])[2]).toBe("  $0.50");
	});

	it("shows a failed agent's error under its label, and a stopped one's only when it has one", () => {
		expect(render([ended({ status: "failed", error: "interrupted" })]).slice(1)).toEqual([
			at("✗ worker · fix footer", "1m05s"),
			"  no report: interrupted",
		]);
		expect(render([ended({ status: "stopped", error: "killed" })]).slice(1)).toEqual([
			at("■ worker · fix footer", "1m05s"),
			"  no report: killed",
		]);
		expect(render([ended({ status: "stopped" })]).slice(1)).toEqual([at("■ worker · fix footer", "1m05s")]);
	});

	it("marks an unread agent with ● in place of its state", () => {
		const lines = render([ended({ key: "u", status: "failed", error: "x" })], ["task:u"]);
		expect(lines[1]).toBe(at("● worker · fix footer", "1m05s"));
		expect(lines[2]).toBe("  no report: x");
	});

	it("cuts a long name to one row with … and keeps the right side", () => {
		const [, line] = render([agent({ label: "a very long label that cannot fit in the panel", background: true })]);
		expect(visibleWidth(line ?? "")).toBe(WIDTH);
		expect(line).toMatch(/^◐ worker · a very long .*… ◷ {2}0m10s$/);
	});

	it("wraps a long error under the label on two rows at most, the last cut with …", () => {
		const error = "the backend closed the connection while the agent was reading a very large file again";
		const lines = render([ended({ status: "failed", error })]);
		expect(lines).toHaveLength(4);
		expect(lines[2]).toBe("  no report: the backend closed the");
		expect(lines[3]?.startsWith("  ")).toBe(true);
		expect(lines[3]).toMatch(/…$/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		const short = render([ended({ status: "failed", error: "short" })]);
		expect(short).toHaveLength(3);
	});

	it("keeps a long second row within the width", () => {
		const lines = render([agent({ model: "m".repeat(50), tool: { callId: "c", label: "t".repeat(50) } })]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		expect(lines[2]).toMatch(/…$/);
	});

	it("shows control characters in labels and errors as markers, on one row", () => {
		const lines = render([ended({ status: "failed", label: "a\x1b[31m\nb", error: "e\x1b[0m\nf" })]);
		expect(lines.join("\n")).not.toContain("\x1b");
		expect(lines).toHaveLength(3);
	});

	it("colors the mark by state, the clock only for a running agent, and the second row in textSecondary", () => {
		const text = render(
			[
				agent({ key: "r", model: "m", tool: { callId: "c", label: "edit a" } }),
				ended({ key: "f", model: "m" }),
				ended({ key: "x", status: "failed", error: "boom" }),
				ended({ key: "s", status: "stopped" }),
				ended({ key: "u", status: "failed", error: "u" }),
			],
			["task:u"],
			10_000,
			colored,
		).join("\n");
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}◐`);
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}0m10s`);
		expect(text).toContain(`${rgb(activeTheme.success)}✓`);
		expect(text).toContain(`${rgb(activeTheme.error)}✗`);
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}■`);
		expect(text).toContain(`${rgb(activeTheme.warning)}●`);
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}1m05s`);
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}m · ▸ edit a`);
		expect(text).toContain(`${rgb(activeTheme.error)}no report: boom`);
	});
});
