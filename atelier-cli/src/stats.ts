import { resolve } from "node:path";
import { readSessionStats, type SessionStats, type StatsRow, type StatsSpend, type Usage } from "@atelier/core";

/** The breakdowns `--by` can choose, in the order they print. */
const BREAKDOWNS = ["day", "project", "model", "phase", "role"] as const;
type Breakdown = (typeof BREAKDOWNS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

interface StatsIO {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	cwd: string;
	home: string;
}

/** `atelier stats`: what the saved sessions spent, read only. Exits 2 on a bad option. */
export async function runStats(
	options: { since?: string; project?: string; by?: string; json?: true },
	io: StatsIO,
): Promise<number> {
	const period = parseSince(options.since ?? "30d", Date.now());
	if (period === undefined) return usage(io, "--since must be a number of days (7d), a date (2026-10-01) or all.");
	const by = options.by;
	if (by !== undefined && !(BREAKDOWNS as readonly string[]).includes(by))
		return usage(io, `--by must be ${BREAKDOWNS.slice(0, -1).join(", ")} or ${BREAKDOWNS.at(-1)}.`);
	const project = options.project === undefined ? undefined : resolve(io.cwd, options.project);
	const stats = await readSessionStats(io.home, {
		...(period.since === undefined ? {} : { since: period.since }),
		...(project === undefined ? {} : { project }),
	});
	if (options.json) {
		io.stdout(`${JSON.stringify({ since: period.since?.toISOString() ?? null, ...stats }, null, 2)}\n`);
		return 0;
	}
	io.stdout(report(stats, period.label, by === undefined ? BREAKDOWNS : [by as Breakdown]));
	return 0;
}

function usage(io: StatsIO, message: string): number {
	io.stderr(`error: ${message}\nRun atelier --help for usage.\n`);
	return 2;
}

/** `7d`: the last 7 days; `2026-10-01`: from that local midnight on; `all`: everything. */
export function parseSince(value: string, now: number): { since?: Date; label: string } | undefined {
	if (value === "all") return { label: "all time" };
	const days = /^(\d+)d$/.exec(value);
	if (days) {
		const count = Number(days[1]);
		if (count < 1) return undefined;
		return { since: new Date(now - count * DAY_MS), label: count === 1 ? "last day" : `last ${count} days` };
	}
	const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!date) return undefined;
	const since = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
	// A date that rolls over (2026-02-30) is not a date.
	if (since.getDate() !== Number(date[3]) || since.getMonth() !== Number(date[2]) - 1) return undefined;
	return { since, label: `since ${value}` };
}

function report(stats: SessionStats, label: string, breakdowns: readonly Breakdown[]): string {
	const { total } = stats;
	const lines = [
		`atelier stats · ${label} · ${plural(stats.sessions, "session")} · ${plural(stats.byProject.length, "project")}`,
		"",
	];
	if (total.turns === 0)
		lines.push(`No turns ${label === "all time" ? "saved" : label.replace(/^last/, "in the last")}.`);
	else {
		lines.push(
			`Total    ${totalCost(total)}`,
			`         ${plural(total.turns, "turn")} · ${plural(total.requests, "request")}`,
			`Tokens   ${tokens(total.usage)}`,
		);
		for (const by of breakdowns) lines.push("", ...table(`By ${by}`, rowsOf(stats, by)));
	}
	if (stats.skipped.length > 0) lines.push("", skippedNotice(stats));
	return `${lines.join("\n")}\n`;
}

function rowsOf(stats: SessionStats, by: Breakdown): StatsRow[] {
	const rows = {
		day: stats.byDay,
		project: stats.byProject,
		model: stats.byModel,
		phase: stats.byPhase,
		role: stats.byRole,
	};
	return rows[by];
}

/** `$1.50 billed · ≈$3.00 subscription (...) · 1 turn with no known cost`, each part only when there is one. */
function totalCost(total: StatsSpend): string {
	const parts = [`${usd(total.billedUsd)} billed`];
	if (total.subscriptionUsd > 0) parts.push(`≈${usd(total.subscriptionUsd)} subscription (API-equivalent, not billed)`);
	if (total.unpriced > 0) parts.push(`${plural(total.unpriced, "turn")} with no known cost`);
	return parts.join(" · ");
}

/** A row's cost: what was billed, what a subscription reported, and how many parts said none. */
function rowCost(row: StatsSpend): string {
	const parts: string[] = [];
	if (row.billedUsd > 0 || (row.subscriptionUsd === 0 && row.unpriced === 0)) parts.push(usd(row.billedUsd));
	if (row.subscriptionUsd > 0) parts.push(`≈${usd(row.subscriptionUsd)} sub`);
	if (row.unpriced > 0) parts.push(`${row.unpriced} unknown`);
	return parts.join(" · ");
}

const COLUMNS = ["turns", "requests", "in", "out", "cache r", "cache w"];

/** A breakdown as aligned columns: the key and the cost to the left, the counts to the right. */
function table(title: string, rows: readonly StatsRow[]): string[] {
	const cells = rows.map((row) => [
		row.key,
		rowCost(row),
		String(row.turns),
		String(row.requests),
		compact(row.usage.input),
		compact(row.usage.output),
		compact(row.usage.cacheRead),
		compact(row.usage.cacheWrite),
	]);
	const head = [title, "cost", ...COLUMNS];
	const widths = head.map((name, column) => Math.max(name.length, ...cells.map((cell) => (cell[column] ?? "").length)));
	const line = (cell: string[]) =>
		cell
			.map((text, column) => {
				const width = widths[column] ?? 0;
				return column < 2 ? text.padEnd(width) : text.padStart(width);
			})
			.join(GAP)
			.trimEnd();
	return [line(head), ...cells.map(line)];
}

const GAP = "   ";

function skippedNotice(stats: SessionStats): string {
	const corrupt = stats.skipped.filter((file) => file.code === "corrupt").length;
	const other = stats.skipped.length - corrupt;
	const why = [
		...(corrupt > 0 ? [`${corrupt} corrupt`] : []),
		...(other > 0 ? [`${other} from another session format version`] : []),
	];
	return `Skipped ${plural(stats.skipped.length, "session file")}: ${why.join(", ")} (atelier stats --json lists them).`;
}

function tokens(usage: Usage): string {
	return `in ${compact(usage.input)} · out ${compact(usage.output)} · cache read ${compact(usage.cacheRead)} · cache write ${compact(usage.cacheWrite)}`;
}

function usd(value: number): string {
	return `$${value.toFixed(2)}`;
}

/** 950, 1.2k, 50k, 2.1M. */
function compact(value: number): string {
	const scale = (divisor: number, suffix: string) => {
		const scaled = value / divisor;
		return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}${suffix}`;
	};
	if (value >= 1_000_000) return scale(1_000_000, "M");
	if (value >= 1000) return scale(1000, "k");
	return String(value);
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}
