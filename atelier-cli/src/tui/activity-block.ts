import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";
import type { CardView, ToolCard } from "./tool-card.ts";

/** Tools whose work the footer and the ODD panel already show: their cards stay out of sight unless they fail. */
const HIDDEN_TOOLS = new Set(["feature"]);
/** Tools whose outcome the conversation shows in a block of its own: never in the summary, and folded they show nothing. */
const OWN_BLOCK_TOOLS = new Set(["ask_user"]);

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

/** A stretch of the model's thinking, as its deltas arrive, whether the model moved on from it, and what a click made of it. */
interface Thought {
	text: string;
	ended?: boolean;
	clicked?: Clicked;
}

/** Shown or open by a click, which holds while the view's switches are as they were (the same `epoch`). */
interface Clicked {
	epoch: number;
	value: boolean;
}

const FOLDED_THOUGHT = "✻ Thinking…";

/** A rendered line and what a click on it opens or folds: the block or one stretch of thinking. */
type Row = { line: string; target: "block" | Thought[] };

/**
 * The calls the agent made between two of its texts, and its thinking among them, as one block: folded, the thinking
 * and a line that sums the calls up, `⎿ Ran 3 commands · read 1 file`, with each memory call's two lines, every failure
 * and what the sandbox blocked under it; open, the thinking and each call's card in order. A memory call is never in
 * the summary, since its own lines always show. A click opens or folds the block, or the thinking under it.
 */
export class ActivityBlock implements Component {
	readonly #steps: (ToolCard | Thought)[] = [];
	readonly #view: CardView;
	readonly #paint: Paint;
	#clicked: Clicked | undefined;

	constructor(view: CardView, paint: Paint) {
		this.#view = view;
		this.#paint = paint;
	}

	get #cards(): ToolCard[] {
		return this.#steps.filter((step): step is ToolCard => !isThought(step));
	}

	get #epoch(): number {
		return this.#view.epoch ?? 0;
	}

	get #expanded(): boolean {
		return this.#clicked?.epoch === this.#epoch ? this.#clicked.value : this.#view.expanded;
	}

	/** Thinking shows while it arrives and folds once it ends, unless a click or Ctrl+R said otherwise. */
	#shows(thought: Thought): boolean {
		if (thought.clicked?.epoch === this.#epoch) return thought.clicked.value;
		return this.#view.thinking === true || (thought.ended !== true && this.#view.liveThinking !== false);
	}

	add(card: ToolCard): void {
		this.end();
		this.#steps.push(card);
	}

	/** The model moved on from its thinking: to a call, its text or the turn's end. */
	end(): void {
		for (const step of this.#steps) if (isThought(step)) step.ended = true;
	}

	/** More of the model's thinking: the stretch it is in, or a new one after a call. */
	think(text: string): void {
		const last = this.#steps.at(-1);
		if (last !== undefined && isThought(last)) last.text += text;
		else this.#steps.push({ text });
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#rows(width).map(({ line }) => line);
	}

	/** A left click opens or folds what its row belongs to; a press is left to the text selection. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const target = this.#rows(event.width)[event.y]?.target;
		if (target === undefined) return undefined;
		const epoch = this.#epoch;
		if (target === "block") this.#clicked = { epoch, value: !this.#expanded };
		else {
			const value = !target.some((thought) => this.#shows(thought));
			for (const thought of target) thought.clicked = { epoch, value };
		}
		return { handled: true };
	}

	#rows(width: number): Row[] {
		const paint = this.#paint;
		const counted = this.#cards.filter(
			(card) => !HIDDEN_TOOLS.has(card.tool) && !OWN_BLOCK_TOOLS.has(card.tool) && !card.pinned,
		);
		const shown = this.#cards.filter((card) => !HIDDEN_TOOLS.has(card.tool) || card.failed);
		const thoughts = this.#steps.filter(isThought);
		const block = (line: string): Row => ({ line, target: "block" });
		const rows: Row[] = [];
		if (this.#expanded) {
			if (counted.length > 0)
				rows.push(block(truncateToWidth(paint("dim", ` ⎿ ▾ ${activitySummary(counted)}`), width)));
			for (const step of this.#steps) {
				if (isThought(step)) rows.push(...this.#thought([step], width));
				else if (shown.includes(step))
					rows.push(...step.render(Math.max(1, width - 2), true).map((line) => block(`  ${line}`)));
			}
			return rows;
		}
		// Folded, thinking that is all folded takes one line.
		if (thoughts.length > 0 && !thoughts.some((thought) => this.#shows(thought)))
			rows.push(...this.#thought(thoughts, width));
		else rows.push(...thoughts.flatMap((thought) => this.#thought([thought], width)));
		if (shown.length === 0) return rows;
		const running = counted.filter((card) => card.running).at(-1);
		if (running !== undefined) rows.push(block(truncateToWidth(this.#runningLine(running), width)));
		else if (counted.length > 0)
			rows.push(block(truncateToWidth(paint("dim", ` ⎿ ${activitySummary(counted)}`), width)));
		for (const card of shown.filter((card) => card.pinned))
			rows.push(...card.render(Math.max(1, width - 2), false).map((line) => block(`  ${line}`)));
		const room = Math.max(1, width - 3);
		const alerting = shown.filter((card) => !card.pinned && !OWN_BLOCK_TOOLS.has(card.tool));
		for (const alert of alerting.flatMap((card) => card.alerts()))
			rows.push(...wrapTextWithAnsi(alert, room).map((part) => block(`   ${part}`)));
		return rows;
	}

	/** `✻ Checking the alias.`, dimmed, italic and magenta; `✻ Thinking…` while it is folded, one line for all of `thoughts`. */
	#thought(thoughts: Thought[], width: number): Row[] {
		const [first] = thoughts;
		const text = first === undefined || !this.#shows(first) ? FOLDED_THOUGHT : `✻ ${first.text.trim()}`;
		const room = Math.max(1, width - 3);
		return text
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, room))
			.map((line, index) => ({
				line: `${index === 0 ? " " : "   "}${this.#paint(["dim", "italic", "magenta"], line)}`,
				target: thoughts,
			}));
	}

	/** `⎿ ◐ bash pnpm test… (ran 2 commands)`: the call running now in the summary's place, and what is done so far. */
	#runningLine(running: ToolCard): string {
		const paint = this.#paint;
		const done = this.#cards.filter(
			(card) => !HIDDEN_TOOLS.has(card.tool) && !OWN_BLOCK_TOOLS.has(card.tool) && !card.pinned && !card.running,
		);
		const so = done.length === 0 ? "" : paint("dim", `  (${activitySummary(done).toLowerCase()})`);
		return `${paint("dim", " ⎿")} ${paint("cyan", "◐")} ${running.current()}…${so}`;
	}
}
