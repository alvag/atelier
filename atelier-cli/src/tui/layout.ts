import {
	type Component,
	HStack,
	isViewportTUI,
	ScrollView,
	type Terminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";

/** The lines the editor keeps on a short terminal, as Pi's does. */
const EDITOR_MIN_ROWS = 3;

/**
 * The TUI on the terminal: full screen, the alternate screen with a viewport the TUI scrolls (mouse wheel, PageUp and
 * PageDown, text selected with the mouse copied to the clipboard); or the main screen, where the terminal scrolls.
 */
export function createScreen(terminal: Terminal, fullscreen: boolean, paint: Paint): TUI {
	if (!fullscreen) return new TuiMainScreen(terminal);
	return new TuiAltScreen(terminal, undefined, undefined, {
		wheelScrollLines: "auto",
		copyOnSelect: true,
		scrollToEndIndicator: () => paint("dim", " ↓ Jump to latest · Ctrl+End "),
	});
}

/**
 * Puts the document on screen with the parts fixed under it and an optional fullscreen header above it. Full screen, the document
 * scrolls in the space the fixed parts leave, following its end while the view is at it; on the main screen they go one
 * after the other. A part with `shown` takes no room while it says false. Full screen, `side` goes at the right of the
 * document and the fixed parts, `width` columns wide, while its `shown` says true for the terminal's width.
 */
export function mount(
	tui: TUI,
	document: Component,
	fixed: { component: Component; editor?: boolean; shown?: () => boolean }[],
	top?: Component,
	side?: { component: Component; width: number; shown: (columns: number) => boolean },
): void {
	if (!isViewportTUI(tui)) {
		tui.addChild(document);
		for (const { component } of fixed) tui.addChild(component);
		return;
	}
	const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	const bottom = new VStack(
		fixed.map(({ component, editor, shown }) => ({
			component,
			shrink: 1,
			minSize: editor ? EDITOR_MIN_ROWS : 0,
			...(shown === undefined ? {} : { visible: shown }),
		})),
	);
	const main = [
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: bottom, basis: "auto" as const, grow: 0, shrink: 1, minSize: 1 },
	];
	const below =
		side === undefined
			? main
			: [
					{
						component: new HStack([
							{ component: new VStack(main), basis: 0, grow: 1, shrink: 1, minSize: 1 },
							{
								component: side.component,
								basis: side.width,
								grow: 0,
								shrink: 0,
								visible: ({ width }: { width: number }) => side.shown(width),
							},
						]),
						basis: 0,
						grow: 1,
						shrink: 1,
						minSize: 1,
					},
				];
	tui.setLayoutRoot(
		new VStack([
			...(top === undefined ? [] : [{ component: top, basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 }]),
			...below,
		]),
	);
}

/** Full screen, leaves only the document to print in the main screen once the TUI stops. */
export function keepDocument(tui: TUI, document: Component): void {
	if (isViewportTUI(tui)) tui.setLayoutRoot(document);
}
