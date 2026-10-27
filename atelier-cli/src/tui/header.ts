import { visibleText } from "@atelier/core";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
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
