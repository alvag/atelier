import { visibleText } from "@atelier/core";
import {
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PasteFilter } from "./dialog.ts";
import { fitHint, type QuestionAnswer, QuestionDialog, type QuestionOption } from "./question-dialog.ts";
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

const SUBMIT = "Submit";
/** The review's two answers, in order. */
const REVIEW_CHOICES = ["Submit answers", "Cancel"] as const;

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
 * answered ones marked `✔`, and a last `Submit` tab with a review of the answers; ← and → move among them keeping the
 * answers given, and answering a question moves to the next tab. The review's `Submit answers` sends the batch once
 * every question has an answer, or goes to the first one without; `Cancel` and Esc cancel the whole batch. Each
 * screen starts the guard again, so a key typed before it appeared does not answer it.
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
	readonly #guardMs: number;
	/** When the review came on screen, for its guard. */
	#reviewedAt = 0;
	/** The review's row with the cursor: `Submit answers` first. */
	#choice = 0;

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
		this.#guardMs = options.guardMs ?? 0;
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
		if (this.#dialogs.length === 1) {
			this.#finish([answer]);
			return;
		}
		this.#dialogs[index]?.reopen();
		this.#show(index + 1);
	}

	/** Puts tab `index` on screen, its guard started again; the one after the questions is the review. */
	#show(index: number): void {
		this.#tab = index;
		if (this.#reviewing) {
			this.#reviewedAt = Date.now();
			this.#choice = 0;
		} else this.#dialog?.reveal(Date.now(), true);
	}

	get #reviewing(): boolean {
		return this.#tab === this.#dialogs.length;
	}

	/** `Submit answers`: sends the batch, or goes to the first question without an answer and says why. */
	#submit(): void {
		const missing = this.#answers.findIndex((given) => given === undefined);
		if (missing === -1) {
			this.#finish(this.#answers.filter((given) => given !== undefined));
			return;
		}
		this.#show(missing);
		this.#dialog?.need("Answer this question to submit");
	}

	/** A key on the review: Up/Down, 1 or 2, Enter, and Esc; the paste filter takes out what was pasted. */
	#review(data: string): void {
		const keys = this.#paste.feed(data);
		if (keys === "" || Date.now() - this.#reviewedAt < this.#guardMs) return;
		if (matchesKey(keys, "escape")) this.#finish(null);
		else if (matchesKey(keys, "up") || matchesKey(keys, "down")) this.#choice = 1 - this.#choice;
		else if (matchesKey(keys, "enter") || keys === "1" || keys === "2") {
			const choice = keys === "1" ? 0 : keys === "2" ? 1 : this.#choice;
			this.#choice = choice;
			if (choice === 0) this.#submit();
			else this.#finish(null);
		}
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
				const next = Math.min(this.#dialogs.length, Math.max(0, this.#tab + step));
				if (next !== this.#tab) this.#show(next);
				return;
			}
		}
		if (this.#reviewing) this.#review(data);
		else dialog?.handleInput(data);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rule = this.#paint("cyan", "─".repeat(Math.max(1, width)));
		const body = this.#reviewing ? this.#reviewLines(width) : (this.#dialog?.body(width) ?? []);
		if (this.#dialogs.length === 1) return [rule, ...body, rule];
		return [rule, truncateToWidth(this.#tabBar(width), width), "", ...body, rule];
	}

	/** Each question's title as its tab says it. */
	#title(index: number): string {
		return this.#questions[index]?.header ?? `Q${index + 1}`;
	}

	/** What question `index` was answered, as the review says it: the option's label or the user's own text. */
	#answerText(index: number): string | undefined {
		const answer = this.#answers[index];
		if (answer === undefined) return undefined;
		if ("other" in answer)
			return `Type something: ${visibleText(answer.other.replace(/\s*[\r\n]+\s*/g, " ").trim()).text}`;
		return this.#questions[index]?.options[answer.option]?.label;
	}

	/** `Review your answers`, what is missing, each question's title and answer, then `Submit answers` and `Cancel`. */
	#reviewLines(width: number): string[] {
		const paint = this.#paint;
		const room = Math.max(1, width - 1);
		const missing = this.#answers.filter((given) => given === undefined).length;
		const warning =
			missing === 0
				? []
				: wrapTextWithAnsi(
						paint("yellow", `⚠ ${missing} ${missing === 1 ? "question has" : "questions have"} no answer`),
						room,
					);
		const titles = this.#questions.map((_, index) => cutTitle(this.#title(index), Math.max(MIN_TITLE, width / 3)));
		const column = Math.max(...titles.map((title) => visibleWidth(title)));
		const rows = titles.map((title, index) => {
			const answer = this.#answerText(index);
			const cell = `${answer === undefined ? "○" : "✔"} ${title}${" ".repeat(column - visibleWidth(title))}`;
			const said = answer === undefined ? paint("dim", "— no answer") : answer;
			const line = `  ${paint(answer === undefined ? "dim" : "green", cell)}   ${said}`;
			return truncateToWidth(line, width, "…");
		});
		const choices = REVIEW_CHOICES.map((label, index) => {
			const cursor = index === this.#choice ? paint("cyan", "❯") : " ";
			const text = index === this.#choice ? paint(["bold", "cyan"], label) : label;
			return ` ${cursor} ${paint("dim", `${index + 1}.`)} ${text}`;
		});
		const hint = fitHint(["←→ tabs", "↑↓ move", "1-2 pick", "enter select", "esc cancel"], room);
		return [
			` ${paint("bold", "Review your answers")}`,
			...warning.map((line) => ` ${line}`),
			"",
			...rows,
			"",
			...choices,
			"",
			` ${paint("dim", hint)}`,
		].map((line) => truncateToWidth(line, width));
	}

	/** ` ←  ✔ Language   ○ Checks  →`, cut to `width`: titles shortened with `…`, then `Q1`, `Q2`…, then a window. */
	#tabBar(width: number): string {
		const tabs: Tab[] = [
			...this.#questions.map((_, index) => ({
				title: this.#title(index),
				answered: this.#answers[index] !== undefined,
			})),
			{ title: SUBMIT, answered: true },
		];
		const fits = (titles: string[]) => visibleWidth(this.#bar(tabs, titles, 0, tabs.length)) <= width;
		const longest = Math.max(...tabs.map((tab) => visibleWidth(tab.title)));
		// Titles cut below six columns no longer tell the tabs apart: they become Q1, Q2… instead.
		for (let room = longest; room >= MIN_TITLE; room--) {
			const titles = tabs.map((tab) => cutTitle(tab.title, room));
			if (fits(titles)) return this.#bar(tabs, titles, 0, tabs.length);
		}
		const numbered = tabs.map((tab, index) => (index < this.#questions.length ? `Q${index + 1}` : tab.title));
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
