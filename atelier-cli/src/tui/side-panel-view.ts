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
import { type PanelLines, type PanelTab, sidePanelLines, tabAt, tabRows } from "./side-panel.ts";
import { emptySidePanel, type SidePanelState, sidePanelAfter, sidePanelResumed } from "./side-panel-state.ts";
import type { Paint } from "./style.ts";
import type { Ink } from "./theme.ts";

/** The panel's columns, its rule included; the conversation keeps the rest. */
export const SIDE_PANEL_WIDTH = 40;
/** The narrowest terminal the panel shows in: 80 columns are left for the conversation. */
export const SIDE_PANEL_MIN_COLUMNS = 120;
/** How often a running job's or agent's time moves on. */
const TICK_MS = 1000;

/**
 * The panel's scroll: after each layout, once it knows the rows it holds, it may move to keep a row in view; the
 * mouse wheel says the user took over.
 */
class PanelScroll extends ScrollView {
	afterLayout: () => void = () => {};
	onWheel: () => void = () => {};
	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		this.afterLayout();
	}
	override scrollBy(lines: number): number {
		this.onWheel();
		return super.scrollBy(lines);
	}
}

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
 * The fullscreen panel at the right of the conversation, the editor and the footer: two tabs under a fixed pair of
 * rows, Status (tasks, jobs and agents) and Session (see `side-panel.ts`). It shows while the user wants it and the
 * terminal has the columns for it; each tab keeps its own scroll, under the mouse wheel when its rows do not fit, with
 * where it is on the last row of the active one.
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
	readonly #scrolls: Record<PanelTab, PanelScroll>;
	#tab: PanelTab = "status";
	#state: SidePanelState = emptySidePanel();
	#startedAt: number;
	#todosFolded = false;
	#rendered: Record<PanelTab, PanelLines> = { status: { lines: [] }, session: { lines: [] } };
	/** Per tab, whether it shows the indicator: the layout of one tab says nothing of the other. */
	#indicators: Record<PanelTab, boolean> = { status: false, session: false };
	#ticker: NodeJS.Timeout | undefined;
	/** The task in progress the panel keeps in view. */
	#current: string | undefined;
	/** Whether it keeps that task in view: until the user scrolls the panel, and again once another task starts. */
	#following = true;

	constructor(tui: TUI, ink: Ink, paint: Paint, options: SidePanelOptions) {
		this.#tui = tui;
		this.#ink = ink;
		this.#paint = paint;
		this.#options = options;
		this.open = options.open;
		this.#now = options.now ?? Date.now;
		this.#startedAt = this.#now();
		const scroll = (tab: PanelTab) => {
			const content: Component = { render: (width) => this.#render(tab, width).lines, invalidate: () => {} };
			return new PanelScroll(content, { follow: "none", overscroll: "contain", scrollbar: "hidden" });
		};
		this.#scrolls = { status: scroll("status"), session: scroll("session") };
		// Only the Status tab holds the task in progress.
		this.#scrolls.status.afterLayout = () => {
			this.#keepTaskInView();
			this.#measure("status");
		};
		this.#scrolls.session.afterLayout = () => this.#measure("session");
		this.#scrolls.status.onWheel = () => {
			this.#following = false;
		};
		const tabs: Component = {
			// The width the rows get, less the column kept free at the right edge.
			render: (width) => tabRows(this.#ink, this.#tab, Math.max(1, width - 1)),
			invalidate: () => {},
			handleMouse: (event) => this.#click(event),
		};
		const rule: Component = {
			// As tall as any terminal: the layout cuts it to the panel's height.
			render: () => Array.from({ length: Math.max(1, this.#tui.terminal.rows) }, () => this.#ink.fg("separator", "│")),
			invalidate: () => {},
		};
		const indicator: Component = { render: () => [this.#where()], invalidate: () => {} };
		const scrolling = (tab: PanelTab) => ({
			component: this.#scrolls[tab],
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
			// The tab on show is the only one laid out.
			visible: () => this.#tab === tab,
		});
		const body = new VStack([
			{ component: tabs, basis: 2, grow: 0, shrink: 0 },
			scrolling("status"),
			scrolling("session"),
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

	/** Whether a feature is active, for its Todos to show. */
	get hasFeature(): boolean {
		return this.#state.feature !== undefined;
	}

	event(event: AtelierEvent): void {
		this.#state = sidePanelAfter(this.#state, event, this.#now());
		const current = this.#state.feature?.tasks.find((task) => task.status === "in_progress")?.id;
		if (current !== this.#current) {
			this.#current = current;
			this.#following = true;
		}
		this.#tick();
	}

	/** Another session: nothing of the one before but whether its Todos were folded, on the Status tab; a resumed one's saved status. */
	reset(saved?: readonly AtelierEvent[]): void {
		this.#state = saved === undefined ? emptySidePanel() : sidePanelResumed(saved);
		this.#startedAt = this.#now();
		this.#current = undefined;
		this.#following = true;
		this.#tab = "status";
		for (const scroll of Object.values(this.#scrolls)) scroll.scrollToStart();
		this.#tick();
	}

	/** The other tab, as Ctrl+N does; it stays until the next session. */
	toggleTab(): void {
		this.#tab = this.#tab === "status" ? "session" : "status";
	}

	/**
	 * Ctrl+T and `/feature`: from the Status tab they fold the Todos or open them; from the Session tab, where they are
	 * out of sight, they take the panel to Status with the Todos open.
	 */
	toggleTodos(): void {
		if (this.#tab === "session") {
			this.#tab = "status";
			this.#todosFolded = false;
		} else this.#todosFolded = !this.#todosFolded;
		// Opened, the Todos show the task in progress.
		if (!this.#todosFolded) this.#following = true;
	}

	/** Stops the clock of the running rows, once the TUI stops. */
	stop(): void {
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#render(tab: PanelTab, width: number): PanelLines {
		const context = this.#options.context();
		this.#rendered[tab] = sidePanelLines(
			{
				state: this.#state,
				now: this.#now(),
				startedAt: this.#startedAt,
				tab,
				todosFolded: this.#todosFolded,
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
		return this.#rendered[tab];
	}

	/** A left click on a tab's label selects it; the gap, the space after the labels and the rule under them do nothing. */
	#click(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		const tab = tabAt(event.x);
		if (tab === undefined) return undefined;
		this.#tab = tab;
		return { handled: true };
	}

	/** Its rows do not fit in its height: the last row says where the view is. */
	#overflows(): boolean {
		return this.#indicators[this.#tab];
	}

	/** After a tab's layout, which knows the height it got: if the indicator is not what its rows need, another render sets it. */
	#measure(tab: PanelTab): void {
		if (tab !== this.#tab) return;
		const height = this.#scrolls[tab].viewportHeight + (this.#indicators[tab] ? 1 : 0);
		const overflows = height > 0 && this.#rendered[tab].lines.length > height;
		if (overflows === this.#indicators[tab]) return;
		this.#indicators[tab] = overflows;
		this.#tui.requestRender();
	}

	/** `↑↓ 1–11/21`: the rows in view and how many there are. */
	#where(): string {
		const scroll = this.#scrolls[this.#tab];
		const total = this.#rendered[this.#tab].lines.length;
		const top = scroll.scrollTop;
		const bottom = Math.min(total, top + scroll.viewportHeight);
		return this.#ink.fg("textSecondary", `↑↓ ${top + 1}–${bottom}/${total}`);
	}

	/**
	 * The rows of the task in progress come into view, after the layout measured the rows this render holds (a scroll
	 * before would stop at the end of the rows held before).
	 */
	#keepTaskInView(): void {
		const { current } = this.#rendered.status;
		const scroll = this.#scrolls.status;
		const height = scroll.viewportHeight;
		if (!this.#following || current === undefined || height <= 0) return;
		const top = scroll.scrollTop;
		if (current.start < top) scroll.scrollTo(current.start);
		else if (current.end >= top + height) scroll.scrollTo(Math.min(current.start, current.end - height + 1));
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
