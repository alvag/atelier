import type { AtelierEventBody } from "./events.ts";
import {
	type AskUser,
	parseUserAnswers,
	parseUserQuestionResult,
	type UserQuestion,
	type UserQuestionResult,
} from "./tools/ask-user.ts";
import type { ToolContext } from "./tools/types.ts";

interface PendingQuestion {
	callId: string;
	questions: UserQuestion[];
	settle: (result: UserQuestionResult) => void;
}

/** One user-only batch, registered before its event; every exit invalidates it synchronously. */
export class UserQuestions {
	#pending: PendingQuestion | undefined;
	#closed = false;
	readonly #emit: (event: AtelierEventBody) => void;
	readonly #delivered: (signal: AbortSignal) => Promise<boolean>;

	constructor(emit: (event: AtelierEventBody) => void, delivered: (signal: AbortSignal) => Promise<boolean>) {
		this.#emit = emit;
		this.#delivered = delivered;
	}

	has(callId: string): boolean {
		return this.#pending?.callId === callId;
	}

	answer(callId: string, input: unknown): void {
		const pending = this.#pending;
		if (!pending || pending.callId !== callId) throw new Error("No pending user question.");
		const result: UserQuestionResult =
			input === null
				? { status: "cancelled", reason: "user" }
				: { status: "answered", answers: parseUserAnswers(pending.questions, input) };
		pending.settle(result);
	}

	cancel(result: UserQuestionResult): void {
		this.#pending?.settle(result);
	}

	close(): void {
		this.#closed = true;
		this.cancel({ status: "cancelled", reason: "closed" });
	}

	ask(questions: UserQuestion[], context: ToolContext, enabled: boolean, ask?: AskUser): Promise<UserQuestionResult> {
		if (this.#closed) return Promise.resolve({ status: "cancelled", reason: "closed" });
		if (context.signal?.aborted) return Promise.resolve({ status: "cancelled", reason: "interrupted" });
		if (!enabled) return Promise.resolve({ status: "unavailable", reason: "no_interactive_client" });
		if (this.#pending) return Promise.resolve({ status: "unavailable", reason: "question_pending" });
		const callId = context.callId as string;
		return new Promise((resolve) => {
			const abort = new AbortController();
			const interrupted = () => pending.settle({ status: "cancelled", reason: "interrupted" });
			const pending: PendingQuestion = {
				callId,
				questions,
				settle: (result) => {
					if (this.#pending !== pending) return;
					this.#pending = undefined;
					context.signal?.removeEventListener("abort", interrupted);
					abort.abort();
					this.#emit({ type: "user_question_resolved", callId, result });
					resolve(result);
				},
			};
			this.#pending = pending;
			context.signal?.addEventListener("abort", interrupted, { once: true });
			this.#emit({ type: "user_question_requested", callId, questions });
			if (ask)
				void this.#delivered(abort.signal)
					.then(async (delivered) => {
						if (this.#pending !== pending) return;
						if (!delivered) return pending.settle({ status: "cancelled", reason: "interrupted" });
						const response = await ask(questions, { ...context, signal: abort.signal });
						if (this.#pending === pending) pending.settle(parseUserQuestionResult(questions, response));
					})
					.catch(() => pending.settle({ status: "unavailable", reason: "no_interactive_client" }));
		});
	}
}
