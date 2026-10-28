import { type AtelierEvent, type JsonValue, visibleText } from "@atelier/core";
import { type Component, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { editView, writeView } from "./code-view.ts";
import { highlightCode } from "./highlight.ts";
import { hasColor, type Paint, type Style, Tones } from "./style.ts";

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
const isRecord = (input: JsonValue | undefined): input is { [key: string]: JsonValue } =>
	typeof input === "object" && input !== null && !Array.isArray(input);
const field = (input: JsonValue, name: string): string | undefined => {
	if (!isRecord(input)) return undefined;
	const value = input[name];
	return typeof value === "string" ? value : undefined;
};

/** A tool summary such as `src/a.ts (12 lines)` as what it is about and its detail, `src/a.ts` and `12 lines`. */
function summaryParts(summary: string): { subject: string; detail?: string } {
	const parts = /^(.*) \(([^()]*)\)$/s.exec(summary);
	return parts ? { subject: shown(parts[1] ?? ""), detail: shown(parts[2] ?? "") } : { subject: shown(summary) };
}

/** A tool summary such as `src/a.ts (12 lines)` as `src/a.ts · 12 lines`. */
export function summaryText(summary: string): string {
	const { subject, detail } = summaryParts(summary);
	return detail === undefined ? subject : `${subject} · ${detail}`;
}

/** What a call works on, from its input, while it has no summary yet: what it names, or its first text. */
function target(input: JsonValue): string {
	const first = isRecord(input) ? Object.values(input).find((value) => typeof value === "string") : undefined;
	const value =
		field(input, "path") ??
		field(input, "command") ??
		field(input, "pattern") ??
		field(input, "agent") ??
		(typeof first === "string" ? first : "");
	return shown(value.split("\n")[0] ?? "");
}

/** Plain `text` cut to `width` columns with `…`, adding no escape: a terminal without color gets none. */
function cut(text: string, width: number): string {
	return visibleWidth(text) <= width ? text : `${sliceByColumn(text, 0, Math.max(0, width - 1), true)}…`;
}

/** At most `max` of `lines`, then how many were left out. */
function cappedLines(lines: string[], max: number): string[] {
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `… ${plural(lines.length - max, "more line")}`];
}

/** At most `max` lines of `text`, then how many were left out. */
const capped = (text: string, max: number) => cappedLines(text.split("\n"), max);

/** `$ pnpm test`, the command highlighted as bash, its other lines under the first one's text. */
function commandLines(command: string, paint: Paint): string[] {
	const [first = "", ...rest] = highlightCode(paint, command, "bash");
	return cappedLines([`${paint("dim", "$")} ${first}`, ...rest.map((line) => `  ${line}`)], MAX_DETAIL_LINES);
}

/** `pattern mode  in src  glob *.ts`, what a search looks for and where. */
function searchLine(input: JsonValue, paint: Paint): string {
	const part = (name: string, label: string, style?: Style) => {
		const value = field(input, name);
		if (value === undefined) return [];
		return [`${paint("dim", label)} ${style === undefined ? shown(value) : paint(style, shown(value))}`];
	};
	return [...part("pattern", "pattern", "yellow"), ...part("path", "in"), ...part("glob", "glob")].join("  ");
}

/** Each key of the input, dimmed and lined up, and its value: text as it is, the rest as JSON, numbers in yellow. */
function fieldLines(input: JsonValue, paint: Paint): string[] {
	if (!isRecord(input)) return capped(shown(JSON.stringify(input)), MAX_DETAIL_LINES);
	const keys = Object.keys(input).map(shown);
	const pad = Math.max(0, ...keys.map((key) => visibleWidth(key)));
	const lines = Object.entries(input).flatMap(([key, value]) => {
		const name = paint("dim", shown(key).padEnd(pad));
		if (typeof value === "string") {
			const [first = "", ...rest] = shown(value).split("\n");
			return [`${name} ${first}`, ...rest.map((line) => `${" ".repeat(pad + 1)}${line}`)];
		}
		const text = shown(JSON.stringify(value));
		return [`${name} ${typeof value === "object" && value !== null ? text : paint("yellow", text)}`];
	});
	return cappedLines(lines, MAX_DETAIL_LINES);
}

/**
 * The call's input as the expanded card shows it, in `room` columns: the whole command, the edits as a diff, the
 * start of a written file, the subagent's prompt. `startLines` numbers the diff, and `tones` bands it.
 */
function inputLines(
	tool: string,
	input: JsonValue,
	paint: Paint,
	room: number,
	startLines: readonly number[] | undefined,
	tones: Tones,
): string[] {
	const text = (name: string) => field(input, name);
	switch (tool) {
		case "bash":
			return commandLines(shown(text("command") ?? ""), paint);
		case "edit": {
			const edits = isRecord(input) ? input.edits : undefined;
			if (!Array.isArray(edits)) return [];
			const texts = edits.map((edit) => ({
				oldText: shown(field(edit, "oldText") ?? ""),
				newText: shown(field(edit, "newText") ?? ""),
			}));
			return editView(shown(text("path") ?? ""), texts, startLines, paint, room, 2 * MAX_DETAIL_LINES, tones);
		}
		case "write":
			return writeView(shown(text("path") ?? ""), shown(text("content") ?? ""), paint, room, MAX_DETAIL_LINES);
		case "grep":
			return [searchLine(input, paint)];
		case "read":
			return [];
		case "task":
			return capped(shown(text("prompt") ?? ""), MAX_DETAIL_LINES);
		default:
			return fieldLines(input, paint);
	}
}

/** `◐` while a call runs, `✓` once it worked, `✗` when it failed, and the color of each. */
const STATES = {
	running: { mark: "◐", style: "cyan" },
	ok: { mark: "✓", style: "green" },
	failed: { mark: "✗", style: "red" },
} as const satisfies Record<string, { mark: string; style: Style }>;

const stateOf = (ok: boolean | undefined) => STATES[ok === undefined ? "running" : ok ? "ok" : "failed"];

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
			const state = stateOf(ok);
			return `${paint(state.style, state.mark)} ${shown(tool)} ${summary === undefined ? "" : summaryText(summary)}`;
		});
		const text = this.#text.trim();
		if (text !== "") lines.push(...capped(shown(text), MAX_DETAIL_LINES).map((line) => paint("dim", line)));
		return lines;
	}
}

/** Lines under a header, indented and wrapped to the width. */
function indented(lines: readonly string[], width: number, indent: string): string[] {
	const room = Math.max(1, width - visibleWidth(indent));
	return lines.flatMap((line) => wrapTextWithAnsi(line, room).map((part) => `${indent}${part}`));
}

/**
 * One tool call as a card: `✓ bash pnpm test · exit 0 · 4.2s`, its state first and how long it took when that is a
 * second or more, with a line for the subagent a `task` call ran. Open, it adds the call's input under a bar of its
 * state's color, what the sandbox blocked, where the full output is, and the subagent's calls.
 */
export class ToolCard implements Component {
	readonly tool: string;
	readonly callId: string;
	readonly #input: JsonValue;
	readonly #view: CardView;
	readonly #paint: Paint;
	readonly #now: () => Date;
	readonly #tones: Tones;
	readonly #startedAt: number;
	#finished: Extract<AtelierEvent, { type: "tool_call_finished" }> | undefined;
	#tookMs: number | undefined;
	#activity: AgentActivity | undefined;

	/** `now` times the call, from the card's start to its finish; `tones` are the card's backgrounds. */
	constructor(
		tool: string,
		input: JsonValue,
		view: CardView,
		paint: Paint,
		callId = "",
		now = () => new Date(),
		tones = new Tones(false),
	) {
		this.tool = tool;
		this.callId = callId;
		this.#input = input;
		this.#view = view;
		this.#paint = paint;
		this.#now = now;
		this.#tones = tones;
		this.#startedAt = now().getTime();
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
			lines.push(`${paint("red", "✗")} ${paint("bold", shown(this.tool))} ${paint("red", summaryText(done.summary))}`);
		for (const failure of this.#activity?.failures() ?? []) lines.push(paint("red", failure));
		for (const cause of done?.blocked ?? []) lines.push(paint("yellow", `sandbox blocked: ${shown(cause)}`));
		return lines;
	}

	finish(event: Extract<AtelierEvent, { type: "tool_call_finished" }>): void {
		this.#finished = event;
		this.#tookMs = this.#now().getTime() - this.#startedAt;
	}

	/** An event of the subagent this call started. */
	child(event: AtelierEvent): void {
		this.#activity ??= new AgentActivity(field(this.#input, "agent"));
		this.#activity.add(event);
	}

	invalidate(): void {}

	/** `open` is the view's switch unless the block it is in was opened or folded on its own. */
	/** `✓ bash pnpm test · exit 0 · 4.2s`: what the call works on is cut to the width, never its state or details. */
	#header(width: number): string {
		const paint = this.#paint;
		const done = this.#finished;
		const state = stateOf(done?.ok);
		const { subject, detail } = done === undefined ? { subject: target(this.#input) } : summaryParts(done.summary);
		const took =
			this.#tookMs !== undefined && this.#tookMs >= 1000 ? `${(this.#tookMs / 1000).toFixed(1)}s` : undefined;
		const details = [detail, took].filter((part) => part !== undefined).map((part) => `· ${part}`);
		const lead = ` ${paint(state.style, state.mark)} ${paint("bold", shown(this.tool))} `;
		const tail = details.length === 0 ? "" : ` ${paint(done?.ok === false ? "red" : "dim", details.join(" "))}`;
		const room = Math.max(1, width - visibleWidth(lead) - visibleWidth(tail));
		return truncateToWidth(`${lead}${cut(subject, room)}${tail}`, width);
	}

	/** Every line on the card's background to the last column, when there is one. */
	render(width: number, open = this.#view.expanded): string[] {
		const lines = this.#lines(width, open);
		if (!this.#tones.on) return lines;
		return lines.map((line) => this.#tones.card(`${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`));
	}

	#lines(width: number, open: boolean): string[] {
		const paint = this.#paint;
		const done = this.#finished;
		const lines = [this.#header(width)];
		if (this.#activity) lines.push(truncateToWidth(paint("dim", `   └ ${this.#activity.summary()}`), width));
		for (const cause of done?.blocked ?? [])
			lines.push(...indented([paint("yellow", `sandbox blocked: ${shown(cause)}`)], width, "   "));
		if (!open) return lines;
		const bar = paint(stateOf(done?.ok).style, hasColor(paint) ? "▎" : "│");
		const details = inputLines(this.tool, this.#input, paint, Math.max(1, width - 3), done?.startLines, this.#tones);
		if (done?.truncated)
			details.push(
				paint("dim", done.fullOutputPath ? `full output: ${shown(done.fullOutputPath)}` : "output truncated"),
			);
		lines.push(...indented(details, width, ` ${bar} `));
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
