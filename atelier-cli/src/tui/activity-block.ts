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

const isThought = (step: ToolCard | Thought): step is Thought => !("tool" in step);

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

/** A stretch of the model's thinking, as its deltas arrive. */
interface Thought {
	text: string;
}

const FOLDED_THOUGHT = "✻ Thinking…";

/**
 * The calls the agent made between two of its texts, and its thinking among them, as one block: folded, the thinking
 * and a line that sums the calls up, `⎿ Ran 3 commands · read 1 file`, with every failure and what the sandbox blocked
 * under it; open, the thinking and each call's card in order.
 */
export class ActivityBlock implements Component {
	readonly #steps: (ToolCard | Thought)[] = [];
	readonly #view: CardView;
	readonly #paint: Paint;

	constructor(view: CardView, paint: Paint) {
		this.#view = view;
		this.#paint = paint;
	}

	get #cards(): ToolCard[] {
		return this.#steps.filter((step): step is ToolCard => !isThought(step));
	}

	add(card: ToolCard): void {
		this.#steps.push(card);
	}

	/** More of the model's thinking: the stretch it is in, or a new one after a call. */
	think(text: string): void {
		const last = this.#steps.at(-1);
		if (last !== undefined && isThought(last)) last.text += text;
		else this.#steps.push({ text });
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = this.#paint;
		const counted = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool));
		const shown = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool) || card.failed);
		const thoughts = this.#steps.filter(isThought);
		const lines: string[] = [];
		if (this.#view.expanded) {
			if (counted.length > 0) lines.push(truncateToWidth(paint("dim", ` ⎿ ▾ ${activitySummary(counted)}`), width));
			for (const step of this.#steps) {
				if (isThought(step)) lines.push(...this.#thought(step, width));
				else if (shown.includes(step)) lines.push(...step.render(Math.max(1, width - 2)).map((line) => `  ${line}`));
			}
			return lines;
		}
		if (this.#view.thinking === false) {
			if (thoughts.length > 0) lines.push(...this.#thought(undefined, width));
		} else lines.push(...thoughts.flatMap((thought) => this.#thought(thought, width)));
		if (shown.length === 0) return lines;
		const running = counted.filter((card) => card.running).at(-1);
		if (running !== undefined) lines.push(truncateToWidth(this.#runningLine(running), width));
		else if (counted.length > 0) lines.push(truncateToWidth(paint("dim", ` ⎿ ${activitySummary(counted)}`), width));
		const room = Math.max(1, width - 3);
		for (const alert of shown.flatMap((card) => card.alerts()))
			lines.push(...wrapTextWithAnsi(alert, room).map((part) => `   ${part}`));
		return lines;
	}

	/** `✻ Checking the alias.`, dimmed, italic and magenta; `✻ Thinking…` while thinking is folded or for `undefined`. */
	#thought(thought: Thought | undefined, width: number): string[] {
		const text = thought === undefined || this.#view.thinking === false ? FOLDED_THOUGHT : `✻ ${thought.text.trim()}`;
		const room = Math.max(1, width - 3);
		return text
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, room))
			.map((line, index) => `${index === 0 ? " " : "   "}${this.#paint(["dim", "italic", "magenta"], line)}`);
	}

	/** `⎿ ◐ bash pnpm test… (ran 2 commands)`: the call running now in the summary's place, and what is done so far. */
	#runningLine(running: ToolCard): string {
		const paint = this.#paint;
		const done = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool) && !card.running);
		const so = done.length === 0 ? "" : paint("dim", `  (${activitySummary(done).toLowerCase()})`);
		return `${paint("dim", " ⎿")} ${paint("cyan", "◐")} ${running.current()}…${so}`;
	}
}
