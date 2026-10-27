import { type QueuedMessage, visibleText } from "@atelier/core";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";

/** The most queued messages shown; the rest are counted. */
const SHOWN = 5;

/** The messages queued while a turn runs, over the editor: one dimmed line each, cut to the width. */
export class QueuePanel implements Component {
	readonly #paint: Paint;
	messages: readonly QueuedMessage[] = [];

	constructor(paint: Paint) {
		this.#paint = paint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.messages.length === 0) return [];
		const lines = this.messages.slice(0, SHOWN).map((message) => {
			const kind = message.kind === "steer" ? "steer" : "follow-up";
			// One line: the message's own lines run together.
			const text = visibleText(message.text.replace(/\s+/g, " ").trim()).text;
			return `↳ ${kind}: ${text}`;
		});
		const more = this.messages.length - SHOWN;
		if (more > 0) lines.push(`… ${more} more`);
		lines.push("Alt+↑ edit");
		return lines.map((line) => this.#paint("dim", truncateToWidth(` ${line}`, width)));
	}
}
