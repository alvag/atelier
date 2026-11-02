import type { AtelierEvent } from "@atelier/core";
import {
	type Component,
	HStack,
	ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";
import type { GitChanges } from "./git-branch.ts";
import { type PanelLines, type Section, sidePanelLines } from "./side-panel.ts";
import { emptySidePanel, type SidePanelState, sidePanelAfter } from "./side-panel-state.ts";
import type { Paint } from "./style.ts";
import type { Ink } from "./theme.ts";

/** The panel's columns, its rule included; the conversation keeps the rest. */
export const SIDE_PANEL_WIDTH = 40;
/** The narrowest terminal the panel shows in: 80 columns are left for the conversation. */
export const SIDE_PANEL_MIN_COLUMNS = 120;
/** How often a running job's or agent's time moves on. */
const TICK_MS = 1000;

/** What the panel shows that its events do not say. */
export interface SidePanelContext {
	name?: string | undefined;
	savedId?: string | undefined;
	mode?: string | undefined;
	git?: GitChanges | undefined;
}

export interface SidePanelOptions {
	/** Whether the user wants it, as `tui.sidePanel` says. */
	open: boolean;
	columns: () => number;
	context: () => SidePanelContext;
	now?: () => number;
}

/**
 * The fullscreen panel at the right of the conversation, the editor and the footer: the session's jobs, agents, tasks
 * and status (see `side-panel.ts`). It shows while the user wants it and the terminal has the columns for it; when its
 * rows do not fit, it scrolls under the mouse wheel, with where it is on its last row.
 */
export class SidePanel {
	open: boolean;
	/** The panel's part of the layout, beside the rest. */
	readonly component: Component;
	readonly #tui: TUI;
	readonly #ink: Ink;
	readonly #paint: Paint;
	readonly #options: SidePanelOptions;
	readonly #now: () => number;
	readonly #scroll: ScrollView;
	#state: SidePanelState = emptySidePanel();
	#startedAt: number;
	readonly #folded = new Set<Section>();
	#rendered: PanelLines = { lines: [], headers: new Map() };
	#width = SIDE_PANEL_WIDTH;
	#indicator = false;
	#ticker: NodeJS.Timeout | undefined;
	/** The task in progress the panel last scrolled to. */
	#current: string | undefined;

	constructor(tui: TUI, ink: Ink, paint: Paint, options: SidePanelOptions) {
		this.#tui = tui;
		this.#ink = ink;
		this.#paint = paint;
		this.#options = options;
		this.open = options.open;
		this.#now = options.now ?? Date.now;
		this.#startedAt = this.#now();
		const content: Component = {
			render: (width) => this.#render(width).lines,
			invalidate: () => {},
			handleMouse: (event) => this.#click(event),
		};
		this.#scroll = new ScrollView(content, { follow: "none", overscroll: "contain", scrollbar: "hidden" });
		const rule: Component = {
			// As tall as any terminal: the layout cuts it to the panel's height.
			render: () => Array.from({ length: Math.max(1, this.#tui.terminal.rows) }, () => this.#ink.fg("separator", "│")),
			invalidate: () => {},
		};
		const indicator: Component = { render: () => [this.#where()], invalidate: () => {} };
		const body = new VStack([
			{ component: this.#scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: indicator, basis: 1, grow: 0, shrink: 0, visible: () => this.#overflows() },
		]);
		this.component = new HStack(
			[
				{ component: rule, basis: 1, grow: 0, shrink: 0 },
				{ component: body, basis: 0, grow: 1, shrink: 1 },
			],
			{ gap: 1 },
		);
	}

	/** Whether the terminal has the columns for it. */
	fits(columns = this.#options.columns()): boolean {
		return columns >= SIDE_PANEL_MIN_COLUMNS;
	}

	/** Whether it is on screen: the footer and the feature panel leave to it what it lists. */
	shown(columns = this.#options.columns()): boolean {
		return this.open && this.fits(columns);
	}

	/** Whether a feature is active, for its Todos to fold. */
	get hasFeature(): boolean {
		return this.#state.feature !== undefined;
	}

	event(event: AtelierEvent): void {
		const before = this.#state.feature;
		this.#state = sidePanelAfter(this.#state, event, this.#now());
		if (this.#state.feature !== before) this.#followTask();
		this.#tick();
	}

	/** A new session: nothing of the one before; the sections stay folded as they were. */
	reset(): void {
		this.#state = emptySidePanel();
		this.#startedAt = this.#now();
		this.#current = undefined;
		this.#scroll.scrollToStart();
		this.#tick();
	}

	fold(section: Section): void {
		if (this.#folded.has(section)) this.#folded.delete(section);
		else this.#folded.add(section);
	}

	/** Stops the clock of the running rows, once the TUI stops. */
	stop(): void {
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#render(width: number): PanelLines {
		this.#width = width;
		const context = this.#options.context();
		this.#rendered = sidePanelLines(
			{
				state: this.#state,
				now: this.#now(),
				startedAt: this.#startedAt,
				folded: this.#folded,
				...(context.name === undefined ? {} : { name: context.name }),
				...(context.savedId === undefined ? {} : { savedId: context.savedId }),
				...(context.mode === undefined ? {} : { mode: context.mode }),
				...(context.git === undefined ? {} : { git: context.git }),
			},
			this.#ink,
			this.#paint,
			// One column kept free at the right edge.
			Math.max(1, width - 1),
		);
		return this.#rendered;
	}

	/** A left click on a section's first row folds or opens it. */
	#click(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const section = this.#rendered.headers.get(event.y);
		if (section === undefined) return undefined;
		this.fold(section);
		return { handled: true };
	}

	/** Its rows do not fit in its height: the last row says where the view is. */
	#overflows(): boolean {
		const height = this.#scroll.viewportHeight + (this.#indicator ? 1 : 0);
		this.#indicator = height > 0 && this.#rendered.lines.length > height;
		return this.#indicator;
	}

	/** `↑↓ 1–11/21`: the rows in view and how many there are. */
	#where(): string {
		const total = this.#rendered.lines.length;
		const top = this.#scroll.scrollTop;
		const bottom = Math.min(total, top + this.#scroll.viewportHeight);
		return this.#ink.fg("textSecondary", `↑↓ ${top + 1}–${bottom}/${total}`);
	}

	/** When another task is in progress, its rows come into view. */
	#followTask(): void {
		const id = this.#state.feature?.tasks.find((task) => task.status === "in_progress")?.id;
		if (id === this.#current) return;
		this.#current = id;
		const { current } = this.#render(this.#width);
		const height = this.#scroll.viewportHeight;
		if (current === undefined || height <= 0) return;
		const top = this.#scroll.scrollTop;
		if (current.start < top) this.#scroll.scrollTo(current.start);
		else if (current.end >= top + height) this.#scroll.scrollTo(current.end - height + 1);
	}

	/** One render a second while a job or an agent runs and the panel is on screen; none otherwise. */
	#tick(): void {
		const running = [...this.#state.jobs, ...this.#state.agents].some((row) => row.status === "running");
		if (running && this.#ticker === undefined) {
			this.#ticker = setInterval(() => {
				if (this.shown()) this.#tui.requestRender();
			}, TICK_MS);
			this.#ticker.unref();
		} else if (!running) this.stop();
	}
}
