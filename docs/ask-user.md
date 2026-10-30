# Structured user questions

Main sessions register `ask_user`; internal roles and subagents, including custom definitions, never receive it. RPC clients can opt in to structured questions. The [CLI](cli.md) offers numbered TUI questions between two rules or numbered line prompts; the [desktop](desktop.md#structured-questions) shows a batch in an approval-style card. Every client offers Other input.

## Input and limits

One tool handles a single question or a batch:

```json
{
	"questions": [
		{
			"id": "q1",
			"header": "Approach",
			"question": "Which approach?",
			"options": [
				{ "id": "a", "label": "Minimal change", "description": "Keep the current interface.", "recommended": true },
				{ "id": "b", "label": "Refactor" }
			]
		}
	]
}
```

- 1–4 questions, each with 2–4 model-provided options. Question IDs must be unique in the batch; option IDs must be unique within their question.
- IDs: 1–64 characters; question text: 1–500; labels: 1–200. None may be blank. An optional `header` (1–16 characters, not blank) is a short title for the question: the TUI uses it as the question's tab in a batch (`Q1`, `Q2`… without it); line mode and the desktop do not show it. Optional descriptions: 1–300 characters and nonblank when present; a blank description rejects the entire batch before the user callback runs.
- Exactly one option per question must have `recommended: true`; the others may omit the field or set it to `false`. A multi-select question (below) may recommend any number of its options, or none. Clients must show it first and mark it recommended (`(Recommended)` in line mode and the desktop, a `Recommended` tag in the TUI), without selecting it automatically or preselecting it. Descriptions go below their labels, or beside them in the TUI when the width allows.
- A session whose client asked for multi-select questions (`userQuestions: { multiSelect: true }`, see [Session lifecycle](#session-lifecycle)) also takes `multiSelect: true` on a question: the user checks any number of its options, `Other...` among them, or none. Elsewhere the model is not told of `multiSelect`, and a batch that has it, even as `false`, is refused before anyone is asked.
- Every question also offers `Other...` (`Type something…` in the TUI), independently of the 2–4 model options. The model cannot disable it. The user writes 1–2000 characters, not only whitespace. The answer preserves their text, including leading/trailing spaces and newlines. String limits use JavaScript UTF-16 length.

All three clients neutralize terminal control sequences and the text-direction characters on the [shared sanitizer's explicit list](../atelier-core/src/text.ts), including Arabic Letter Mark (U+061C), by showing visible markers in questions, labels and descriptions (`⟨U+061C⟩`, for example). This does not cover every invisible Unicode character. Command approvals use the same sanitizer.

## Session lifecycle

Supply `Session.start({ askUser })` for a direct user-only callback, or `userQuestions: true` to answer request events with `session.answerUser(callId, answers)` (`null` cancels). Without either channel the tool immediately returns `unavailable`. `userQuestions: false` omits the tool for internal sessions. `userQuestions: { multiSelect: true }` is `true` for a client that can also show multi-select questions; beside `askUser` it declares the same of the callback, which stays the channel (`Session.start({ askUser, userQuestions: { multiSelect: true } })`). `true`, `{}` or `askUser` alone keep every question single-choice.

A session registers the pending batch before emitting `user_question_requested { callId, questions }`, then emits exactly one `user_question_resolved { callId, result }` when it settles. Invalid replies leave the batch pending (`invalid_answer`); stale or duplicate replies fail with `unknown_question`. A second concurrent call returns `unavailable/question_pending`. No timeout or mode, including `yolo`, answers on the user's behalf.

An accepted `steer` or `follow_up` supersedes the batch without changing queue semantics. Interrupting or abandoning the event stream cancels it as `interrupted`; closing the session cancels it as `closed` and permanently prevents new questions, including calls still waiting for permission rules. Those calls return `cancelled/closed` without emitting a request. Resolution aborts the direct callback's signal so its UI can stop reading input, and late callback results are ignored. A disconnected or failing callback returns `unavailable/no_interactive_client`. Pending questions are never restored from saved history.

## RPC

These additions keep protocol version 7:
- `session.start` and `session.resume` take optional `userQuestions: true`. A resume must opt in again. Without the capability, `ask_user` returns `unavailable/no_interactive_client` immediately; older clients cannot hang waiting for an unknown question.
- `userQuestions: { multiSelect: true }` opts in and also lets the model ask multi-select questions; `true`, `{}` and `{ multiSelect: false }` keep every question single-choice, so a client that did not ask for them never receives one. A capability the server does not know (`{ preview: true }`, say) fails the command with `invalid_command` instead of being ignored. The TUI and line mode ask for multi-select questions; the desktop does not.
- `user_question_requested { callId, questions }` opens the batch; `user_question_resolved { callId, result }` closes it. Clients must discard the associated dialog and drafts when resolved, even if they have not sent an answer.
- `session.answer_user { sessionId, callId, answers }` returns `{}`. `answers` is the complete array of `{ questionId, optionId }` or `{ questionId, other }` (`{ questionId, optionIds, other? }` for a multi-select question, `optionIds` possibly empty), or `null` to cancel the whole batch. The codec enforces the input limits and exclusive answer forms; the session validates membership before consuming its pending batch.
- Replies fail with `invalid_answer` (the batch stays pending: `optionIds` for a single-choice question, any session without the capability included, `optionId` or a bare `other` for a multi-select one, unknown or repeated options), `unknown_question` (stale, duplicate or never asked) or `unknown_session`. Invalid command shapes fail with `invalid_command`.
- Interrupt, accepted queued messages, close, shutdown and input disconnect resolve the core-owned pending batch. There is no second pending-question map in the RPC server.

`UserQuestion`, `UserAnswer` and `UserQuestionResult` are available as type-only exports from `@atelier/core/protocol`, safe for browser clients.

## Exact model description

> Ask the user 1 to 4 questions, each with 2 to 4 options. Mark exactly one option per question recommended: true; clients show it first with (Recommended), never preselected. Each option may include a nonblank description of up to 300 characters. Every question also offers Other..., where the user can write 1 to 2000 characters; you cannot disable it. Only the user can answer, including in yolo mode. Wait for the result; never infer an answer from a cancelled, superseded or unavailable question.

With multi-select questions, the second sentence becomes:

> A question takes one answer unless multiSelect: true lets the user check any number of its options, or none. Mark exactly one option of a single-choice question recommended: true, and any number, or none, of a multi-select one; clients show them first with (Recommended), never preselected.

## Results and integration boundary

`createAskUserTool(ask)` validates input before calling `ask(questions, context)`. The context includes the call ID and abort signal when supplied. The callback must be a user-only channel, never a model, classifier or automatic approval. It owns waiting and cancellation; the factory itself has no queue, timeout or pending-question state, and does not request permission approval. Without a callback it returns `unavailable` immediately. The factory is not part of `coreTools`; the session restricts it to the main agent.

The tool returns JSON text. Only `answered` has `ok: true`; all other outcomes have `ok: false`:
- `{"status":"answered","answers":[{"questionId":"q1","optionId":"a","label":"Minimal change"}]}`: each option answer also carries the chosen option's `label`, so the model need not match the ids itself. Only the tool's output has it: `user_question_resolved` and `session.answer_user` keep `{ questionId, optionId }`.
- `{"status":"answered","answers":[{"questionId":"q1","other":"Use a third approach"}]}`
- `{"status":"answered","answers":[{"questionId":"checks","optionIds":["biome","tsc"],"other":"Lint the docs","labels":["Biome","TypeScript"]}]}`: a multi-select question's options checked, in the order the client sent them, with their `labels` in the same order; `other` only when the user also wrote their own text. `"optionIds":[]` (and `"labels":[]`) is the user checking none, a valid answer. As with `label`, `labels` is only in the tool's output.
- `{"status":"cancelled","reason":"user"}` (`reason` may also be `interrupted` or `closed`).
- `{"status":"superseded"}`
- `{"status":"unavailable","reason":"no_interactive_client"}` (`reason` may also be `question_pending`).

Batches are atomic: exactly one answer per question. A single-choice question takes either an offered `optionId` or `other`, never both; a multi-select one takes `optionIds` (offered, none repeated, possibly empty) with an optional `other`, and nothing else. `parseUserAnswers(questions, input)` validates a complete batch without consuming pending state, before accepting a reply. Unknown IDs, duplicates, partial batches, oversized text, ambiguous answers and an answer of the other kind of question are rejected. The tool also validates the callback's result before returning it to the model; non-answer outcomes cannot carry partial answers.
