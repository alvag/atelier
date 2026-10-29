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
	return `Question ${index + 1}/${total}: ${shownText(question.question)}\n${lines.join("")}  ${question.options.length + 1}. Other...\n`;
}

/** Asks the batch one question at a time. Only an explicit number answers; blank lines and pastes never do. */
export async function askUserOnTerminal(questions: UserQuestion[], ports: AskUserPorts): Promise<UserQuestionResult> {
	const ended = (): UserQuestionResult =>
		ports.signal.aborted ? { status: "cancelled", reason: "interrupted" } : { status: "cancelled", reason: "closed" };
	const answers: UserAnswer[] = [];
	for (const [index, question] of questions.entries()) {
		const options = shown(question);
		const other = options.length + 1;
		const prompt = `Choose 1-${other} or /cancel: `;
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
				else answer = { questionId: question.id, other: line.text };
			} else if (line.pasted) ports.write("pasted text does not answer this question\n");
			else if (text === "") ports.write(`Choose a number from 1 to ${other}.\n`);
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
