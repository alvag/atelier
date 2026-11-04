import { cacheHitRate, type FeatureTask, type Usage, visibleText } from "@atelier/core";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitChanges } from "./git-branch.ts";
import type { PanelAgent, PanelJob, SidePanelState } from "./side-panel-state.ts";
import type { Paint } from "./style.ts";
import type { Ink } from "./theme.ts";

/** The panel's tabs, in the order of their labels. */
export const PANEL_TABS = ["status", "session"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

const TAB_LABELS: Record<PanelTab, string> = { status: "Status", session: "Session" };
/** The cells between two tab labels. */
const TAB_GAP = 2;

/** Finished jobs or agents shown besides the unread ones, for the minute after they end. */
const FINISHED_SHOWN = 3;
const FINISHED_FOR = 60_000;

/** What the panel shows: its state and what the TUI knows apart from the events. */
export interface PanelView {
	state: SidePanelState;
	now: number;
	/** When this TUI opened the session. */
	startedAt: number;
	/** The name the user gave the session with `/rename`. */
	name?: string;
	savedId?: string;
	mode?: string;
	git?: GitChanges;
	/** The tab whose lines are wanted. */
	tab: PanelTab;
	/** Whether Tasks lists every task with its id, rather than the summary. */
	tasksExpanded?: boolean;
}

/** The lines of one tab and the rows of the task in progress. */
export interface PanelLines {
	lines: string[];
	current?: { start: number; end: number };
}

type Painters = { ink: Ink; paint: Paint };

/** Event text on one row: control characters as markers, newlines and tabs as their symbols. */
const oneLine = (text: string) => visibleText(text).text.replaceAll("\n", "␊").replaceAll("\t", "␉");

/** `text` cut to `width` cells with `…`; plain text stays plain. */
function cut(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const kept = truncateToWidth(text, Math.max(0, width), "…");
	return text.includes("\x1b") ? kept : stripTerminalSequences(kept);
}

/** `left` cut so that `right` fits after it, `right` against the last column. */
function row(left: string, right: string, width: number): string {
	const room = width - visibleWidth(right) - (right === "" ? 0 : 1);
	if (room < 1) return cut(left, width);
	const kept = cut(left, room);
	return right === "" ? kept : `${kept}${" ".repeat(width - visibleWidth(kept) - visibleWidth(right))}${right}`;
}

/** `2m14s` under an hour, `1h10m` from then on. */
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** `42m`, `1h10m`: how long the session has been open. */
function sessionTime(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `950`, `61k`, `1.4M`. */
export function tokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000)
		return `${count < 10_000 ? (count / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const prompt = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

/** A section's first row: its name in capitals, and its counts. */
function header({ ink }: Painters, name: string, counts: string, width: number) {
	return row(ink.fg("textSecondary", name), counts, width);
}

/** The columns `[start, end)` of each tab's label on the first tab row. */
const TAB_RANGES = (() => {
	let start = 0;
	return PANEL_TABS.map((tab) => {
		const range = { tab, start, end: start + visibleWidth(TAB_LABELS[tab]) };
		start = range.end + TAB_GAP;
		return range;
	});
})();

/** The tab whose label covers column `x` of the first tab row; the gap and the space after the labels have none. */
export function tabAt(x: number): PanelTab | undefined {
	return TAB_RANGES.find((range) => x >= range.start && x < range.end)?.tab;
}

/** The two rows over the scroll: the labels, the active one in `text`, and a rule with the active label underlined in `brand`. */
export function tabRows(ink: Ink, active: PanelTab, width: number): [string, string] {
	const labels = TAB_RANGES.map(({ tab }) => ink.fg(tab === active ? "text" : "textSecondary", TAB_LABELS[tab]));
	const { start, end } = TAB_RANGES.find((range) => range.tab === active) ?? { start: 0, end: 0 };
	const under = Math.min(end, width);
	const rule = [
		ink.fg("separator", "─".repeat(Math.min(start, width))),
		ink.fg("brand", "─".repeat(Math.max(0, under - start))),
		ink.fg("separator", "─".repeat(Math.max(0, width - under))),
	].join("");
	return [cut(labels.join(" ".repeat(TAB_GAP)), width), rule];
}

/** The parts that show something, between dots. */
const joined = ({ ink }: Painters, parts: string[]) =>
	parts.filter((part) => visibleWidth(part) > 0).join(ink.fg("textSecondary", " · "));

/** Running first, then every unread finished row newest first, then the newest other finished rows still in their minute. */
function ordered<T extends { status: string; endedAt?: number }>(rows: T[], waiting: (row: T) => boolean, now: number) {
	const newest = (a: T, b: T) => (b.endedAt ?? 0) - (a.endedAt ?? 0);
	const ended = rows.filter((each) => each.status !== "running");
	const unread = ended.filter(waiting).sort(newest);
	const others = ended
		.filter((each) => !waiting(each) && each.endedAt !== undefined && now < each.endedAt + FINISHED_FOR)
		.sort(newest)
		.slice(0, FINISHED_SHOWN);
	return { shown: [...rows.filter((each) => each.status === "running"), ...unread, ...others], others };
}

/** When the earliest finished row shown for its minute (not an unread one) goes away; none if no such row shows. */
export function nextSidePanelExpiry({ jobs, agents, unread }: SidePanelState, now: number): number | undefined {
	const deadlines = [
		...ordered(jobs, (job) => unread.includes(`job:${job.id}`), now).others,
		...ordered(agents, (agent) => unread.includes(`task:${agent.key}`), now).others,
	].map((each) => (each.endedAt ?? 0) + FINISHED_FOR);
	return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

function jobLines(view: PanelView, p: Painters, width: number): string[] {
	const { jobs, unread } = view.state;
	if (jobs.length === 0) return [];
	const { ink } = p;
	const waiting = (job: PanelJob) => unread.includes(`job:${job.id}`);
	const { shown } = ordered(jobs, waiting, view.now);
	if (shown.length === 0) return [];
	const lines = [header(p, "JOBS", "", width)];
	for (const job of shown) {
		const failed =
			job.status === "failed" || (job.status === "exited" && (job.signal !== undefined || job.exitCode !== 0));
		const mark =
			job.status === "running"
				? ink.fg("running", "◐")
				: job.status === "stopped"
					? ink.fg("textSecondary", "■")
					: failed
						? ink.fg("error", "✗")
						: ink.fg("success", "✓");
		const outcome =
			job.status === "stopped"
				? ink.fg("textSecondary", "stopped")
				: job.status === "failed"
					? ink.fg("error", "failed")
					: job.signal !== undefined
						? ink.fg("error", oneLine(job.signal))
						: failed
							? ink.fg("error", job.exitCode === undefined ? "failed" : `exit ${job.exitCode}`)
							: "";
		const time = job.status === "running" ? view.now - job.startedAt : (job.durationMs ?? 0);
		const clock = ink.fg(job.status === "running" ? "running" : "textSecondary", elapsed(time));
		const symbol = waiting(job) ? ink.fg("warning", "●") : mark;
		// A job waiting with its notice keeps its outcome on the right, `✓` included.
		const right = [waiting(job) && outcome === "" ? mark : outcome, clock].filter(Boolean).join(" ");
		lines.push(row(`${symbol} ${ink.fg("text", oneLine(job.label))}`, right, width));
	}
	return lines;
}

function agentLines(view: PanelView, p: Painters, width: number): string[] {
	const { agents, unread } = view.state;
	if (agents.length === 0) return [];
	const { ink } = p;
	const waiting = (agent: PanelAgent) => unread.includes(`task:${agent.key}`);
	const { shown } = ordered(agents, waiting, view.now);
	if (shown.length === 0) return [];
	const lines = [header(p, "AGENTS", "", width)];
	for (const agent of shown) {
		const mark =
			agent.status === "running"
				? ink.fg("running", "◐")
				: agent.status === "finished"
					? ink.fg("success", "✓")
					: agent.status === "stopped"
						? ink.fg("textSecondary", "■")
						: ink.fg("error", "✗");
		const time = agent.status === "running" ? view.now - agent.startedAt : (agent.durationMs ?? 0);
		const right = [
			agent.background ? ink.fg("textSecondary", "◷") : "",
			ink.fg(agent.status === "running" ? "running" : "textSecondary", elapsed(time)),
		];
		const symbol = waiting(agent) ? ink.fg("warning", "●") : mark;
		const name = `${oneLine(agent.agent)}${agent.label === "" ? "" : ` · ${oneLine(agent.label)}`}`;
		lines.push(row(`${symbol} ${ink.fg("text", name)}`, right.filter(Boolean).join("  "), width));
		const model = agent.model === undefined ? "" : oneLine(agent.model);
		if (agent.status === "failed" || (agent.status === "stopped" && agent.error !== undefined)) {
			lines.push(
				...wrapped("  ", oneLine(`no report: ${agent.error ?? "stopped"}`), width, (text) => ink.fg("error", text)),
			);
			continue;
		}
		let parts: string[];
		if (agent.status === "running")
			parts = [model, agent.tool === undefined || agent.background ? "" : `▸ ${oneLine(agent.tool.label)}`];
		else
			parts = [
				model,
				agent.usage === undefined ? "" : tokens(prompt(agent.usage) + agent.usage.output),
				agent.costUsd === undefined ? "" : `$${agent.costUsd.toFixed(2)}`,
			];
		const detail = parts.filter((part) => part !== "").join(" · ");
		if (detail !== "") lines.push(cut(`  ${ink.fg("textSecondary", cut(detail, Math.max(1, width - 2)))}`, width));
	}
	return lines;
}

/**
 * A task's title after its mark, on two rows at most, the second under the first's text and cut with `…`. A `right`
 * text stays against the last column of the first row, which the title leaves room for.
 */
function wrapped(
	lead: string,
	title: string,
	width: number,
	paintTitle: (text: string) => string,
	right = "",
): string[] {
	const indent = visibleWidth(lead);
	const room = Math.max(1, width - indent);
	const reserved = right === "" ? 0 : visibleWidth(right) + 1;
	const firstRoom = Math.max(1, room - reserved);
	const withRight = (text: string) =>
		right === "" ? text : `${text}${" ".repeat(Math.max(1, width - visibleWidth(text) - visibleWidth(right)))}${right}`;
	if (visibleWidth(title) <= firstRoom) return [withRight(`${lead}${paintTitle(title)}`)];
	let first = "";
	for (const word of title.split(" ")) {
		const next = first === "" ? word : `${first} ${word}`;
		if (visibleWidth(next) > firstRoom) break;
		first = next;
	}
	// Strip the truncator's reset before measuring how much plain source text was consumed.
	if (first === "") first = stripTerminalSequences(truncateToWidth(title, firstRoom, ""));
	const second = title.slice(first.length).trimStart();
	return [withRight(`${lead}${paintTitle(first)}`), `${" ".repeat(indent)}${paintTitle(cut(second, room))}`];
}

/** The pending tasks the summary lists; the rest are counted in its tail. */
const PENDING_SHOWN = 3;

/** `width` cells of bar: `▰` for the share done, `▱` for the rest. */
function progressBar({ ink }: Painters, done: number, total: number, width: number): string {
	const filled = total === 0 ? 0 : Math.round((done / total) * width);
	return `${ink.fg("success", "▰".repeat(filled))}${ink.fg("textSecondary", "▱".repeat(width - filled))}`;
}

function todoLines(
	view: PanelView,
	p: Painters,
	width: number,
	start: number,
): { lines: string[]; current?: PanelLines["current"] } {
	const feature = view.state.feature;
	if (feature === undefined) return { lines: [] };
	const { ink } = p;
	const counted = feature.tasks.filter((task) => task.status !== "dropped");
	const done = counted.filter((task) => task.status === "done").length;
	const counts = ink.fg("textSecondary", `${done}/${counted.length} · ctrl+t`);
	const lines = [header(p, "TASKS", counts, width)];
	lines.push(cut(ink.fg("text", oneLine(feature.title)), width), progressBar(p, done, counted.length, width));
	const count = (status: string) => feature.tasks.filter((task) => task.status === status).length;
	const pending = feature.tasks.filter((task) => task.status === "pending");
	const listed = new Set(pending.slice(0, PENDING_SHOWN));
	const shown = (status: string | undefined) => feature.tasks.filter((task) => task.status === status);
	const expanded = view.tasksExpanded === true;
	const summary = expanded
		? feature.tasks
		: [
				...shown("in_progress"),
				...shown("blocked"),
				...feature.tasks.filter((task) => listed.has(task) || task.status === undefined),
			];
	let current: PanelLines["current"];
	for (const task of summary) {
		const at = start + lines.length;
		lines.push(...taskLines(task, p, width, expanded));
		if (task.status === "in_progress" && current === undefined) current = { start: at, end: start + lines.length - 1 };
	}
	if (expanded) {
		lines.push(cut(ink.fg("textSecondary", "ctrl+t summary"), width));
		return { lines, ...(current === undefined ? {} : { current }) };
	}
	const tail = [
		pending.length > PENDING_SHOWN ? `+${pending.length - PENDING_SHOWN} pending` : "",
		count("done") > 0 ? `${count("done")} done` : "",
		count("dropped") > 0 ? `${count("dropped")} dropped` : "",
	].filter(Boolean);
	if (tail.length > 0) lines.push(cut(ink.fg("textSecondary", tail.join(" · ")), width));
	return { lines, ...(current === undefined ? {} : { current }) };
}

/**
 * A task: its title on one row, cut with `…`, without its id, and a note under it. In the full list the id leads the
 * title, which takes two rows at most, and a done task's commit stays at the right of the first.
 */
function taskLines(task: FeatureTask, { ink, paint }: Painters, width: number, full = false): string[] {
	const rows = (mark: string, paintTitle: (text: string) => string, right = "") => {
		const title = oneLine(task.title);
		if (!full) return [cut(`${mark} ${paintTitle(title)}`, width)];
		// After the mark, spaces and commit, leave at least half the remaining row for the title.
		const room = width - visibleWidth(mark) - 2 - (right === "" ? 0 : visibleWidth(right) + 1);
		const id = cut(oneLine(task.id), Math.max(1, Math.floor(room / 2)));
		return wrapped(`${mark} ${ink.fg("textSecondary", id)} `, title, width, paintTitle, right);
	};
	const text = (title: string) => ink.fg("text", title);
	switch (task.status) {
		case "in_progress":
			return [
				...rows(ink.fg("running", "◐"), (title) => paint("bold", text(title))).map((line) =>
					ink.bg("surface", line + " ".repeat(Math.max(0, width - visibleWidth(line)))),
				),
				...(task.note === undefined
					? []
					: wrapped("  ", oneLine(task.note), width, (text) => ink.fg("textSecondary", text))),
			];
		case "blocked":
			return [
				...rows(ink.fg("warning", "⊘"), text),
				...(task.note === undefined
					? []
					: wrapped("  ", `waiting: ${oneLine(task.note)}`, width, (text) => ink.fg("warning", text))),
			];
		case "done": {
			const commit = full && task.commit !== undefined ? oneLine(task.commit).slice(0, 7) : "";
			return rows(ink.fg("success", "✓"), text, commit === "" ? "" : ink.fg("textSecondary", commit));
		}
		case "dropped":
			return rows(ink.fg("textSecondary", "–"), (title) => paint("strikethrough", ink.fg("textSecondary", title)));
		case "pending":
			return rows(ink.fg("textSecondary", "○"), text);
		default:
			return rows(ink.fg("textSecondary", "·"), text);
	}
}

/** What stays wrong in the session: these rise to the top of the panel. */
export function statusAlerts({ status }: SidePanelState): string[] {
	return [
		...(status.mcp?.problems ?? []).map((problem) => `mcp: ${problem}`),
		...(status.memory !== undefined && !status.memory.available
			? [`memory unavailable${status.memory.reason === undefined ? "" : `: ${status.memory.reason}`}`]
			: []),
		...(status.review !== undefined && !status.review.available
			? [`no review${status.review.reason === undefined ? "" : `: ${status.review.reason}`}`]
			: []),
	];
}

const PERMISSIONS: Record<string, string> = {
	normal: "asks outside the sandbox",
	auto: "a classifier decides · destructive asks",
	yolo: "destructive confirmations",
};

function sessionLines(view: PanelView, p: Painters, width: number): string[] {
	const { ink } = p;
	const { status } = view.state;
	const lines: string[] = [];
	const group = (name: string, rows: string[]) => {
		if (rows.length === 0) return;
		lines.push(ink.fg("text", name), ...rows.map((each) => cut(` ${each}`, width)));
	};
	const label = (name: string, value: string) => `${ink.fg("textSecondary", name.padEnd(8))} ${value}`;
	const value = (text: string) => ink.fg("text", text);
	group("Session", [
		...(view.name === undefined ? [] : [value(oneLine(view.name))]),
		joined(p, [
			value(sessionTime(view.now - view.startedAt)),
			value(`${status.turns} turns`),
			view.savedId === undefined ? "" : ink.fg("textSecondary", `#${oneLine(view.savedId).slice(0, 8)}`),
		]),
	]);
	const rate = cacheHitRate(status.main);
	const used = prompt(status.tokens) + status.tokens.output > 0;
	group("Usage", [
		...(used
			? [label("Tokens", value(`in ${tokens(prompt(status.tokens))} · out ${tokens(status.tokens.output)}`))]
			: []),
		...(rate === undefined
			? []
			: [label("Cache", `${value(`${Math.round(rate * 100)}%`)} ${ink.fg("textSecondary", "orchestrator")}`)]),
		...(status.lastCompaction === undefined
			? []
			: [
					label(
						"Compact",
						value(
							`${status.compactions} · ${tokens(status.lastCompaction.before)} → ${status.lastCompaction.after === undefined ? "?" : tokens(status.lastCompaction.after)}`,
						),
					),
				]),
	]);
	if (view.mode !== undefined) {
		const mode = oneLine(view.mode);
		const named = mode === "yolo" ? ink.fg("warning", "YOLO") : value(mode);
		group("Permissions", [joined(p, [named, ink.fg("textSecondary", PERMISSIONS[mode] ?? "")])]);
	}
	const { lines: changed, files, commits } = view.git ?? {};
	if (changed !== undefined && files !== undefined) {
		const counters = [
			...(changed.added > 0 ? [ink.fg("success", `+${changed.added}`)] : []),
			...(changed.removed > 0 ? [ink.fg("error", `−${changed.removed}`)] : []),
		].join(" ");
		const moved = [
			...(commits?.ahead ? [`↑${commits.ahead}`] : []),
			...(commits?.behind ? [`↓${commits.behind}`] : []),
		];
		group("Changes", [
			joined(p, [
				value(files === 1 ? "1 file" : `${files} files`),
				counters,
				moved.length > 0 ? ink.fg("focus", moved.join(" ")) : "",
			]),
		]);
	}
	const memory = status.memory?.available
		? joined(p, [
				status.memory.project === undefined ? "" : value(`project ${oneLine(status.memory.project)}`),
				status.memory.savedId === undefined ? "" : ink.fg("textSecondary", `#${status.memory.savedId}`),
			])
		: "";
	const servers = status.mcp?.servers ?? [];
	const failed = servers.filter((server) => server.state === "failed" || server.state === "invalid").length;
	const mcp =
		servers.length === 0
			? ""
			: failed === 0
				? `${value(`${servers.length} servers`)} ${ink.fg("success", "✓")}`
				: joined(p, [value(`${servers.length} servers`), ink.fg("warning", `${failed} failed`)]);
	const instructions = joined(p, [
		...(status.instructions ?? []).map((file) => value(oneLine(file.split("/").at(-1) ?? file))),
		status.skills === undefined || status.skills.length === 0
			? ""
			: value(status.skills.length === 1 ? "1 skill" : `${status.skills.length} skills`),
	]);
	group("Integrations", [
		...(status.memory?.available ? [label("memory", memory || value("on"))] : []),
		...(mcp === "" ? [] : [label("mcp", mcp)]),
		...(status.reviews === 0 ? [] : [label("review", value(`${status.reviews} · ${status.findings} findings`))]),
		...(instructions === "" ? [] : [instructions]),
	]);
	return lines;
}

/**
 * The lines of the tab at `width` cells. Status: the Todos, the jobs and the agents that have something, a rule
 * between them. Session: the alerts, a blank line and the session's groups.
 */
export function sidePanelLines(view: PanelView, ink: Ink, paint: Paint, width: number): PanelLines {
	const p = { ink, paint };
	const lines: string[] = [];
	if (view.tab === "session") {
		const alerts = statusAlerts(view.state);
		for (const alert of alerts) lines.push(cut(ink.fg("warning", `⚠ ${oneLine(alert)}`), width));
		if (alerts.length > 0) lines.push("");
		lines.push(...sessionLines(view, p, width));
		return { lines };
	}
	const rule = ink.fg("separator", "─".repeat(width));
	let current: PanelLines["current"];
	const sections = [
		(start: number) => {
			const todos = todoLines(view, p, width, start);
			current = todos.current;
			return todos.lines;
		},
		() => jobLines(view, p, width),
		() => agentLines(view, p, width),
	];
	for (const section of sections) {
		const block = section(lines.length + (lines.length > 0 ? 1 : 0));
		if (block.length === 0) continue;
		if (lines.length > 0) lines.push(rule);
		lines.push(...block);
	}
	return { lines, ...(current === undefined ? {} : { current }) };
}
