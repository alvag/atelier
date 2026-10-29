# Structured user questions

Main sessions register `ask_user`; internal roles and subagents, including custom definitions, never receive it. RPC clients can opt in to structured questions; built-in client integration is a separate delivery.

## Input and limits

One tool handles a single question or a batch:

```json
{
	"questions": [
		{
			"id": "q1",
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
- IDs: 1–64 characters; question text: 1–500; labels: 1–200. None may be blank. Optional descriptions: at most 300 characters.
- Exactly one option per question must have `recommended: true`; the others may omit the field or set it to `false`. Clients must show it first with `(Recommended)`, without selecting it automatically or preselecting it. Descriptions go below their labels.
- Every question also offers `Other...`, independently of the 2–4 model options. The model cannot disable it. The user writes 1–2000 characters, not only whitespace. The answer preserves their text, including leading/trailing spaces and newlines. String limits use JavaScript UTF-16 length.

## Session lifecycle

Supply `Session.start({ askUser })` for a direct user-only callback, or `userQuestions: true` to answer request events with `session.answerUser(callId, answers)` (`null` cancels). Without either channel the tool immediately returns `unavailable`. `userQuestions: false` omits the tool for internal sessions.

A session registers the pending batch before emitting `user_question_requested { callId, questions }`, then emits exactly one `user_question_resolved { callId, result }` when it settles. Invalid replies leave the batch pending (`invalid_answer`); stale or duplicate replies fail with `unknown_question`. A second concurrent call returns `unavailable/question_pending`. No timeout or mode, including `yolo`, answers on the user's behalf.

An accepted `steer` or `follow_up` supersedes the batch without changing queue semantics. Interrupting or abandoning the event stream cancels it as `interrupted`; closing the session cancels it as `closed`. Resolution aborts the direct callback's signal so its UI can stop reading input, and late callback results are ignored. A disconnected or failing callback returns `unavailable/no_interactive_client`. Pending questions are never restored from saved history.

## RPC

These additions keep protocol version 7:
- `session.start` and `session.resume` take optional `userQuestions: true`. A resume must opt in again. Without the capability, `ask_user` returns `unavailable/no_interactive_client` immediately; older clients cannot hang waiting for an unknown question.
- `user_question_requested { callId, questions }` opens the batch; `user_question_resolved { callId, result }` closes it. Clients must discard the associated dialog and drafts when resolved, even if they have not sent an answer.
- `session.answer_user { sessionId, callId, answers }` returns `{}`. `answers` is the complete array of `{ questionId, optionId }` or `{ questionId, other }`, or `null` to cancel the whole batch. The codec enforces the input limits and exclusive answer forms; the session validates membership before consuming its pending batch.
- Replies fail with `invalid_answer` (the batch stays pending), `unknown_question` (stale, duplicate or never asked) or `unknown_session`. Invalid command shapes fail with `invalid_command`.
- Interrupt, accepted queued messages, close, shutdown and input disconnect resolve the core-owned pending batch. There is no second pending-question map in the RPC server.

`UserQuestion`, `UserAnswer` and `UserQuestionResult` are available as type-only exports from `@atelier/core/protocol`, safe for browser clients.

## Exact model description

> Ask the user 1 to 4 questions, each with 2 to 4 options. Mark exactly one option per question recommended: true; clients show it first with (Recommended), never preselected. Each option may include a description of up to 300 characters. Every question also offers Other..., where the user can write 1 to 2000 characters; you cannot disable it. Only the user can answer, including in yolo mode. Wait for the result; never infer an answer from a cancelled, superseded or unavailable question.

## Results and integration boundary

`createAskUserTool(ask)` validates input before calling `ask(questions, context)`. The context includes the call ID and abort signal when supplied. The callback must be a user-only channel, never a model, classifier or automatic approval. It owns waiting and cancellation; the factory itself has no queue, timeout or pending-question state, and does not request permission approval. Without a callback it returns `unavailable` immediately. The factory is not part of `coreTools`; the session restricts it to the main agent.

The tool returns JSON text. Only `answered` has `ok: true`; all other outcomes have `ok: false`:
- `{"status":"answered","answers":[{"questionId":"q1","optionId":"a"}]}`
- `{"status":"answered","answers":[{"questionId":"q1","other":"Use a third approach"}]}`
- `{"status":"cancelled","reason":"user"}` (`reason` may also be `interrupted` or `closed`).
- `{"status":"superseded"}`
- `{"status":"unavailable","reason":"no_interactive_client"}` (`reason` may also be `question_pending`).

Batches are atomic: exactly one answer per question, either an offered `optionId` or `other`, never both. `parseUserAnswers(questions, input)` validates a complete batch without consuming pending state, before accepting a reply. Unknown IDs, duplicates, partial batches, oversized text and ambiguous answers are rejected. The tool also validates the callback's result before returning it to the model; non-answer outcomes cannot carry partial answers.
