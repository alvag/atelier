import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PasteFilter } from "./dialog.ts";
import { type QuestionAnswer, QuestionDialog, type QuestionOption } from "./question-dialog.ts";
import type { Paint } from "./style.ts";

/** A question as the dialog shows it: text already made safe to show, its options in the order they are listed. */
export interface AskQuestion {
	header?: string;
	question: string;
	options: readonly QuestionOption[];
}

/** One question's answer: the option at that index, or the user's own text. */
export type AskAnswer = Exclude<QuestionAnswer, "cancel">;

/** `○ Language`, a tab's cell; the one you are on is highlighted. */
interface Tab {
	title: string;
	answered: boolean;
}

/** The fewest columns a cut title keeps. */
const MIN_TITLE = 6;

/** `title` cut to `width` columns with `…`, by whole characters. */
function cutTitle(title: string, width: number): string {
	if (visibleWidth(title) <= width) return title;
	let chars = Array.from(title);
	while (chars.length > 0 && visibleWidth(chars.join("")) > width - 1) chars = chars.slice(0, -1);
	return `${chars.join("")}…`;
}

/**
 * An `ask_user` batch between two rules of the accent color. A single question is asked alone and sent with its
 * answer. A batch shows a tab for each question (its header, or `Q1`, `Q2`…), the one you are on highlighted and the
 * answered ones marked `✔`; ← and → move among them keeping the answers given, and answering a question moves to the
 * next one not answered, until every question has an answer and the batch is sent. Esc cancels the whole batch.
 */
export class AskDialog implements Component, Focusable {
	focused = false;
	readonly #questions: readonly AskQuestion[];
	readonly #dialogs: QuestionDialog[];
	readonly #answers: (AskAnswer | undefined)[];
	readonly #paint: Paint;
	readonly #paste: PasteFilter;
	readonly #send: (answers: AskAnswer[] | null) => void;
	#tab = 0;
	#done = false;

	constructor(
		options: { questions: readonly AskQuestion[]; guardMs?: number; paste?: PasteFilter },
		paint: Paint,
		send: (answers: AskAnswer[] | null) => void,
	) {
		this.#questions = options.questions;
		this.#paint = paint;
		this.#paste = options.paste ?? new PasteFilter();
		this.#send = send;
		this.#answers = options.questions.map(() => undefined);
		const tabs = options.questions.length > 1;
		this.#dialogs = options.questions.map(
			(question, index) =>
				new QuestionDialog(
					{
						question: question.question,
						options: question.options,
						guardMs: options.guardMs ?? 0,
						paste: this.#paste,
						tabs,
					},
					paint,
					(answer) => this.#answered(index, answer),
				),
		);
	}

	get #dialog(): QuestionDialog | undefined {
		return this.#dialogs[this.#tab];
	}

	#finish(answers: AskAnswer[] | null): void {
		this.#done = true;
		this.#send(answers);
	}

	#answered(index: number, answer: QuestionAnswer): void {
		if (this.#done) return;
		if (answer === "cancel") {
			this.#finish(null);
			return;
		}
		this.#answers[index] = answer;
		this.#dialogs[index]?.reopen();
		const left = this.#answers.findIndex((given, at) => given === undefined && at !== index);
		if (left === -1) {
			this.#finish(this.#answers.filter((given) => given !== undefined));
			return;
		}
		// The next question not answered, after this one first.
		const after = this.#answers.findIndex((given, at) => given === undefined && at > index);
		this.#show(after === -1 ? left : after);
	}

	/** Puts tab `index` on screen, its guard started again. */
	#show(index: number): void {
		this.#tab = index;
		this.#dialog?.reveal(Date.now(), true);
	}

	/** Starts the guard of the question on screen. */
	reveal(now = Date.now()): void {
		this.#dialog?.reveal(now);
	}

	toggle(): boolean {
		return true;
	}

	handleInput(data: string): void {
		if (this.#done) return;
		const dialog = this.#dialog;
		// ← and → move among the tabs, unless they edit the text typed; never inside a paste.
		if (this.#dialogs.length > 1 && this.#paste.idle && !dialog?.editing) {
			const step = matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : 0;
			if (step !== 0) {
				const next = Math.min(this.#dialogs.length - 1, Math.max(0, this.#tab + step));
				if (next !== this.#tab) this.#show(next);
				return;
			}
		}
		dialog?.handleInput(data);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rule = this.#paint("cyan", "─".repeat(Math.max(1, width)));
		const body = this.#dialog?.body(width) ?? [];
		if (this.#dialogs.length === 1) return [rule, ...body, rule];
		return [rule, truncateToWidth(this.#tabBar(width), width), "", ...body, rule];
	}

	/** ` ←  ✔ Language   ○ Checks  →`, cut to `width`: titles shortened with `…`, then `Q1`, `Q2`…, then a window. */
	#tabBar(width: number): string {
		const tabs: Tab[] = this.#questions.map((question, index) => ({
			title: question.header ?? `Q${index + 1}`,
			answered: this.#answers[index] !== undefined,
		}));
		const fits = (titles: string[]) => visibleWidth(this.#bar(tabs, titles, 0, tabs.length)) <= width;
		const longest = Math.max(...tabs.map((tab) => visibleWidth(tab.title)));
		// Titles cut below six columns no longer tell the tabs apart: they become Q1, Q2… instead.
		for (let room = longest; room >= MIN_TITLE; room--) {
			const titles = tabs.map((tab) => cutTitle(tab.title, room));
			if (fits(titles)) return this.#bar(tabs, titles, 0, tabs.length);
		}
		const numbered = tabs.map((_, index) => `Q${index + 1}`);
		if (fits(numbered)) return this.#bar(tabs, numbered, 0, tabs.length);
		// Too many even as Q1, Q2…: the tabs around the one you are on.
		let from = this.#tab;
		let to = this.#tab + 1;
		while (true) {
			const wider = to < tabs.length ? [from, to + 1] : from > 0 ? [from - 1, to] : undefined;
			if (wider === undefined) break;
			const [a = from, b = to] = wider;
			if (visibleWidth(this.#bar(tabs, numbered, a, b)) > width) break;
			[from, to] = [a, b];
		}
		return this.#bar(tabs, numbered, from, to);
	}

	/** The bar with the tabs from `from` to before `to`, `…` for the ones left out. */
	#bar(tabs: readonly Tab[], titles: readonly string[], from: number, to: number): string {
		const paint = this.#paint;
		const cells = tabs.slice(from, to).map((tab, offset) => {
			const index = from + offset;
			const title = titles[index] ?? "";
			if (index === this.#tab) return paint("inverse", ` ${tab.answered ? "✔" : "○"} ${title} `);
			return ` ${tab.answered ? paint("green", "✔") : paint("dim", "○")} ${title} `;
		});
		const before = from > 0 ? "… " : "";
		const after = to < tabs.length ? " …" : "";
		return ` ${paint("dim", "←")} ${before}${cells.join(" ")}${after} ${paint("dim", "→")}`;
	}
}
