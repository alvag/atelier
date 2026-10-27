import { type AtelierEvent, type FeatureTask, visibleText } from "@atelier/core";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Paint, Style } from "./style.ts";

const shown = (text: string) => visibleText(text).text;
const padded = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** The active ODD feature as the TUI keeps it: what the main agent's latest `feature_changed` said. */
export interface FeatureState {
	name: string;
	path: string;
	title: string;
	tasks: FeatureTask[];
}

/** How far the feature is: the task in progress and how many are done. The panel and the footer both say it. */
export interface FeatureProgress {
	id?: string;
	done: number;
	total: number;
}

/** The feature after an event; a subagent's `feature_changed` says nothing about the session's feature. */
export function featureAfter(state: FeatureState | undefined, event: AtelierEvent): FeatureState | undefined {
	if (event.type !== "feature_changed" || event.parentCallId !== undefined) return state;
	return { name: event.name, path: event.path, title: event.title, tasks: event.tasks };
}

export function featureProgress({ tasks }: Pick<FeatureState, "tasks">): FeatureProgress {
	const now = tasks.find((task) => task.status === "in_progress");
	const done = tasks.filter((task) => task.status === "done").length;
	return { ...(now === undefined ? {} : { id: now.id }), done, total: tasks.length };
}

/** A task's state as the table says it; `—` for a document without a state column. */
const stateLabel = (status: string | undefined) =>
	status === undefined ? "—" : status === "in_progress" ? "in progress" : shown(status);

const STATE_STYLES: Record<string, Style> = {
	done: "green",
	in_progress: "cyan",
	blocked: "yellow",
	dropped: "dim",
	pending: "dim",
};

/**
 * The feature over the editor. Folded: `◆ M14 – TUI · 1/5 done · now T2 Hot profile`. Open: then a table of every
 * task's id, state and deliverable, the one in progress marked. Each line is cut to the width.
 */
export function featurePanelLines(
	state: FeatureState | undefined,
	open: boolean,
	width: number,
	paint: Paint,
): string[] {
	if (state === undefined) return [];
	const { done, total } = featureProgress(state);
	const now = state.tasks.find((task) => task.status === "in_progress");
	const head = [
		paint("bold", shown(state.title)),
		`${done}/${total} done`,
		...(now === undefined ? [] : [`now ${shown(now.id)} ${shown(now.title)}`]),
		paint("dim", open ? shown(state.path) : "Ctrl+T or /feature: tasks"),
	];
	const lines = [` ${paint("magenta", "◆")} ${head.join(paint("dim", " · "))}`];
	if (open && state.tasks.length > 0) {
		const ids = state.tasks.map((task) => shown(task.id));
		const states = state.tasks.map((task) => stateLabel(task.status));
		const idWidth = Math.max(visibleWidth("ID"), ...ids.map(visibleWidth));
		const stateWidth = Math.max(visibleWidth("State"), ...states.map(visibleWidth));
		lines.push(paint("dim", `     ${padded("ID", idWidth)}  ${padded("State", stateWidth)}  Deliverable`));
		state.tasks.forEach((task, at) => {
			const current = task.status === "in_progress";
			const style = STATE_STYLES[task.status ?? ""];
			const label = padded(states[at] ?? "", stateWidth);
			const row = `${padded(ids[at] ?? "", idWidth)}  ${style === undefined ? label : paint(style, label)}  ${shown(task.title)}`;
			lines.push(current ? `   ${paint("cyan", "▸")} ${paint("bold", row)}` : `     ${row}`);
		});
	}
	return lines.map((line) => truncateToWidth(line, width));
}

/** The panel of the session's feature; `/feature` and Ctrl+T open or fold it. */
export class FeaturePanel implements Component {
	open = false;
	#state: FeatureState | undefined;
	readonly #paint: Paint;

	constructor(paint: Paint) {
		this.#paint = paint;
	}

	/** Whether a feature is active, so that there is a panel to open. */
	get active(): boolean {
		return this.#state !== undefined;
	}

	toggle(): void {
		this.open = !this.open;
	}

	event(event: AtelierEvent): void {
		this.#state = featureAfter(this.#state, event);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return featurePanelLines(this.#state, this.open, width, this.#paint);
	}
}
