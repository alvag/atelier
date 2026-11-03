import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type PanelView, type Section, sidePanelLines } from "../src/tui/side-panel.ts";
import { emptySidePanel, type SidePanelState, sidePanelAfter } from "../src/tui/side-panel-state.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const WIDTH = 37;
const plain = { ink: ink(activeTheme, false, "truecolor"), paint: painter(false) };
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
/** The state after `bodies`, each arriving at its `[time, body]` second. */
function stateOf(bodies: [number, Body][]): SidePanelState {
	return bodies.reduce(
		(state, [at, body], i) => sidePanelAfter(state, { ...body, seq: i + 1, turnId: "t" } as AtelierEvent, at * 1000),
		emptySidePanel(),
	);
}

/** `left` and `right` against the panel's last column. */
const at = (left: string, right: string, width = WIDTH) =>
	`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

function render(state: SidePanelState, view: Partial<PanelView> = {}, width = WIDTH) {
	return sidePanelLines(
		{ state, now: 0, startedAt: 0, folded: new Set<Section>(), ...view },
		plain.ink,
		plain.paint,
		width,
	);
}

const job = (jobId: string, label: string): Body => ({
	type: "job_started",
	jobId,
	label,
	command: label,
	outputPath: "/tmp/x",
	running: 1,
});
const jobEnd = (jobId: string, durationMs: number, extra: Record<string, unknown> = {}): Body =>
	({
		type: "job_finished",
		jobId,
		label: jobId,
		status: "exited",
		exitCode: 0,
		durationMs,
		outputPath: "/tmp/x",
		notified: true,
		running: 0,
		waiting: 0,
		...extra,
	}) as Body;

describe("side panel sections", () => {
	it("lists jobs: running first with its live time, then the one whose notice waits, then the finished newest first", () => {
		const state = stateOf([
			[0, job("old", "dev server")],
			[1, job("v", "verifier e2e")],
			[2, job("pr", "PR 61 abort fix wait")],
			[3, job("check", "pnpm check")],
			[10, jobEnd("old", 4_200_000, { status: "stopped", exitCode: undefined, notified: false })],
			[20, jobEnd("v", 242_000, { exitCode: 1, notified: false })],
			[30, jobEnd("pr", 1_741_000, { waiting: 1 })],
		]);
		const { lines } = render(state, { now: 137_000 });
		expect(lines).toEqual([
			at("⧗ Jobs ▾", "1 running · 1 ●"),
			at("⧗ pnpm check", "2m14s"),
			at("● PR 61 abort fix wait", "✓ 29m01s"),
			at("✗ verifier e2e", "exit 1 4m02s"),
			at("■ dev server", "stopped 1h10m"),
			"",
			"✿ Status ▾",
			"Session",
			" 2m · 0 turns",
		]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});

	it("caps the finished jobs with how many are left out", () => {
		const bodies: [number, Body][] = [];
		for (let i = 0; i < 8; i++) bodies.push([i, job(`j${i}`, `job ${i}`)], [i, jobEnd(`j${i}`, 1000)]);
		const { lines } = render(stateOf(bodies));
		expect(lines.slice(0, 7)).toEqual([
			"⧗ Jobs ▾",
			at("✓ job 7", "0m01s"),
			at("✓ job 6", "0m01s"),
			at("✓ job 5", "0m01s"),
			at("✓ job 4", "0m01s"),
			at("✓ job 3", "0m01s"),
			at("", "+3 more"),
		]);
	});

	it("lists agents with their model and current call while they run, and tokens, cost or why once they end", () => {
		const state = stateOf([
			[
				0,
				{
					type: "tool_call_started",
					callId: "c1",
					tool: "task",
					input: { agent: "worker", prompt: "fix footer cost" },
				},
			],
			[
				0,
				{
					type: "session_started",
					backend: "f",
					model: "sonnet-5-5",
					authSource: "none",
					parentCallId: "c1",
					agent: "worker",
				} as Body,
			],
			[1, { type: "tool_call_started", callId: "k", tool: "edit", input: { path: "footer.ts" }, parentCallId: "c1" }],
			[
				2,
				{
					type: "task_started",
					taskId: "task-1",
					agent: "explorer",
					label: "cache calc",
					model: "opus-5-5",
					outputPath: "x",
					running: 2,
				},
			],
			[
				217,
				{
					type: "task_finished",
					taskId: "task-1",
					agent: "explorer",
					label: "cache calc",
					status: "finished",
					durationMs: 215_000,
					outputPath: "x",
					usage: usage(2000, 20_000, 300_000),
					costUsd: 0.11,
					notified: false,
					running: 1,
					waiting: 0,
				},
			],
		]);
		const { lines } = render(state, { now: 100_000 });
		expect(lines.slice(0, 5)).toEqual([
			at("❀ Agents ▾", "1 running · 1 ✓"),
			at("⧗ worker · fix footer cost", "1m40s"),
			"  sonnet-5-5 · ▸ edit footer.ts",
			at("✓ explorer · cache calc", "◷  3m35s"),
			"  opus-5-5 · 322k · $0.11",
		]);
		const interrupted = stateOf([
			[0, { type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "worker", prompt: "docs update" } }],
			[52, { type: "turn_finished", stopReason: "interrupted", usage: usage(0, 0) }],
		]);
		expect(render(interrupted).lines.slice(0, 3)).toEqual([
			at("❀ Agents ▾", "1 ✗"),
			at("✗ worker · docs update", "0m52s"),
			"  no report: interrupted",
		]);
	});

	it("lists the feature's tasks in order, the done ones in one line, a blocked one with its note, a long title on two rows", () => {
		const state = stateOf([
			[
				0,
				{
					type: "feature_changed",
					name: "panel",
					path: "odd/tasks/panel.md",
					title: "TUI status panel",
					tasks: [
						{ id: "T1", title: "Reducer", specs: [], status: "done", commit: "abc1234def" },
						{ id: "T2", title: "Render", specs: [], status: "done" },
						{
							id: "T3",
							title: "Side panel Todos section with a title too long for one row of it",
							specs: [],
							status: "in_progress",
						},
						{ id: "T4", title: "Footer: live activity", specs: [], status: "blocked", note: "decide the cache scope" },
						{ id: "T5", title: "Footer cut by priority", specs: [], status: "pending" },
						{ id: "T7", title: "Inline mode", specs: [], status: "dropped" },
					],
				},
			],
		]);
		const { lines, current } = render(state);
		expect(lines.slice(0, 10)).toEqual([
			at("◆ Todos ▾", "2/6 ▰▰▱▱▱▱  ctrl+t"),
			"TUI status panel",
			at("✓ 2 done", "abc1234"),
			"▸ T3 Side panel Todos section with a",
			"  title too long for one row of it",
			"⊘ T4 Footer: live activity",
			"  waiting: decide the cache scope",
			"○ T5 Footer cut by priority",
			"  T7 Inline mode",
			"",
		]);
		expect(current).toEqual({ start: 3, end: 4 });
	});

	it("sums up the session: tokens of every turn, the orchestrator's cache, compactions, permissions, changes, integrations", () => {
		const state = stateOf([
			[0, { type: "memory_status", available: true, project: "atelier" }],
			[0, { type: "memory_summary_saved", id: 5510, preview: "x" }],
			[
				0,
				{
					type: "mcp_status",
					servers: ["a", "b", "c"].map((name) => ({ name, state: "connected" as const, tools: [] })),
					problems: [],
				},
			],
			[0, { type: "project_instructions", files: ["/repo/AGENTS.md"], dropped: [] }],
			[0, { type: "skills_loaded", skills: [1, 2, 3, 4].map((n) => ({ name: `s${n}`, path: "p" })), warnings: [] }],
			[
				1,
				{
					type: "turn_finished",
					stopReason: "end_turn",
					usage: usage(40_000, 50_000, 960_000),
					phases: { main: { usage: usage(40_000, 50_000, 960_000) } },
				},
			],
			[
				2,
				{
					type: "turn_finished",
					stopReason: "end_turn",
					usage: usage(5000, 11_000, 395_000),
					parentCallId: "c1",
					agent: "worker",
				} as Body,
			],
			[
				3,
				{
					type: "compaction_finished",
					ok: true,
					reason: "threshold",
					tokensBefore: 180_000,
					tokensAfter: 40_000,
					kept: 2,
					usage: usage(0, 0),
				},
			],
		]);
		const { lines } = render(state, {
			now: 42 * 60_000,
			name: "panel work",
			savedId: "a3f9c2d1e5",
			mode: "yolo",
			git: { lines: { added: 128, removed: 40 }, files: 6, commits: { ahead: 2, behind: 0 } },
		});
		expect(lines).toEqual([
			"✿ Status ▾",
			"Session",
			" panel work",
			" 42m · 1 turns · #a3f9c2d1",
			"Usage",
			" Tokens   in 1.4M · out 61k",
			" Cache    96% orchestrator",
			" Compact  1 · 180k → 40k",
			"Permissions",
			" YOLO · destructive confirmations",
			"Changes",
			" 6 files · +128 −40 · ↑2",
			"Integrations",
			" memory   project atelier · #5510",
			" mcp      3 servers ✓",
			" AGENTS.md · 4 skills",
		]);
	});

	it("keeps MCP failure counts and the singular skill label with detailed state", () => {
		const state = stateOf([
			[
				0,
				{
					type: "mcp_status",
					servers: [
						{ name: "broken", state: "failed", tools: [], error: "no answer" },
						{ name: "bad", state: "invalid", tools: [], error: "invalid entry" },
						{ name: "login", state: "needs_auth", tools: [] },
					],
					problems: [],
				},
			],
			[0, { type: "skills_loaded", skills: [{ name: "debugging", path: "skill" }], warnings: [] }],
			[0, { type: "project_instructions", files: [], dropped: ["nested/AGENTS.md"] }],
		]);
		expect(render(state).lines.slice(-3)).toEqual(["Integrations", " mcp      3 servers · 2 failed", " 1 skill"]);
	});

	it("puts what fails at the top of the panel", () => {
		const state = stateOf([
			[0, { type: "job_started", jobId: "j", label: "x", command: "x", outputPath: "x", running: 1 }],
			[
				0,
				{
					type: "mcp_status",
					servers: [{ name: "github", state: "failed", tools: [] }],
					problems: ["github: no answer"],
				},
			],
			[0, { type: "memory_status", available: false, reason: "not installed" }],
		]);
		expect(render(state).lines.slice(0, 4)).toEqual([
			"⚠ mcp: github: no answer",
			"⚠ memory unavailable: not installed",
			"",
			at("⧗ Jobs ▾", "1 running"),
		]);
	});

	it("folds a section to its header and says which rows are headers", () => {
		const state = stateOf([[0, job("j", "x")]]);
		const { lines, headers } = render(state, { folded: new Set<Section>(["jobs", "status"]) });
		expect(lines).toEqual([at("⧗ Jobs ▸", "1 running"), "", "✿ Status ▸"]);
		expect([...headers]).toEqual([
			[0, "jobs"],
			[2, "status"],
		]);
	});

	it("paints with the theme's tokens only, never the terminal's own colors", () => {
		const state = stateOf([
			[0, job("run", "pnpm check")],
			[0, job("bad", "e2e")],
			[0, job("ok", "lint")],
			[1, jobEnd("bad", 1000, { exitCode: 1, notified: false })],
			[2, jobEnd("ok", 1000, { notified: false })],
			[3, jobEnd("run", 1000, { waiting: 1 })],
			[4, job("live", "dev")],
		]);
		const colored = ink(activeTheme, true, "truecolor");
		const text = sidePanelLines(
			{ state, now: 0, startedAt: 0, folded: new Set(), mode: "yolo" },
			colored,
			painter(true),
			WIDTH,
		).lines.join("\n");
		const rgb = (hex: string) =>
			`\x1b[38;2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";")}m`;
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}⧗`);
		expect(text).toContain(`${rgb(activeTheme.error)}✗`);
		expect(text).toContain(`${rgb(activeTheme.warning)}●`);
		expect(text).toContain(`${rgb(activeTheme.success)}✓`);
		expect(text).toContain(`${rgb(activeTheme.warning)}YOLO`);
		// No basic or bright ANSI foreground: every color is a token's.
		for (const code of [...Array(8).keys()].flatMap((n) => [30 + n, 90 + n]))
			expect(text).not.toContain(`\x1b[${code}m`);
		expect(text).not.toContain(rgb(activeTheme.brand));
	});

	it("keeps every row within the width, wide characters and control characters included", () => {
		const state = stateOf([
			[0, job("j", "構建 ターミナル パネル 🚀 with a long label")],
			[0, job("k", "evil\x1b[31m label\nnext")],
			[
				0,
				{
					type: "tool_call_started",
					callId: "c1",
					tool: "task",
					input: { agent: "wörker‮", prompt: "日本語のラベル".repeat(4) },
				},
			],
		]);
		const { lines } = render(state, { now: 5000 }, 30);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(lines.join("\n")).not.toContain("\x1b");
		expect(lines.join("\n")).toContain("␛[31m label␊next");
	});
});
