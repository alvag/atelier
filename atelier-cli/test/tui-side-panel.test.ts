import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { nextSidePanelExpiry, type PanelView, sidePanelLines, tabAt, tabRows } from "../src/tui/side-panel.ts";
import { emptySidePanel, type SidePanelState, sidePanelAfter } from "../src/tui/side-panel-state.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

const WIDTH = 37;
/** A panel-wide separator between sections. */
const RULE = "─".repeat(WIDTH);
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
	return sidePanelLines({ state, now: 0, startedAt: 0, tab: "status", ...view }, plain.ink, plain.paint, width);
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
			[90, jobEnd("old", 4_200_000, { status: "stopped", exitCode: undefined, notified: false })],
			[100, jobEnd("v", 242_000, { exitCode: 1, notified: false })],
			[110, jobEnd("pr", 1_741_000, { waiting: 1 })],
		]);
		const { lines } = render(state, { now: 137_000 });
		expect(lines).toEqual([
			"JOBS",
			at("◐ pnpm check", "2m14s"),
			at("● PR 61 abort fix wait", "✓ 29m01s"),
			at("✗ verifier e2e", "exit 1 4m02s"),
			at("■ dev server", "stopped 1h10m"),
		]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});

	it("caps the other finished jobs at three, without saying how many are left out", () => {
		const bodies: [number, Body][] = [];
		for (let i = 0; i < 8; i++) bodies.push([i, job(`j${i}`, `job ${i}`)], [i, jobEnd(`j${i}`, 1000)]);
		const { lines } = render(stateOf(bodies));
		expect(lines).toEqual(["JOBS", at("✓ job 7", "0m01s"), at("✓ job 6", "0m01s"), at("✓ job 5", "0m01s")]);
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
		expect(lines).toEqual([
			at("AGENTS", "1 running · 1 ✓"),
			at("⧗ worker · fix footer cost", "1m40s"),
			"  sonnet-5-5 · ▸ edit footer.ts",
			at("✓ explorer · cache calc", "◷  3m35s"),
			"  opus-5-5 · 322k · $0.11",
		]);
		const interrupted = stateOf([
			[0, { type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "worker", prompt: "docs update" } }],
			[52, { type: "turn_finished", stopReason: "interrupted", usage: usage(0, 0) }],
		]);
		expect(render(interrupted).lines).toEqual([
			at("AGENTS", "1 ✗"),
			at("✗ worker · docs update", "0m52s"),
			"  no report: interrupted",
		]);
	});

	it("sums up the feature's tasks: the active ones, a blocked one with its note, a long title on one row, the rest in a tail", () => {
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
		expect(lines).toEqual([
			at("TASKS", "2/5 · ctrl+t"),
			"TUI status panel",
			`${"▰".repeat(15)}${"▱".repeat(22)}`,
			"◐ Side panel Todos section with a ti…",
			"⊘ Footer: live activity",
			"  waiting: decide the cache scope",
			"○ Footer cut by priority",
			"2 done · 1 dropped",
		]);
		expect(current).toEqual({ start: 3, end: 3 });
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
			tab: "session",
			now: 42 * 60_000,
			name: "panel work",
			savedId: "a3f9c2d1e5",
			mode: "yolo",
			git: { lines: { added: 128, removed: 40 }, files: 6, commits: { ahead: 2, behind: 0 } },
		});
		expect(lines).toEqual([
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
		expect(render(state, { tab: "session" }).lines.slice(-3)).toEqual([
			"Integrations",
			" mcp      3 servers · 2 failed",
			" 1 skill",
		]);
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
		expect(render(state, { tab: "session" }).lines.slice(0, 5)).toEqual([
			"⚠ mcp: github: no answer",
			"⚠ memory unavailable: not installed",
			"",
			"Session",
			" 0m · 0 turns",
		]);
		// Alerts belong to the Session tab alone.
		expect(render(state).lines.join("\n")).not.toContain("⚠");
	});

	it("keeps the Session tab's groups as they were, with no Status heading over them", () => {
		const { lines } = render(emptySidePanel(), { tab: "session", mode: "normal" });
		expect(lines).toEqual(["Session", " 0m · 0 turns", "Permissions", " normal · asks outside the sandbox"]);
		expect(lines.join("\n")).not.toMatch(/STATUS|Status|✿|▾|▸/);
	});

	it("puts Todos, Jobs and Agents on the Status tab with uppercase headers, a rule between sections and no fold marks", () => {
		const state = stateOf([
			[0, job("j", "x")],
			[0, { type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "worker", prompt: "docs" } }],
			[
				0,
				{
					type: "feature_changed",
					name: "p",
					path: "odd/tasks/p.md",
					title: "Panel",
					tasks: [{ id: "T1", title: "One", specs: [], status: "in_progress" }],
				},
			],
		]);
		const { lines, current } = render(state);
		expect(lines).toEqual([
			at("TASKS", "0/1 · ctrl+t"),
			"Panel",
			"▱".repeat(WIDTH),
			"◐ One".padEnd(WIDTH),
			RULE,
			"JOBS",
			at("◐ x", "0m00s"),
			RULE,
			at("AGENTS", "1 running"),
			at("⧗ worker · docs", "0m00s"),
		]);
		expect(current).toEqual({ start: 3, end: 3 });
		expect(lines.join("\n")).not.toMatch(/[▾▸] *$|⧗ Jobs|❀|◆|✿/m);
	});

	it("lists every task with its id, and leaves the other sections as they are, when the tasks are expanded", () => {
		const state = stateOf([
			[0, job("j", "x")],
			[
				0,
				{
					type: "feature_changed",
					name: "p",
					path: "odd/tasks/p.md",
					title: "Panel",
					tasks: [{ id: "T1", title: "One", specs: [], status: "in_progress" }],
				},
			],
		]);
		const { lines, current } = render(state, { tasksExpanded: true });
		expect(lines).toEqual([
			at("TASKS", "0/1 · ctrl+t"),
			"Panel",
			"▱".repeat(WIDTH),
			"◐ T1 One".padEnd(WIDTH),
			"ctrl+t summary",
			RULE,
			"JOBS",
			at("◐ x", "0m00s"),
		]);
		expect(current).toEqual({ start: 3, end: 3 });
	});

	it("draws the tabs on two rows: ink text for the active label, textSecondary for the other, a brand underline", () => {
		const colored = ink(activeTheme, true, "truecolor");
		const rgb = (hex: string) =>
			`\x1b[38;2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";")}m`;
		const [status, statusLine] = tabRows(colored, "status", WIDTH);
		expect(status).toContain(`${rgb(activeTheme.text)}Status`);
		expect(status).toContain(`${rgb(activeTheme.textSecondary)}Session`);
		expect(statusLine).toContain(`${rgb(activeTheme.brand)}${"─".repeat(6)}`);
		const [session, sessionLine] = tabRows(colored, "session", WIDTH);
		expect(session).toContain(`${rgb(activeTheme.textSecondary)}Status`);
		expect(session).toContain(`${rgb(activeTheme.text)}Session`);
		expect(sessionLine).toContain(`${rgb(activeTheme.brand)}${"─".repeat(7)}`);
		// Plain: the labels two spaces apart, the underline a rule as wide as the panel.
		const [row, underline] = tabRows(plain.ink, "session", WIDTH);
		expect(row).toBe(`Status  Session${" ".repeat(WIDTH - 15)}`.trimEnd());
		expect(underline).toBe("─".repeat(WIDTH));
		expect(visibleWidth(underline)).toBe(WIDTH);
	});

	it("knows the tab under a column of the label row: Status [0, 6), Session [8, 15), nothing in the gap or past them", () => {
		const at = (x: number) => tabAt(x);
		expect([0, 5].map(at)).toEqual(["status", "status"]);
		expect([6, 7].map(at)).toEqual([undefined, undefined]);
		expect([8, 14].map(at)).toEqual(["session", "session"]);
		expect([15, 30].map(at)).toEqual([undefined, undefined]);
		expect(at(-1)).toBeUndefined();
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
		const text = (["status", "session"] as const)
			.flatMap(
				(tab) =>
					sidePanelLines({ state, now: 0, startedAt: 0, tab, mode: "yolo" }, colored, painter(true), WIDTH).lines,
			)
			.join("\n");
		const rgb = (hex: string) =>
			`\x1b[38;2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";")}m`;
		expect(text).toContain(`${rgb(activeTheme.textSecondary)}◐`);
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
		const session = render(
			state,
			{ now: 5000, tab: "session", name: "構建 ターミナル パネル 🚀 with a long name" },
			30,
		);
		for (const line of [...session.lines, ...tabRows(plain.ink, "session", 30)])
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(lines.join("\n")).not.toContain("\x1b");
		expect(lines.join("\n")).toContain("␛[31m label␊next");
	});
});

describe("finished rows", () => {
	/** Jobs `a`, `b`… started at 0 and ended at the given seconds; `notified` ones stay unread. */
	const ended = (ends: Record<string, number>, unread: string[] = []) => {
		const bodies: [number, Body][] = [];
		for (const id of Object.keys(ends)) bodies.push([0, job(id, id)]);
		for (const [id, at] of Object.entries(ends))
			bodies.push([at, jobEnd(id, 1000, { notified: unread.includes(id), waiting: unread.length })]);
		return stateOf(bodies);
	};
	const labels = (state: SidePanelState, now: number) =>
		render(state, { now }).lines.map((line) => (/^(JOBS|AGENTS)/.test(line) ? line.split(" ")[0] : line.split(" ")[1]));

	it("hides a finished row at 60 s and shows it one millisecond earlier", () => {
		const state = ended({ a: 100 });
		expect(render(state, { now: 159_999 }).lines.length).toBe(2);
		expect(render(state, { now: 160_000 }).lines).toEqual([]);
	});

	it("shows three other finished rows newest first, then the older ones are gone with no +N more", () => {
		const state = ended({ a: 100, b: 101, c: 102, d: 103, e: 104 });
		const { lines } = render(state, { now: 110_000 });
		expect(labels(state, 110_000)).toEqual(["JOBS", "e", "d", "c"]);
		expect(lines.join("\n")).not.toContain("more");
	});

	it("keeps every unread row, newest first before the others, outside the three slots and past 60 s", () => {
		const state = ended({ a: 10, b: 20, c: 100, d: 101, e: 102, f: 103, g: 104 }, ["a", "b"]);
		expect(labels(state, 110_000)).toEqual(["JOBS", "b", "a", "g", "f", "e"]);
		const { lines } = render(state, { now: 110_000 });
		expect(lines[0]).toBe("JOBS");
	});

	it("counts the agents shown in the header, not the ones left out", () => {
		const bodies: [number, Body][] = [];
		for (let i = 0; i < 5; i++)
			bodies.push(
				[i, { type: "task_started", taskId: `t${i}`, agent: "w", label: `l${i}`, outputPath: "x", running: 1 } as Body],
				[
					100 + i,
					{
						type: "task_finished",
						taskId: `t${i}`,
						agent: "w",
						label: `l${i}`,
						status: i === 4 ? "failed" : "finished",
						durationMs: 1000,
						outputPath: "x",
						notified: false,
						running: 0,
						waiting: 0,
					} as Body,
				],
			);
		const state = stateOf(bodies);
		const { lines } = render(state, { now: 110_000 });
		expect(lines[0]).toBe(at("AGENTS", "2 ✓ · 1 ✗"));
		expect(lines.join("\n")).not.toContain("more");
		expect(render(state, { now: 400_000 }).lines).toEqual([]);
	});

	it("treats a row without endedAt as expired unless it is unread", () => {
		const state = ended({ a: 100, b: 100 }, ["b"]);
		const bare = {
			...state,
			jobs: state.jobs.map(({ endedAt: _, ...rest }) => rest),
		};
		expect(labels(bare, 0)).toEqual(["JOBS", "b"]);
	});

	it("keeps the original finish time of a row once read", () => {
		const state = ended({ a: 100 }, ["a"]);
		const read = { ...state, unread: [] };
		expect(labels(read, 159_000)).toEqual(["JOBS", "a"]);
		expect(labels(read, 160_000)).toEqual([]);
	});

	it("tells the earliest deadline of a shown non-unread finished row across jobs and agents", () => {
		const state = stateOf([
			[0, job("a", "a")],
			[0, { type: "task_started", taskId: "t", agent: "w", label: "l", outputPath: "x", running: 2 } as Body],
			[100, jobEnd("a", 1000, { notified: false })],
			[
				90,
				{
					type: "task_finished",
					taskId: "t",
					agent: "w",
					label: "l",
					status: "finished",
					durationMs: 1000,
					outputPath: "x",
					notified: false,
					running: 0,
					waiting: 0,
				} as Body,
			],
		]);
		expect(nextSidePanelExpiry(state, 120_000)).toBe(150_000);
	});

	it("ignores rows capped out, unread, running or expired for the next expiry", () => {
		const capped = ended({ a: 100, b: 101, c: 102, d: 103 });
		expect(nextSidePanelExpiry(capped, 110_000)).toBe(161_000);
		expect(nextSidePanelExpiry(ended({ a: 10, b: 20 }, ["a", "b"]), 110_000)).toBeUndefined();
		expect(nextSidePanelExpiry(ended({ a: 10 }), 70_000)).toBeUndefined();
		expect(nextSidePanelExpiry(stateOf([[0, job("r", "r")]]), 10_000)).toBeUndefined();
		expect(nextSidePanelExpiry(emptySidePanel(), 0)).toBeUndefined();
	});
});
