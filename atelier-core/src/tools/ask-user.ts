import { z } from "zod";
import { defineTool, type ToolContext, type ToolDefinition } from "./types.ts";

export const ASK_USER_TOOL = "ask_user";

const text = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine((value) => value.trim().length > 0, "Must not be blank");
const id = text(64);
const uniqueIds = (items: { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;
const option = z.strictObject({
	id,
	label: text(200),
	description: text(300).optional(),
	recommended: z.boolean().optional().describe("Exactly one option per question must have recommended: true"),
});
const question = z.strictObject({
	id,
	header: text(16).optional().describe("A short title for the question, such as its tab in a batch"),
	question: text(500),
	options: z
		.array(option)
		.min(2)
		.max(4)
		.refine(uniqueIds, "Option IDs must be unique within a question")
		.refine(
			(options) => options.filter((entry) => entry.recommended === true).length === 1,
			"Exactly one option must be recommended",
		),
});
const questions = z.array(question).min(1).max(4).refine(uniqueIds, "Question IDs must be unique");
const answer = z.union([
	z.strictObject({ questionId: id, optionId: id }),
	z.strictObject({ questionId: id, other: text(2000) }),
]);
const result = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("answered"), answers: z.array(answer).min(1).max(4) }),
	z.strictObject({ status: z.literal("cancelled"), reason: z.enum(["user", "interrupted", "closed"]) }),
	z.strictObject({ status: z.literal("superseded") }),
	z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["no_interactive_client", "question_pending"]) }),
]);

export type UserQuestion = z.infer<typeof question>;
export type UserAnswer = z.infer<typeof answer>;
export type UserQuestionResult = z.infer<typeof result>;
/** The session supplies a user-only channel; permissions and classifiers never provide answers. */
export type AskUser = (questions: UserQuestion[], context: ToolContext) => Promise<UserQuestionResult>;

/** Validate the entire batch before consuming a pending question; Other text is preserved as written. */
export function parseUserAnswers(questions: readonly UserQuestion[], input: unknown): UserAnswer[] {
	const answers = z.array(answer).length(questions.length).parse(input);
	const seen = new Set<string>();
	for (const entry of answers) {
		const question = questions.find((candidate) => candidate.id === entry.questionId);
		if (!question || seen.has(entry.questionId)) throw new Error("Each question must be answered exactly once.");
		if ("optionId" in entry && !question.options.some((option) => option.id === entry.optionId))
			throw new Error("The answer must name an offered option.");
		seen.add(entry.questionId);
	}
	return answers;
}

export function parseUserQuestionResult(questions: readonly UserQuestion[], input: unknown): UserQuestionResult {
	const response = result.parse(input);
	if (response.status === "answered") response.answers = parseUserAnswers(questions, response.answers);
	return response;
}

/** What the model is told: each option answer also carries the label of the option chosen, so it need not look it up. */
function forModel(questions: readonly UserQuestion[], response: UserQuestionResult): unknown {
	if (response.status !== "answered") return response;
	const answers = response.answers.map((entry) => {
		if (!("optionId" in entry)) return entry;
		const question = questions.find((candidate) => candidate.id === entry.questionId);
		const label = question?.options.find((option) => option.id === entry.optionId)?.label;
		return label === undefined ? entry : { ...entry, label };
	});
	return { ...response, answers };
}

/** Created by the main session, not included in coreTools or inherited by subagents. */
export function createAskUserTool(ask?: AskUser): ToolDefinition {
	return defineTool({
		name: ASK_USER_TOOL,
		description:
			"Ask the user 1 to 4 questions, each with 2 to 4 options. " +
			"Mark exactly one option per question recommended: true; clients show it first with (Recommended), never preselected. " +
			"Each option may include a nonblank description of up to 300 characters. " +
			"Every question also offers Other..., where the user can write 1 to 2000 characters; you cannot disable it. " +
			"Only the user can answer, including in yolo mode. " +
			"Wait for the result; never infer an answer from a cancelled, superseded or unavailable question.",
		inputShape: { questions: questions.describe("One complete batch of questions for the user") },
		execute: async ({ questions }, context) => {
			const response = parseUserQuestionResult(
				questions,
				(await ask?.(questions, context)) ?? { status: "unavailable", reason: "no_interactive_client" },
			);
			return {
				ok: response.status === "answered",
				output: JSON.stringify(forModel(questions, response)),
				summary:
					response.status === "answered"
						? `User answered ${response.answers.length} question${response.answers.length === 1 ? "" : "s"}.`
						: `User question ${response.status}.`,
				truncated: false,
			};
		},
	});
}
