import type { UserAnswer, UserQuestion } from "@atelier/core/protocol";
import { visibleText } from "@atelier/core/text";
import { useState } from "react";
import type { TurnItem } from "./reducer.ts";

/** Answers an `ask_user` batch, or cancels it with `null`; false when the core refused. */
export type OnAnswerUser = (callId: string, answers: UserAnswer[] | null) => Promise<boolean>;

type Item = Extract<TurnItem, { kind: "question" }>;
type Pick = { optionId: string } | "other";

const OTHER_MAX = 2000;
const validOther = (text: string) => text.trim().length > 0 && text.length <= OTHER_MAX;

/** What a resolved card says: the answers, or why there are none. */
function resultLines(item: Item): string[] {
	const result = item.result;
	if (!result) return [];
	switch (result.status) {
		case "answered":
			return result.answers.map((answer) => {
				const question = item.questions.find((entry) => entry.id === answer.questionId);
				const given =
					"other" in answer
						? `Other: ${answer.other}`
						: (question?.options.find((option) => option.id === answer.optionId)?.label ?? answer.optionId);
				return visibleText(`${question?.question ?? answer.questionId} → ${given}`).text;
			});
		case "cancelled":
			return [`Cancelled (${result.reason})`];
		case "superseded":
			return ["Superseded by a new message"];
		case "unavailable":
			return [`Unavailable (${result.reason})`];
	}
}

function Question({
	question,
	pick,
	text,
	disabled,
	onPick,
	onText,
}: {
	question: UserQuestion;
	pick: Pick | undefined;
	text: string;
	disabled: boolean;
	onPick: (pick: Pick) => void;
	onText: (text: string) => void;
}) {
	// The recommended option leads; nothing is ever selected for the user.
	const options = [...question.options].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true));
	const name = `${question.id}`;
	return (
		<fieldset className="question" disabled={disabled}>
			<legend>{visibleText(question.question).text}</legend>
			{options.map((option) => (
				<label key={option.id} className="question-option">
					<input
						type="radio"
						name={name}
						checked={pick !== undefined && pick !== "other" && pick.optionId === option.id}
						onChange={() => onPick({ optionId: option.id })}
					/>
					<span>
						{visibleText(option.label).text}
						{option.recommended ? " (Recommended)" : ""}
					</span>
					{option.description ? (
						<span className="question-description">{visibleText(option.description).text}</span>
					) : null}
				</label>
			))}
			<label className="question-option">
				<input type="radio" name={name} checked={pick === "other"} onChange={() => onPick("other")} />
				<span>Other…</span>
			</label>
			{pick === "other" ? (
				<textarea
					aria-label={`Your answer to: ${visibleText(question.question).text}`}
					value={text}
					rows={3}
					onChange={(event) => onText(event.target.value)}
				/>
			) : null}
		</fieldset>
	);
}

export function QuestionCard({ item, onAnswerUser }: { item: Item; onAnswerUser: OnAnswerUser }) {
	const [picks, setPicks] = useState<ReadonlyMap<string, Pick>>(new Map());
	const [texts, setTexts] = useState<ReadonlyMap<string, string>>(new Map());
	const [sending, setSending] = useState(false);
	if (item.state === "resolved")
		return (
			<fieldset className="approval">
				<legend>Questions</legend>
				{resultLines(item).map((line) => (
					<div key={line} className="approval-state">
						{line}
					</div>
				))}
			</fieldset>
		);
	const complete = item.questions.every((question) => {
		const pick = picks.get(question.id);
		return pick !== undefined && (pick !== "other" || validOther(texts.get(question.id) ?? ""));
	});
	const submit = async (answers: UserAnswer[] | null) => {
		if (sending) return;
		setSending(true);
		// The card stays until the core's resolved event; a refusal gives it back.
		if (!(await onAnswerUser(item.callId, answers))) setSending(false);
	};
	const answers = (): UserAnswer[] =>
		item.questions.map((question) => {
			const pick = picks.get(question.id);
			return pick === "other"
				? { questionId: question.id, other: texts.get(question.id) ?? "" }
				: { questionId: question.id, optionId: (pick as { optionId: string }).optionId };
		});
	return (
		<fieldset className="approval">
			<legend>Answer {item.questions.length === 1 ? "this question" : "these questions"}</legend>
			{item.questions.map((question) => (
				<Question
					key={question.id}
					question={question}
					pick={picks.get(question.id)}
					text={texts.get(question.id) ?? ""}
					disabled={sending}
					onPick={(pick) => setPicks((current) => new Map(current).set(question.id, pick))}
					onText={(text) => setTexts((current) => new Map(current).set(question.id, text))}
				/>
			))}
			<div className="approval-actions">
				<button type="button" disabled={!complete || sending} onClick={() => void submit(answers())}>
					Send answers
				</button>
				<button type="button" disabled={sending} onClick={() => void submit(null)}>
					Cancel
				</button>
			</div>
		</fieldset>
	);
}
