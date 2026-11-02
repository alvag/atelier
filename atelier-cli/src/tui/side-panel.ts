import { cacheHitRate, type FeatureTask, type Usage, visibleText } from "@atelier/core";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { featureProgress } from "./feature-panel.ts";
import type { GitChanges } from "./git-branch.ts";
import type { PanelAgent, PanelJob, SidePanelState } from "./side-panel-state.ts";
import type { Paint } from "./style.ts";
import type { Ink } from "./theme.ts";

/** The sections, in the panel's order. */
export const SECTIONS = ["jobs", "agents", "todos", "status"] as const;
export type Section = (typeof SECTIONS)[number];

/** Finished jobs or agents shown under the running ones before `+N more`. */
const FINISHED_SHOWN = 5;
/** The cells of the Todos progress bar. */
const PROGRESS_CELLS = 6;

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
	folded: ReadonlySet<Section>;
}

/** The panel's lines, the rows of each section's header (for a click to fold it) and the rows of the task in progress. */
export interface PanelLines {
	lines: string[];
	headers: Map<number, Section>;
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

/** A section's first row: its icon, its name in bold, `▾` open or `▸` folded, and its counts. */
function header({ ink, paint }: Painters, icon: string, name: string, open: boolean, counts: string, width: number) {
	const left = `${ink.fg("textSecondary", icon)} ${paint("bold", ink.fg("text", name))} ${ink.fg("textSecondary", open ? "▾" : "▸")}`;
	return row(left, counts, width);
}

/** The parts that show something, between dots. */
const joined = ({ ink }: Painters, parts: string[]) =>
	parts.filter((part) => visibleWidth(part) > 0).join(ink.fg("textSecondary", " · "));

/** Running first, then those with a notice waiting, then the finished ones newest first; `rest` is how many are left out. */
function ordered<T extends { status: string; endedAt?: number }>(rows: T[], waiting: (row: T) => boolean) {
	const running = rows.filter((each) => each.status === "running");
	const ended = rows
		.filter((each) => each.status !== "running")
		.sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || (b.endedAt ?? 0) - (a.endedAt ?? 0));
	const kept = ended.filter((each, at) => waiting(each) || at < FINISHED_SHOWN);
	return { shown: [...running, ...kept], rest: ended.length - kept.length };
}

function jobLines(view: PanelView, p: Painters, width: number): string[] {
	const { jobs, unread } = view.state;
	if (jobs.length === 0) return [];
	const { ink } = p;
	const waiting = (job: PanelJob) => unread.includes(`job:${job.id}`);
	const running = jobs.filter((job) => job.status === "running").length;
	const notices = jobs.filter(waiting).length;
	const counts = joined(p, [
		running > 0 ? `${running} running` : "",
		notices > 0 ? `${notices} ${ink.fg("warning", "●")}` : "",
	]);
	const open = !view.folded.has("jobs");
	const lines = [header(p, "⧗", "Jobs", open, ink.fg("textSecondary", counts), width)];
	if (!open) return lines;
	const { shown, rest } = ordered(jobs, waiting);
	for (const job of shown) {
		const failed =
			job.status === "failed" || (job.status === "exited" && (job.signal !== undefined || job.exitCode !== 0));
		const mark =
			job.status === "running"
				? ink.fg("running", "⧗")
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
							? ink.fg("error", `exit ${job.exitCode}`)
							: "";
		const time = job.status === "running" ? view.now - job.startedAt : (job.durationMs ?? 0);
		const clock = ink.fg(job.status === "running" ? "running" : "textSecondary", elapsed(time));
		const symbol = waiting(job) ? ink.fg("warning", "●") : mark;
		// A job waiting with its notice keeps its outcome on the right, `✓` included.
		const right = [waiting(job) && outcome === "" ? mark : outcome, clock].filter(Boolean).join(" ");
		lines.push(row(`${symbol} ${ink.fg("text", oneLine(job.label))}`, right, width));
	}
	if (rest > 0) lines.push(row("", ink.fg("textSecondary", `+${rest} more`), width));
	return lines;
}

function agentLines(view: PanelView, p: Painters, width: number): string[] {
	const { agents, unread } = view.state;
	if (agents.length === 0) return [];
	const { ink } = p;
	const waiting = (agent: PanelAgent) => unread.includes(`task:${agent.key}`);
	const count = (status: PanelAgent["status"]) => agents.filter((agent) => agent.status === status).length;
	const counts = joined(p, [
		count("running") > 0 ? `${count("running")} running` : "",
		count("finished") > 0 ? `${count("finished")} ${ink.fg("success", "✓")}` : "",
		count("failed") > 0 ? `${count("failed")} ${ink.fg("error", "✗")}` : "",
	]);
	const open = !view.folded.has("agents");
	const lines = [header(p, "❀", "Agents", open, ink.fg("textSecondary", counts), width)];
	if (!open) return lines;
	const { shown, rest } = ordered(agents, waiting);
	for (const agent of shown) {
		const mark =
			agent.status === "running"
				? ink.fg("running", "⧗")
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
		const model = agent.model === undefined ? "" : ink.fg("textSecondary", oneLine(agent.model));
		let detail: string;
		if (agent.status === "running")
			detail = joined(p, [model, agent.tool === undefined ? "" : ink.fg("running", `▸ ${oneLine(agent.tool.label)}`)]);
		else if (agent.status === "failed" || (agent.status === "stopped" && agent.error !== undefined))
			detail = ink.fg("error", oneLine(`no report: ${agent.error ?? "stopped"}`));
		else {
			const used = agent.usage === undefined ? "" : tokens(prompt(agent.usage) + agent.usage.output);
			const cost = agent.costUsd === undefined ? "" : `$${agent.costUsd.toFixed(2)}`;
			detail = joined(p, [model, ink.fg("textSecondary", used), ink.fg("textSecondary", cost)]);
		}
		if (visibleWidth(detail) > 0) lines.push(cut(`  ${detail}`, width));
	}
	if (rest > 0) lines.push(row("", ink.fg("textSecondary", `+${rest} more`), width));
	return lines;
}

/** A task's title after its mark, on two rows at most, the second under the first's text and cut with `…`. */
function wrapped(lead: string, title: string, width: number, paintTitle: (text: string) => string): string[] {
	const indent = visibleWidth(lead);
	const room = Math.max(1, width - indent);
	if (visibleWidth(title) <= room) return [`${lead}${paintTitle(title)}`];
	let first = "";
	for (const word of title.split(" ")) {
		const next = first === "" ? word : `${first} ${word}`;
		if (visibleWidth(next) > room) break;
		first = next;
	}
	// A first word wider than the row is cut where it ends.
	if (first === "") first = truncateToWidth(title, room, "");
	const second = title.slice(first.length).trimStart();
	return [`${lead}${paintTitle(first)}`, `${" ".repeat(indent)}${paintTitle(cut(second, room))}`];
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
	const { done, total } = featureProgress(feature);
	const filled = total === 0 ? 0 : Math.round((done / total) * PROGRESS_CELLS);
	const bar = `${"▰".repeat(filled)}${"▱".repeat(PROGRESS_CELLS - filled)}`;
	const open = !view.folded.has("todos");
	const counts = ink.fg("textSecondary", `${done}/${total} ${bar}  ctrl+t`);
	const lines = [header(p, "◆", "Todos", open, counts, width)];
	if (!open) return { lines };
	lines.push(cut(ink.fg("text", oneLine(feature.title)), width));
	const finished = feature.tasks.filter((task) => task.status === "done");
	if (finished.length > 0) {
		const commit = finished.findLast((task) => task.commit !== undefined)?.commit;
		lines.push(
			row(
				`${ink.fg("success", "✓")} ${ink.fg("text", `${finished.length} done`)}`,
				commit === undefined ? "" : ink.fg("textSecondary", oneLine(commit).slice(0, 7)),
				width,
			),
		);
	}
	let current: PanelLines["current"];
	for (const task of feature.tasks) {
		if (task.status === "done") continue;
		const at = start + lines.length;
		lines.push(...taskLines(task, p, width));
		if (task.status === "in_progress" && current === undefined) current = { start: at, end: start + lines.length - 1 };
	}
	return { lines, ...(current === undefined ? {} : { current }) };
}

function taskLines(task: FeatureTask, { ink, paint }: Painters, width: number): string[] {
	const title = `${oneLine(task.id)} ${oneLine(task.title)}`;
	switch (task.status) {
		case "in_progress":
			return wrapped(`${paint("bold", ink.fg("text", "▸"))} `, title, width, (text) =>
				paint("bold", ink.fg("text", text)),
			);
		case "blocked": {
			const lines = wrapped(`${ink.fg("warning", "⊘")} `, title, width, (text) => ink.fg("text", text));
			return task.note === undefined
				? lines
				: [...lines, cut(`  ${ink.fg("warning", `waiting: ${oneLine(task.note)}`)}`, width)];
		}
		case "dropped":
			return wrapped("  ", title, width, (text) => paint("strikethrough", ink.fg("textSecondary", text)));
		case "pending":
			return wrapped(`${ink.fg("textSecondary", "○")} `, title, width, (text) => ink.fg("text", text));
		default:
			return wrapped(`${ink.fg("textSecondary", "·")} `, title, width, (text) => ink.fg("text", text));
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

function statusLines(view: PanelView, p: Painters, width: number): string[] {
	const { ink } = p;
	const { status } = view.state;
	const open = !view.folded.has("status");
	const lines = [header(p, "✿", "Status", open, "", width)];
	if (!open) return lines;
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
	const mcp =
		status.mcp === undefined || status.mcp.servers === 0
			? ""
			: status.mcp.failed.length === 0
				? `${value(`${status.mcp.servers} servers`)} ${ink.fg("success", "✓")}`
				: joined(p, [value(`${status.mcp.servers} servers`), ink.fg("warning", `${status.mcp.failed.length} failed`)]);
	const instructions = joined(p, [
		...(status.instructions ?? []).map((file) => value(oneLine(file.split("/").at(-1) ?? file))),
		status.skills === undefined || status.skills === 0
			? ""
			: value(status.skills === 1 ? "1 skill" : `${status.skills} skills`),
	]);
	group("Integrations", [
		...(status.memory?.available ? [label("memory", memory || value("on"))] : []),
		...(mcp === "" ? [] : [label("mcp", mcp)]),
		...(status.reviews === 0 ? [] : [label("review", value(`${status.reviews} · ${status.findings} findings`))]),
		...(instructions === "" ? [] : [instructions]),
	]);
	return lines;
}

/** The panel's lines at `width` cells: the alerts, then each section that has something, a blank line between them. */
export function sidePanelLines(view: PanelView, ink: Ink, paint: Paint, width: number): PanelLines {
	const p = { ink, paint };
	const lines: string[] = [];
	const headers = new Map<number, Section>();
	let current: PanelLines["current"];
	const alerts = statusAlerts(view.state);
	for (const alert of alerts) lines.push(cut(ink.fg("warning", `⚠ ${oneLine(alert)}`), width));
	for (const section of SECTIONS) {
		const start = lines.length + (lines.length > 0 ? 1 : 0);
		let block: string[];
		if (section === "jobs") block = jobLines(view, p, width);
		else if (section === "agents") block = agentLines(view, p, width);
		else if (section === "status") block = statusLines(view, p, width);
		else {
			const todos = todoLines(view, p, width, start);
			block = todos.lines;
			current = todos.current;
		}
		if (block.length === 0) continue;
		if (lines.length > 0) lines.push("");
		headers.set(lines.length, section);
		lines.push(...block);
	}
	return { lines, headers, ...(current === undefined ? {} : { current }) };
}
