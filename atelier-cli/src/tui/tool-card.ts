import { type AtelierEvent, type JsonValue, visibleText } from "@atelier/core";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";

/** Whether tool cards show their details, and whether the model's thinking shows; one switch each for the conversation. */
export interface CardView {
	expanded: boolean;
	/** Whether all of the model's thinking is open, as Ctrl+R leaves it; absent counts as folded. */
	thinking?: boolean;
	/** Whether the thinking shows while it arrives, before it folds; absent counts as shown. */
	liveThinking?: boolean;
	/** Counts the switches: what a click opened or folded holds until the next one. */
	epoch?: number;
}

/** Lines of a call's input or a subagent's text shown in a card before it says how many more there are. */
const MAX_DETAIL_LINES = 12;

const shown = (text: string) => visibleText(text).text;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const field = (input: JsonValue, name: string): string | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const value = input[name];
	return typeof value === "string" ? value : undefined;
};

/** A tool summary such as `src/a.ts (12 lines)` as `src/a.ts · 12 lines`. */
export function summaryText(summary: string): string {
	const parts = /^(.*) \(([^()]*)\)$/s.exec(summary);
	return shown(parts ? `${parts[1]} · ${parts[2]}` : summary);
}

/** What a call works on, from its input, while it has no summary yet. */
function target(input: JsonValue): string {
	const value =
		field(input, "path") ?? field(input, "command") ?? field(input, "pattern") ?? field(input, "agent") ?? "";
	return shown(value.split("\n")[0] ?? "");
}

/** At most `max` lines of `text`, then how many were left out. */
function capped(text: string, max: number): string[] {
	const lines = text.split("\n");
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `… ${plural(lines.length - max, "more line")}`];
}

/** The call's input as the expanded card shows it: the whole command, the edits, the subagent's prompt. */
function inputLines(tool: string, input: JsonValue, paint: Paint): string[] {
	const text = (name: string) => field(input, name);
	switch (tool) {
		case "bash":
			return capped(`$ ${shown(text("command") ?? "")}`, MAX_DETAIL_LINES);
		case "edit": {
			const edits = typeof input === "object" && input !== null && !Array.isArray(input) ? input.edits : undefined;
			if (!Array.isArray(edits)) return [];
			return edits.flatMap((edit) => [
				...capped(shown(field(edit, "oldText") ?? ""), MAX_DETAIL_LINES).map((line) => paint("red", `- ${line}`)),
				...capped(shown(field(edit, "newText") ?? ""), MAX_DETAIL_LINES).map((line) => paint("green", `+ ${line}`)),
			]);
		}
		case "write":
			return capped(shown(text("content") ?? ""), MAX_DETAIL_LINES).map((line) => paint("green", `+ ${line}`));
		case "grep":
			return [
				`pattern ${shown(text("pattern") ?? "")}`,
				...(text("path") === undefined ? [] : [`in ${shown(text("path") ?? "")}`]),
				...(text("glob") === undefined ? [] : [`glob ${shown(text("glob") ?? "")}`]),
			];
		case "read":
			return [];
		case "task":
			return capped(shown(text("prompt") ?? ""), MAX_DETAIL_LINES);
		default:
			return capped(shown(JSON.stringify(input, null, 1)), MAX_DETAIL_LINES);
	}
}

/** What a subagent, the verifier or a review role did, grouped under the call or the step that started it. */
export class AgentActivity {
	agent: string | undefined;
	#model: string | undefined;
	readonly #tools = new Map<string, { tool: string; target: string; summary?: string; ok?: boolean }>();
	#text = "";

	constructor(agent?: string) {
		this.agent = agent;
	}

	add(event: AtelierEvent): void {
		if (event.agent !== undefined) this.agent = event.agent;
		switch (event.type) {
			case "session_started":
				this.#model = event.model;
				return;
			case "text_delta":
				this.#text += event.text;
				return;
			case "tool_call_started":
				this.#tools.set(event.callId, { tool: event.tool, target: target(event.input) });
				return;
			case "tool_call_finished": {
				const call = this.#tools.get(event.callId);
				if (call) Object.assign(call, { summary: event.summary, ok: event.ok });
				return;
			}
		}
	}

	/** `edit src/a.ts`, the call it runs now, or nothing between calls. */
	current(): string | undefined {
		const running = [...this.#tools.values()].filter(({ ok }) => ok === undefined).at(-1);
		return running === undefined ? undefined : `${shown(running.tool)} ${running.target}`.trimEnd();
	}

	/** `✗ worker · edit a.ts · 1 edit`, each of its calls that failed. */
	failures(): string[] {
		return [...this.#tools.values()]
			.filter(({ ok }) => ok === false)
			.map(
				({ tool, summary }) => `✗ ${shown(this.agent ?? "subagent")} · ${shown(tool)} ${summaryText(summary ?? "")}`,
			);
	}

	/** `worker · claude-sonnet-5-5 · 3 tools`; its cost is left to the footer and `/status`. */
	summary(): string {
		const parts = [shown(this.agent ?? "subagent")];
		if (this.#model !== undefined) parts.push(shown(this.#model));
		parts.push(plural(this.#tools.size, "tool"));
		return parts.join(" · ");
	}

	/** Each of its tool calls, then the start of what it wrote last. */
	details(paint: Paint): string[] {
		const lines = [...this.#tools.values()].map(({ tool, summary, ok }) => {
			const mark = ok === undefined ? paint("dim", "…") : ok ? paint("green", "✓") : paint("red", "✗");
			return `${paint("cyan", "▸")} ${shown(tool)} ${summary === undefined ? "" : summaryText(summary)} ${mark}`;
		});
		const text = this.#text.trim();
		if (text !== "") lines.push(...capped(shown(text), MAX_DETAIL_LINES).map((line) => paint("dim", line)));
		return lines;
	}
}

/** Lines under a header, indented and wrapped to the width. */
function indented(lines: readonly string[], width: number, indent: string): string[] {
	const room = Math.max(1, width - indent.length);
	return lines.flatMap((line) => wrapTextWithAnsi(line, room).map((part) => `${indent}${part}`));
}

/**
 * One tool call as a folded card: `▸ bash pnpm test · exit 0 ✓`, with a line for the subagent a `task` call ran.
 * Expanded, it adds the call's input, what the sandbox blocked, where the full output is, and the subagent's calls.
 */
export class ToolCard implements Component {
	readonly tool: string;
	readonly callId: string;
	readonly #input: JsonValue;
	readonly #view: CardView;
	readonly #paint: Paint;
	#finished: Extract<AtelierEvent, { type: "tool_call_finished" }> | undefined;
	#activity: AgentActivity | undefined;

	constructor(tool: string, input: JsonValue, view: CardView, paint: Paint, callId = "") {
		this.tool = tool;
		this.callId = callId;
		this.#input = input;
		this.#view = view;
		this.#paint = paint;
	}

	/** The file the call works on, when it names one. */
	get path(): string | undefined {
		return field(this.#input, "path");
	}

	get running(): boolean {
		return this.#finished === undefined;
	}

	/** Whether the call failed, or a call of the subagent it ran did. */
	get failed(): boolean {
		return this.#finished?.ok === false || (this.#activity?.failures().length ?? 0) > 0;
	}

	/** `bash pnpm test`, or `task worker · edit src/a.ts` with the call its subagent runs now. */
	current(): string {
		const label = `${shown(this.tool)} ${target(this.#input)}`.trimEnd();
		const child = this.#activity?.current();
		return child === undefined ? label : `${label} · ${child}`;
	}

	/** What must show even folded: `✗ bash pnpm test · exit 1`, its subagent's failures and what the sandbox blocked. */
	alerts(): string[] {
		const paint = this.#paint;
		const done = this.#finished;
		const lines: string[] = [];
		if (done?.ok === false)
			lines.push(`${paint("red", "✗")} ${paint("bold", shown(this.tool))} ${summaryText(done.summary)}`);
		for (const failure of this.#activity?.failures() ?? []) lines.push(paint("red", failure));
		for (const cause of done?.blocked ?? []) lines.push(paint("yellow", `sandbox blocked: ${shown(cause)}`));
		return lines;
	}

	finish(event: Extract<AtelierEvent, { type: "tool_call_finished" }>): void {
		this.#finished = event;
	}

	/** An event of the subagent this call started. */
	child(event: AtelierEvent): void {
		this.#activity ??= new AgentActivity(field(this.#input, "agent"));
		this.#activity.add(event);
	}

	invalidate(): void {}

	/** `open` is the view's switch unless the block it is in was opened or folded on its own. */
	render(width: number, open = this.#view.expanded): string[] {
		const paint = this.#paint;
		const done = this.#finished;
		const arrow = paint("cyan", open ? "▾" : "▸");
		const what = done === undefined ? target(this.#input) : summaryText(done.summary);
		const mark = done === undefined ? paint("dim", "…") : done.ok ? paint("green", "✓") : paint("red", "✗");
		const lines = [truncateToWidth(` ${arrow} ${paint("bold", shown(this.tool))} ${what} ${mark}`, width)];
		if (this.#activity) lines.push(truncateToWidth(paint("dim", `   └ ${this.#activity.summary()}`), width));
		for (const cause of done?.blocked ?? [])
			lines.push(...indented([paint("yellow", `sandbox blocked: ${shown(cause)}`)], width, "   "));
		if (!open) return lines;
		const details = inputLines(this.tool, this.#input, paint);
		if (done?.truncated)
			details.push(
				paint("dim", done.fullOutputPath ? `full output: ${shown(done.fullOutputPath)}` : "output truncated"),
			);
		lines.push(...indented(details, width, "   │ "));
		if (this.#activity) lines.push(...indented(this.#activity.details(paint), width, "     "));
		return lines;
	}
}

/** The verifier's or a review role's work, grouped under one line like a subagent's under its call. */
export class AgentGroup implements Component {
	readonly #activity: AgentActivity;
	readonly #view: CardView;
	readonly #paint: Paint;

	constructor(view: CardView, paint: Paint) {
		this.#activity = new AgentActivity();
		this.#view = view;
		this.#paint = paint;
	}

	add(event: AtelierEvent): void {
		this.#activity.add(event);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [truncateToWidth(this.#paint("dim", `   └ ${this.#activity.summary()}`), width)];
		if (this.#view.expanded) lines.push(...indented(this.#activity.details(this.#paint), width, "     "));
		return lines;
	}
}
