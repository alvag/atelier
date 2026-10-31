import { basename } from "node:path";
import { type ContextGauge, type ContextLevel, contextGauge, visibleText } from "@atelier/core";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterState } from "./footer.ts";
import type { GitChanges } from "./git-branch.ts";
import type { Paint } from "./style.ts";
import type { Ink, ThemeToken } from "./theme.ts";

/** What the header says: Atelier's version, where it works, and the model and level the session runs with. */
export interface HeaderState {
	version?: string;
	cwd: string;
	home?: string;
	model?: string;
	effort?: string;
}

/** The working directory, under the home as `~`. */
const shortPath = (cwd: string, home: string | undefined) =>
	home !== undefined && home !== "/" && (cwd === home || cwd.startsWith(`${home}/`))
		? `~${cwd.slice(home.length)}`
		: cwd;

const shown = (text: string) => visibleText(text).text;

export type StatusBarState = FooterState & { cwd: string; home?: string; git?: GitChanges };

/** Newlines and tabs are useful in the transcript, but not in a fixed two-row summary. */
const oneLine = (text: string) => shown(text).replaceAll("\n", "␊").replaceAll("\t", "␉");

/** What the header gives up when it does not fit, in this order; each step keeps the ones before it. */
const SHRINK = ["folder", "cut path", "no label", "cut branch", "no profile", "no cost", "no window"] as const;
type Step = (typeof SHRINK)[number];

/** The color of the filled cells and the percentage, by how close compaction is. */
const LEVEL_TOKENS: Record<ContextLevel, ThemeToken> = { normal: "success", warning: "warning", danger: "error" };

/** `text` cut to `width` cells with `…`; plain text stays plain. */
function cut(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const kept = truncateToWidth(text, Math.max(0, width), "…");
	return text.includes("\x1b") ? kept : stripTerminalSequences(kept);
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/**
 * The fullscreen session header: Atelier and its version; the working directory over the branch and its Git counters;
 * the model, level and profile over the context gauge and cost. Two rows between vertical rules, closed by a rule.
 * When it does not fit it gives up, in order, what `SHRINK` names, then cuts each row to the width.
 */
export class StatusBar implements Component {
	readonly #ink: Ink;
	readonly #state: () => StatusBarState;
	constructor(ink: Ink, state: () => StatusBarState) {
		this.#ink = ink;
		this.#state = state;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const state = this.#state();
		const { fg } = this.#ink;
		const dot = ` ${fg("separator", "·")} `;
		const rule = fg("separator", "│");
		const version = state.version === undefined ? "" : `v${oneLine(state.version)}`;
		const identity = Math.max(visibleWidth("Atelier"), visibleWidth(version)) + 1;
		const fullPath = oneLine(shortPath(state.cwd, state.home));
		const folder = oneLine(basename(state.cwd)) || fullPath;
		const branch = state.branch === undefined ? undefined : oneLine(state.branch);
		const counters = gitCounters(state.git, this.#ink, dot);
		const model = state.model ?? state.backend;
		const running = [
			...(model === undefined ? [] : [fg("text", oneLine(model))]),
			...(state.effort === undefined ? [] : [fg("focus", oneLine(state.effort))]),
		].join(" ");
		const gauge = state.context === undefined ? undefined : contextGauge(state.context);
		const layout = (steps: number) => {
			const gives = (step: Step) => SHRINK.indexOf(step) < steps;
			const profile =
				state.profile === undefined || gives("no profile")
					? ""
					: fg("textSecondary", `${gives("no label") ? "" : "Profile "}${oneLine(state.profile)}`);
			const usage = [
				gauge === undefined ? "" : gaugeText(gauge, this.#ink),
				gauge === undefined || gives("no window") ? "" : fg("text", gauge.window),
				state.costUsd === undefined || gives("no cost")
					? ""
					: `${fg("textSecondary", "cost")} ${fg("text", `$${state.costUsd.toFixed(2)}`)}`,
			];
			const right = [[running, profile], usage].map((items) => items.filter(Boolean).join(dot));
			const rightWidth = Math.max(...right.map(visibleWidth));
			// The middle block's room, one column kept before the right block's rule.
			const room = width - identity - 2 - (rightWidth > 0 ? rightWidth + 3 : 0);
			let path = gives("folder") ? folder : fullPath;
			// A path or branch keeps at least one character and the `…`.
			if (gives("cut path")) path = cut(path, Math.max(2, room));
			let named = branch;
			if (named !== undefined && gives("cut branch"))
				named = cut(named, Math.max(2, room - visibleWidth(counters && dot + counters)));
			const git = [named === undefined ? "" : fg("text", named), counters].filter(Boolean).join(dot);
			const fits = visibleWidth(path) <= room && visibleWidth(git) <= room;
			return { right, rightWidth, path: fg("text", path), git, fits };
		};
		let chosen = layout(0);
		for (let steps = 1; !chosen.fits && steps <= SHRINK.length; steps++) chosen = layout(steps);
		const { right, rightWidth, path, git } = chosen;
		const content = Math.max(visibleWidth(path), visibleWidth(git));
		const middle = Math.max(content + 1, width - identity - 4 - rightWidth);
		const row = (name: string, center: string, usage = "") => {
			const text = `${pad(name, identity)}${rule} ${
				rightWidth > 0 ? `${pad(center, middle)}${rule}${usage && ` ${usage}`}` : center
			}`;
			return cut(text, width).trimEnd();
		};
		return [
			row(fg("brand", "Atelier"), path, right[0]),
			row(version && fg("textSecondary", version), git, right[1]),
			fg("separator", "─".repeat(Math.max(0, width))),
		];
	}
}

/** `+12 −4 · ↑2 ↓1`: lines added and removed, commits ahead and behind; a zero or unknown one is left out. */
function gitCounters({ lines, commits }: GitChanges = {}, { fg }: Ink, dot: string): string {
	const changed = [
		...(lines?.added ? [fg("success", `+${lines.added}`)] : []),
		...(lines?.removed ? [fg("error", `−${lines.removed}`)] : []),
	].join(" ");
	const moved = [...(commits?.ahead ? [`↑${commits.ahead}`] : []), ...(commits?.behind ? [`↓${commits.behind}`] : [])];
	return [changed, moved.length > 0 ? fg("focus", moved.join(" ")) : ""].filter(Boolean).join(dot);
}

/** `ctx ▰▰▱▱▱▱▱▱ 25%`: the filled cells and the percentage in the level's color; empty cells and an unknown size gray. */
function gaugeText(gauge: ContextGauge, { fg }: Ink): string {
	const filled = gauge.bar.replaceAll("▱", "");
	const empty = gauge.bar.slice(filled.length);
	const level = gauge.percent === undefined ? "textSecondary" : LEVEL_TOKENS[gauge.level];
	const cells = (filled && fg(level, filled)) + (empty && fg("textSecondary", empty));
	return `${fg("textSecondary", "ctx")} ${cells} ${fg(level, gauge.percent === undefined ? "?" : `${gauge.percent}%`)}`;
}

/**
 * The transcript's first lines, which scroll away with it and stay in the terminal on exit:
 * `Atelier 0.2.0 · ~/code/app` and `claude-opus-5-5 high`, then a blank line.
 */
export class Header implements Component {
	readonly #paint: Paint;
	readonly #state: () => HeaderState;
	constructor(paint: Paint, state: () => HeaderState) {
		this.#paint = paint;
		this.#state = state;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const { version, cwd, home, model, effort } = this.#state();
		const name = this.#paint("bold", version === undefined ? "Atelier" : `Atelier ${shown(version)}`);
		const lines = [` ${name}${this.#paint("dim", ` · ${shown(shortPath(cwd, home))}`)}`];
		const running = [model, effort].filter((part) => part !== undefined).map(shown);
		if (running.length > 0) lines.push(this.#paint("dim", ` ${running.join(" ")}`));
		return [...lines.map((line) => truncateToWidth(line, width)), ""];
	}
}
