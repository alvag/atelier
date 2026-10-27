import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";
import type { CardView, ToolCard } from "./tool-card.ts";

/** Tools whose work the footer and the ODD panel already show: their cards stay out of sight unless they fail. */
const HIDDEN_TOOLS = new Set(["feature"]);

/** How the summary counts each tool, in the order it says them; any other tool is one of `other`. */
const KINDS = [
	{ kind: "command", tools: ["bash"], say: (n: number) => `ran ${plural(n, "command")}` },
	{ kind: "read", tools: ["read"], say: (n: number) => `read ${plural(n, "file")}` },
	{ kind: "edit", tools: ["edit", "write"], say: (n: number) => `edited ${plural(n, "file")}` },
	{ kind: "search", tools: ["grep", "web_search"], say: (n: number) => `searched ${plural(n, "time")}` },
	{ kind: "fetch", tools: ["web_fetch"], say: (n: number) => `fetched ${plural(n, "page")}` },
	{ kind: "subagent", tools: ["task"], say: (n: number) => `ran ${plural(n, "subagent")}` },
] as const;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Files count once however many times they are read or edited; the rest counts each call. */
const COUNTS_FILES = new Set(["read", "edit"]);

/** `Ran 3 commands · read 1 file · edited 1 file`, what `cards` did, with the first word capitalized. */
export function activitySummary(cards: readonly ToolCard[]): string {
	const seen = new Map<string, Set<string>>();
	for (const card of cards) {
		const kind = KINDS.find(({ tools }) => (tools as readonly string[]).includes(card.tool))?.kind ?? "other";
		const keys = seen.get(kind) ?? new Set<string>();
		keys.add(COUNTS_FILES.has(kind) ? (card.path ?? card.callId) : card.callId);
		seen.set(kind, keys);
	}
	const parts = KINDS.filter(({ kind }) => seen.has(kind)).map(({ kind, say }) => say(seen.get(kind)?.size ?? 0));
	const others = seen.get("other")?.size ?? 0;
	if (others > 0) parts.push(`used ${plural(others, "other tool")}`);
	const text = parts.join(" · ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The calls the agent made between two of its texts, as one block: folded, a line that sums them up,
 * `⎿ Ran 3 commands · read 1 file`, with every failure and what the sandbox blocked under it; open, each call's card.
 */
export class ActivityBlock implements Component {
	readonly #cards: ToolCard[] = [];
	readonly #view: CardView;
	readonly #paint: Paint;

	constructor(view: CardView, paint: Paint) {
		this.#view = view;
		this.#paint = paint;
	}

	add(card: ToolCard): void {
		this.#cards.push(card);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = this.#paint;
		const counted = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool));
		const shown = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool) || card.failed);
		if (shown.length === 0) return [];
		const lines: string[] = [];
		const running = counted.filter((card) => card.running).at(-1);
		if (running !== undefined && !this.#view.expanded) lines.push(truncateToWidth(this.#runningLine(running), width));
		else if (counted.length > 0) {
			const arrow = this.#view.expanded ? "▾ " : "";
			lines.push(truncateToWidth(paint("dim", ` ⎿ ${arrow}${activitySummary(counted)}`), width));
		}
		if (this.#view.expanded) {
			for (const card of shown) lines.push(...card.render(Math.max(1, width - 2)).map((line) => `  ${line}`));
			return lines;
		}
		const room = Math.max(1, width - 3);
		for (const alert of shown.flatMap((card) => card.alerts()))
			lines.push(...wrapTextWithAnsi(alert, room).map((part) => `   ${part}`));
		return lines;
	}

	/** `⎿ ◐ bash pnpm test… (ran 2 commands)`: the call running now in the summary's place, and what is done so far. */
	#runningLine(running: ToolCard): string {
		const paint = this.#paint;
		const done = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool) && !card.running);
		const so = done.length === 0 ? "" : paint("dim", `  (${activitySummary(done).toLowerCase()})`);
		return `${paint("dim", " ⎿")} ${paint("cyan", "◐")} ${running.current()}…${so}`;
	}
}
