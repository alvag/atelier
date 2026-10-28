import { readSessionStats } from "@atelier/core";
import { type Breakdown, parseSince, plural, statsReport } from "../stats.ts";

export const STATS_USAGE = "/stats [project] [--since 7d|YYYY-MM-DD|all]";

/** What `/stats` was asked for: this session or this folder's, and from when. */
export interface StatsRequest {
	project: boolean;
	since?: string;
}

/** `/stats`, `/stats project`, each with `--since <when>`; undefined for anything else. */
export function parseStatsCommand(words: readonly string[]): StatsRequest | undefined {
	const rest = [...words];
	const project = rest[0] === "project";
	if (project) rest.shift();
	if (rest.length === 0) return { project };
	if (rest.length === 2 && rest[0] === "--since" && rest[1] !== undefined) return { project, since: rest[1] };
	return undefined;
}

/** Whether a line is a `/stats` command, which runs even while a turn does. */
export function isStatsCommand(text: string): boolean {
	return /^\/stats(?:\s|$)/.test(text);
}

interface StatsPlace {
	home: string | undefined;
	cwd: string;
	/** The running session's saved id; undefined when it is not saved. */
	savedId: string | undefined;
}

/**
 * The note `/stats` prints, read from the saved sessions: the running one by default, which counts the turns that
 * finished, or the folder's from the last 30 days, as `atelier stats` does.
 */
export async function statsNote(
	request: StatsRequest,
	place: StatsPlace,
	now: number,
): Promise<{ text: string; warn: boolean }> {
	const period = parseSince(request.since ?? (request.project ? "30d" : "all"), now);
	if (period === undefined)
		return { text: "error: --since must be a number of days (7d), a date (2026-10-01) or all", warn: true };
	if (place.home === undefined) return { text: "error: no home directory to read the saved sessions from", warn: true };
	if (!request.project && place.savedId === undefined)
		return { text: "stats: this session is not saved; /stats project reads this folder's saved sessions", warn: false };
	const stats = await readSessionStats(place.home, {
		project: place.cwd,
		...(request.project || place.savedId === undefined ? {} : { session: place.savedId }),
		...(period.since === undefined ? {} : { since: period.since }),
	});
	const when = period.label === "all time" ? "" : ` ${period.label.replace(/^last/, "in the last")}`;
	if (request.project) {
		const text = statsReport(stats, {
			heading: `stats · this folder · ${period.label} · ${plural(stats.sessions, "session")}`,
			empty: `No turns${when === "" ? " saved" : when}.`,
			breakdowns: ["day", "model", "phase", "role"],
		});
		return { text: text.trimEnd(), warn: false };
	}
	// A session that ran on a single day has nothing to break down by day.
	const breakdowns: Breakdown[] =
		stats.byDay.length > 1 ? ["day", "model", "phase", "role"] : ["model", "phase", "role"];
	const text = statsReport(stats, {
		heading: `stats · this session${period.label === "all time" ? "" : ` · ${period.label}`} · finished turns`,
		empty: `No finished turns${when === "" ? " yet" : when}.`,
		breakdowns,
	});
	return { text: text.trimEnd(), warn: false };
}
