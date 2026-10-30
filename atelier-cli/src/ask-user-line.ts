import { type UserAnswer, type UserQuestion, type UserQuestionResult, visibleText } from "@atelier/core";

export const NO_TERMINAL_NOTICE = "ask_user needs an interactive terminal; no answer was collected.\n";

const OTHER_PROMPT = "Your answer: ";
const OTHER_MAX = 2000;

export interface AskUserPorts {
	signal: AbortSignal;
	write: (text: string) => void;
	/** One line typed after the prompt; undefined once the input ended or the read was cancelled. */
	read: (prompt: string, signal: AbortSignal) => Promise<{ text: string; pasted: boolean } | undefined>;
	/** Hands text that is not an answer to the session as a new message, which supersedes the question. */
	supersede: (text: string) => void;
}

/** The recommended option first, the rest as given. */
const shown = (question: UserQuestion) => [
	...question.options.filter((option) => option.recommended === true),
	...question.options.filter((option) => option.recommended !== true),
];

const shownText = (text: string) => visibleText(text).text;

function render(question: UserQuestion, index: number, total: number): string {
	const lines = shown(question).flatMap((option, i) => [
		`  ${i + 1}. ${shownText(option.label)}${option.recommended === true ? " (Recommended)" : ""}\n`,
		...(option.description ? [`     ${shownText(option.description)}\n`] : []),
	]);
	const any = question.multiSelect === true ? " (choose any, or none)" : "";
	return `Question ${index + 1}/${total}: ${shownText(question.question)}${any}\n${lines.join("")}  ${question.options.length + 1}. Other...\n`;
}

/** A line that tries to name choices: only digits, commas and spaces. */
const CHOICE_LIST = /^[\d\s,]+$/;

/**
 * The numbers of `text`, a multi-select answer: each from 1 to `last`, once, separated by commas; `0` alone for none.
 * Undefined when it is not one.
 */
function checkedNumbers(text: string, last: number): number[] | undefined {
	if (text === "0") return [];
	const parts = text.split(",").map((part) => part.trim());
	if (!parts.every((part) => /^\d+$/.test(part))) return undefined;
	const numbers = parts.map(Number);
	if (new Set(numbers).size !== numbers.length || numbers.some((number) => number < 1 || number > last))
		return undefined;
	return numbers;
}

/**
 * Asks the batch one question at a time. Only an explicit number answers; blank lines and pastes never do. A
 * multi-select question takes numbers separated by commas, `Other...` among them, or `0` for none.
 */
export async function askUserOnTerminal(questions: UserQuestion[], ports: AskUserPorts): Promise<UserQuestionResult> {
	const ended = (): UserQuestionResult =>
		ports.signal.aborted ? { status: "cancelled", reason: "interrupted" } : { status: "cancelled", reason: "closed" };
	const answers: UserAnswer[] = [];
	for (const [index, question] of questions.entries()) {
		const options = shown(question);
		const other = options.length + 1;
		const multiSelect = question.multiSelect === true;
		const prompt = multiSelect ? "Choose numbers like 1,3, 0 for none, or /cancel: " : `Choose 1-${other} or /cancel: `;
		/** The options checked, in the question's order, while the Other text of a multi-select answer is asked. */
		let checked: string[] = [];
		ports.write(render(question, index, questions.length));
		let answer: UserAnswer | undefined;
		let asking: "choice" | "other" = "choice";
		while (answer === undefined) {
			const line = await ports.read(asking === "choice" ? prompt : OTHER_PROMPT, ports.signal);
			if (line === undefined || ports.signal.aborted) return ended();
			const text = line.text.trim();
			if (text === "/cancel") return { status: "cancelled", reason: "user" };
			if (asking === "other") {
				if (text === "") ports.write("The answer must not be blank.\n");
				else if (line.text.length > OTHER_MAX) ports.write(`The answer must be at most ${OTHER_MAX} characters.\n`);
				else if (multiSelect) answer = { questionId: question.id, optionIds: checked, other: line.text };
				else answer = { questionId: question.id, other: line.text };
			} else if (line.pasted) ports.write("pasted text does not answer this question\n");
			else if (multiSelect && (text === "" || CHOICE_LIST.test(text))) {
				const numbers = checkedNumbers(text, other);
				if (numbers === undefined)
					ports.write(`Choose numbers from 1 to ${other}, each once and separated by commas, or 0 for none.\n`);
				else {
					const named = new Set(numbers.flatMap((number) => options[number - 1]?.id ?? []));
					checked = question.options.filter((option) => named.has(option.id)).map((option) => option.id);
					if (numbers.includes(other)) asking = "other";
					else answer = { questionId: question.id, optionIds: checked };
				}
			} else if (text === "") ports.write(`Choose a number from 1 to ${other}.\n`);
			else if (/^\d+$/.test(text)) {
				const number = Number(text);
				const option = options[number - 1];
				if (option) answer = { questionId: question.id, optionId: option.id };
				else if (number === other) asking = "other";
				else ports.write(`Choose a number from 1 to ${other}.\n`);
			} else {
				ports.supersede(line.text);
				return { status: "superseded" };
			}
		}
		answers.push(answer);
	}
	return { status: "answered", answers };
}
