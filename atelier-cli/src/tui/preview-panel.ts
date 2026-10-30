import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";

/** The columns a panel's sides take around its content: `│ ` and ` │`. */
export const PANEL_FRAME = 4;

/** A preview's lines as written: tabs as two spaces, and a final newline ending the last line rather than starting one. */
export function previewLines(preview: string): string[] {
	return preview.replace(/\n$/, "").replaceAll("\t", "  ").split("\n");
}

/** A preview's rows in `width` columns: each of its lines, wrapped. */
export function previewRows(preview: string, width: number): string[] {
	return previewLines(preview).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

/**
 * `rows` in a box `width` columns wide, `height` rows between its borders: blank rows fill it when they are fewer, and
 * when they are more the last row says, dimmed, how many more there are. The border is dimmed, with `title` in the top
 * one.
 */
export function previewPanel(
	panel: { title?: string; rows: readonly string[]; width: number; height: number },
	paint: Paint,
): string[] {
	const content = Math.max(1, panel.width - PANEL_FRAME);
	const height = Math.max(1, panel.height);
	const cut = panel.rows.length > height;
	const kept = cut ? panel.rows.slice(0, height - 1) : panel.rows;
	const more = cut ? [paint("dim", `… ${panel.rows.length - kept.length} more lines`)] : [];
	const shown = [...kept, ...more];
	const filled = [...shown, ...Array.from({ length: height - shown.length }, () => "")];
	const side = paint("dim", "│");
	const line = (text: string) => {
		const fitted = truncateToWidth(text, content, "…");
		return `${side} ${fitted}${" ".repeat(Math.max(0, content - visibleWidth(fitted)))} ${side}`;
	};
	const title = panel.title === undefined ? undefined : truncateToWidth(panel.title, content, "…");
	const top =
		title === undefined
			? paint("dim", `┌${"─".repeat(content + 2)}┐`)
			: `${paint("dim", "┌")} ${title} ${paint("dim", `${"─".repeat(content - visibleWidth(title))}┐`)}`;
	return [top, ...filled.map(line), paint("dim", `└${"─".repeat(content + 2)}┘`)];
}
