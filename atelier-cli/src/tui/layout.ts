import {
	type Component,
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
 * Puts the document (the header and the transcript) on screen with the parts fixed under it. Full screen, the document
 * scrolls in the space the fixed parts leave, following its end while the view is at it; on the main screen they go one
 * after the other.
 */
export function mount(tui: TUI, document: Component, fixed: { component: Component; editor?: boolean }[]): void {
	if (!isViewportTUI(tui)) {
		tui.addChild(document);
		for (const { component } of fixed) tui.addChild(component);
		return;
	}
	const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	const bottom = new VStack(
		fixed.map(({ component, editor }) => ({ component, shrink: 1, minSize: editor ? EDITOR_MIN_ROWS : 0 })),
	);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: bottom, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
}

/** Full screen, leaves only the document to print in the main screen once the TUI stops. */
export function keepDocument(tui: TUI, document: Component): void {
	if (isViewportTUI(tui)) tui.setLayoutRoot(document);
}
