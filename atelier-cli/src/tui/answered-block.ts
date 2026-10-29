import { type JsonValue, type UserQuestion, type UserQuestionResult, visibleText } from "@atelier/core";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Paint } from "./style.ts";

/**
 * What a batch came to: the core's result; `not_asked` when the tool ended it without asking (another question was
 * waiting, the session had closed); `failed` with the tool's error when the call failed, as on an invalid input.
 */
export type AskOutcome =
	| UserQuestionResult
	| { status: "not_asked" }
	| { status: "waiting" }
	| { status: "failed"; message: string };

/** The summaries of the outcomes the tool returns itself, which have their own resolution or none to say. */
const OWN_OUTCOME = /^User (question (cancelled|superseded|unavailable)|answered \d+ questions?)\.$/;

/** What an `ask_user` call that ended without a resolution came to, from how it finished. */
export function finishedOutcome(event: { ok: boolean; summary: string }): AskOutcome {
	return event.ok || OWN_OUTCOME.test(event.summary)
		? { status: "not_asked" }
		: { status: "failed", message: event.summary };
}

/** A failed call's error as shown, one row per line of it, in `room` columns. */
const failureLines = (message: string, room: number) =>
	shown(message)
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, room)));

const shown = (text: string) => visibleText(text).text;

/** The questions of an `ask_user` call's input, or none when it holds something else. */
export function questionsOf(input: JsonValue): UserQuestion[] {
	const questions = typeof input === "object" && input !== null && !Array.isArray(input) ? input.questions : undefined;
	if (!Array.isArray(questions)) return [];
	return questions.filter(
		(question): question is UserQuestion & JsonValue =>
			typeof question === "object" &&
			question !== null &&
			!Array.isArray(question) &&
			typeof question.question === "string" &&
			Array.isArray(question.options),
	);
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Text on one line, as shown: its line breaks as spaces, without the blanks at its edges (what was sent keeps them). */
const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** `Answered 2 questions`, or what kept the batch from an answer. */
export function outcomeTitle(count: number, outcome: AskOutcome): string {
	const questions = plural(count, "question");
	switch (outcome.status) {
		case "answered":
			return `Answered ${questions}`;
		case "cancelled":
			return outcome.reason === "user"
				? `${questions} cancelled by you`
				: `${questions} cancelled: ${outcome.reason === "interrupted" ? "the turn was interrupted" : "the session closed"}`;
		case "superseded":
			return `${questions} superseded by your new message`;
		case "unavailable":
			return `${questions} not asked: ${outcome.reason === "question_pending" ? "another question was waiting" : "no interactive client"}`;
		case "not_asked":
			return `${questions} not asked`;
		case "waiting":
			return `Waiting for ${plural(count, "answer")}`;
		case "failed":
			return "ask_user failed";
	}
}

/** What the user answered to `question`: the option's label, their own text after `Type something:`, or nothing. */
function answerOf(question: UserQuestion, outcome: AskOutcome): string | undefined {
	if (outcome.status !== "answered") return undefined;
	const answer = outcome.answers.find((entry) => entry.questionId === question.id);
	if (answer === undefined) return undefined;
	if ("other" in answer) return `Type something: ${shown(oneLine(answer.other))}`;
	const option = question.options.find((candidate) => candidate.id === answer.optionId);
	return option === undefined ? undefined : shown(option.label);
}

/**
 * Each question and what it came to in `room` columns: `question  → answer` lined up when every question fits in half
 * of them, else each answer under its question; `— no answer` (or `— waiting`) when there is none.
 */
export function answerLines(
	questions: readonly UserQuestion[],
	outcome: AskOutcome,
	paint: Paint,
	room: number,
): string[] {
	const width = Math.max(1, room);
	if (outcome.status === "failed") return failureLines(outcome.message, width);
	const texts = questions.map((question) => shown(oneLine(question.question)));
	const column = Math.max(0, ...texts.map((text) => visibleWidth(text)));
	const aligned = column <= Math.floor(width / 2);
	return questions.flatMap((question, index) => {
		const text = texts[index] ?? "";
		const answer = answerOf(question, outcome);
		// `→ ` before an answer, its other rows under its text; `— no answer` alone.
		const said = (indent: number) => {
			if (answer === undefined)
				return wrapTextWithAnsi(
					outcome.status === "waiting" ? "— waiting" : "— no answer",
					Math.max(1, width - indent),
				).map((part) => paint("dim", part));
			const lead = Math.min(2, Math.max(0, width - indent - 1));
			return wrapTextWithAnsi(answer, Math.max(1, width - indent - lead)).map(
				(part, at) => `${at === 0 ? paint("dim", "→ ".slice(0, lead)) : " ".repeat(lead)}${part}`,
			);
		};
		if (aligned) {
			const indent = column + 2;
			const [first = "", ...rest] = said(indent);
			return [
				`${text}${" ".repeat(indent - visibleWidth(text))}${first}`,
				...rest.map((part) => `${" ".repeat(indent)}${part}`),
			];
		}
		const indent = Math.min(2, width - 1);
		return [...wrapTextWithAnsi(text, width), ...said(indent).map((part) => `${" ".repeat(indent)}${part}`)];
	});
}

/** `● Answered 2 questions` and, under `⎿`, each question with its answer: what the user said, kept in the transcript. */
export class AnsweredBlock implements Component {
	readonly #questions: readonly UserQuestion[];
	readonly #paint: Paint;
	outcome: AskOutcome;

	constructor(questions: readonly UserQuestion[], outcome: AskOutcome, paint: Paint) {
		this.#questions = questions;
		this.outcome = outcome;
		this.#paint = paint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paint = this.#paint;
		const status = this.outcome.status;
		const mark = paint(status === "answered" ? "green" : status === "failed" ? "red" : "yellow", "●");
		const title = wrapTextWithAnsi(outcomeTitle(this.#questions.length, this.outcome), Math.max(1, width - 3));
		const lines = answerLines(this.#questions, this.outcome, paint, width - 5);
		return [
			...title.map((line, index) => `${index === 0 ? ` ${mark} ` : "   "}${paint("bold", line)}`),
			...lines.map((line, index) => `${index === 0 ? paint("dim", "   ⎿ ") : "     "}${line}`),
		];
	}
}
