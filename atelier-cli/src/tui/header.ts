import { basename } from "node:path";
import { visibleText } from "@atelier/core";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type FooterState, footerLine } from "./footer.ts";
import type { Paint } from "./style.ts";

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

export type StatusBarState = FooterState & { cwd: string; home?: string; changes?: number };

/** Newlines and tabs are useful in the transcript, but not in a fixed one-row summary. */
const oneLine = (text: string) => shown(text).replaceAll("\n", "␊").replaceAll("\t", "␉");

/** The fullscreen session summary: shorten the path, then the branch, before sacrificing any other left-hand text. */
export class StatusBar implements Component {
	readonly #paint: Paint;
	readonly #state: () => StatusBarState;
	constructor(paint: Paint, state: () => StatusBarState) {
		this.#paint = paint;
		this.#state = state;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const state = this.#state();
		const right = truncateToWidth(
			footerLine(state, Number.MAX_SAFE_INTEGER, this.#paint, ["context", "cost"]).trimStart(),
			width,
		);
		const separator = this.#paint("dim", " · ");
		const running = footerLine(state, Number.MAX_SAFE_INTEGER, this.#paint, ["model", "effort", "profile"])
			.trimStart()
			.replaceAll("\n", "␊")
			.replaceAll("\t", "␉");
		let path = oneLine(shortPath(state.cwd, state.home));
		let branch = state.branch === undefined ? "" : oneLine(state.branch);
		const changes = state.changes !== undefined && state.changes > 0 ? ` ±${state.changes}` : "";
		const left = () =>
			[path + (branch ? ` ${this.#paint("cyan", branch)}` : "") + changes, running].filter(Boolean).join(separator);
		const budget = Math.max(0, width - visibleWidth(right) - (right ? 1 : 0));
		if (visibleWidth(left()) > budget) path = oneLine(basename(state.cwd) || path);
		if (branch && visibleWidth(left()) > budget) {
			const room = visibleWidth(branch) - (visibleWidth(left()) - budget);
			branch = truncateToWidth(branch, Math.max(0, room), "…");
		}
		const kept = truncateToWidth(left(), budget, "…");
		return [kept + " ".repeat(Math.max(0, width - visibleWidth(kept) - visibleWidth(right))) + right];
	}
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
