import type { AtelierEvent } from "@atelier/core";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";
import { AgentGroup, type CardView } from "./tool-card.ts";

/** A transcript block's lines one column in, as the transcript's text, each wrapped to the width. */
export function blockLines(lines: string[], width: number): string[] {
	if (width < 2) return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
	return lines.flatMap((line) => wrapTextWithAnsi(line, width - 1).map((piece) => ` ${piece}`));
}

/** The roles a review or a verification ran, one line each by agent, in the order they first spoke. */
export class RoleGroups {
	readonly #groups = new Map<string, AgentGroup>();
	readonly #view: CardView;
	readonly #paint: Paint;

	constructor(view: CardView, paint: Paint) {
		this.#view = view;
		this.#paint = paint;
	}

	add(event: AtelierEvent): void {
		const agent = event.agent ?? "";
		let group = this.#groups.get(agent);
		if (group === undefined) {
			group = new AgentGroup(this.#view, this.#paint);
			this.#groups.set(agent, group);
		}
		group.add(event);
	}

	render(width: number): string[] {
		return [...this.#groups.values()].flatMap((group) => group.render(width));
	}
}
