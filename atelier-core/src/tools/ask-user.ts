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
/** What a client can ask beyond single-choice questions, when it opens the session. */
export interface UserQuestionCapabilities {
	/** The client can check any number of a question's options, or none (`multiSelect: true`). */
	multiSelect?: boolean;
}

const RECOMMENDED_ONE = "Exactly one option per question must have recommended: true";
const RECOMMENDED_ANY =
	"Exactly one option of a single-choice question must have recommended: true; any number, or none, of a multi-select one";
const option = (recommended: string) =>
	z.strictObject({
		id,
		label: text(200),
		description: text(300).optional(),
		recommended: z.boolean().optional().describe(recommended),
	});
const recommendedCount = (options: { recommended?: boolean | undefined }[]) =>
	options.filter((entry) => entry.recommended === true).length;
const header = text(16).optional().describe("A short title for the question, such as its tab in a batch");
const singleChoice = z.strictObject({
	id,
	header,
	question: text(500),
	options: z
		.array(option(RECOMMENDED_ONE))
		.min(2)
		.max(4)
		.refine(uniqueIds, "Option IDs must be unique within a question")
		.refine((options) => recommendedCount(options) === 1, "Exactly one option must be recommended"),
});
/** A question of a session whose client can check several options: `multiSelect: true` lifts the one-recommended rule. */
const anyChoice = z
	.strictObject({
		id,
		header,
		question: text(500),
		multiSelect: z
			.boolean()
			.optional()
			.describe("true lets the user check any number of the options, or none; one answer otherwise"),
		options: z
			.array(option(RECOMMENDED_ANY))
			.min(2)
			.max(4)
			.refine(uniqueIds, "Option IDs must be unique within a question"),
	})
	.refine((entry) => entry.multiSelect === true || recommendedCount(entry.options) === 1, {
		message: "Exactly one option of a single-choice question must be recommended",
		path: ["options"],
	});
const batch = <Question extends z.ZodType<{ id: string }>>(question: Question) =>
	z.array(question).min(1).max(4).refine(uniqueIds, "Question IDs must be unique");
const answer = z.union([
	z.strictObject({ questionId: id, optionId: id }),
	z.strictObject({ questionId: id, other: text(2000) }),
	z.strictObject({ questionId: id, optionIds: z.array(id).max(4), other: text(2000).optional() }),
]);
const result = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("answered"), answers: z.array(answer).min(1).max(4) }),
	z.strictObject({ status: z.literal("cancelled"), reason: z.enum(["user", "interrupted", "closed"]) }),
	z.strictObject({ status: z.literal("superseded") }),
	z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["no_interactive_client", "question_pending"]) }),
]);

export type UserQuestion = z.infer<typeof anyChoice>;
export type UserAnswer = z.infer<typeof answer>;
export type UserQuestionResult = z.infer<typeof result>;
/** The session supplies a user-only channel; permissions and classifiers never provide answers. */
export type AskUser = (questions: UserQuestion[], context: ToolContext) => Promise<UserQuestionResult>;

/** The options an answer names: the ones checked, the one chosen, or none for the user's own text. */
const namedOptions = (entry: UserAnswer) =>
	"optionIds" in entry ? entry.optionIds : "optionId" in entry ? [entry.optionId] : [];

/**
 * Validate the entire batch before consuming a pending question; Other text is preserved as written. A multi-select
 * question takes `optionIds` (none included) and nothing else; a single-choice one takes one `optionId` or `other`.
 */
export function parseUserAnswers(questions: readonly UserQuestion[], input: unknown): UserAnswer[] {
	const answers = z.array(answer).length(questions.length).parse(input);
	const seen = new Set<string>();
	for (const entry of answers) {
		const question = questions.find((candidate) => candidate.id === entry.questionId);
		if (!question || seen.has(entry.questionId)) throw new Error("Each question must be answered exactly once.");
		const multiSelect = question.multiSelect === true;
		if (multiSelect !== "optionIds" in entry)
			throw new Error(
				multiSelect
					? "A multi-select question must be answered with optionIds."
					: "A single-choice question must be answered with one optionId or other.",
			);
		const named = namedOptions(entry);
		if (new Set(named).size !== named.length) throw new Error("Each option may be checked only once.");
		if (!named.every((optionId) => question.options.some((option) => option.id === optionId)))
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

/**
 * What the model is told: each option answer also carries the label of the option chosen (`labels`, of the options
 * checked), so it need not look them up.
 */
function forModel(questions: readonly UserQuestion[], response: UserQuestionResult): unknown {
	if (response.status !== "answered") return response;
	const answers = response.answers.map((entry) => {
		const question = questions.find((candidate) => candidate.id === entry.questionId);
		const labels = namedOptions(entry).map(
			(optionId) => question?.options.find((option) => option.id === optionId)?.label,
		);
		if (labels.some((label) => label === undefined)) return entry;
		if ("optionIds" in entry) return { ...entry, labels };
		return "optionId" in entry ? { ...entry, label: labels[0] } : entry;
	});
	return { ...response, answers };
}

const ASKS = "Ask the user 1 to 4 questions, each with 2 to 4 options. ";
const RECOMMENDS_ONE =
	"Mark exactly one option per question recommended: true; clients show it first with (Recommended), never preselected. ";
const RECOMMENDS_ANY =
	"A question takes one answer unless multiSelect: true lets the user check any number of its options, or none. " +
	"Mark exactly one option of a single-choice question recommended: true, and any number, or none, of a multi-select one; " +
	"clients show them first with (Recommended), never preselected. ";
const REST =
	"Each option may include a nonblank description of up to 300 characters. " +
	"Every question also offers Other..., where the user can write 1 to 2000 characters; you cannot disable it. " +
	"Only the user can answer, including in yolo mode. " +
	"Wait for the result; never infer an answer from a cancelled, superseded or unavailable question.";

/**
 * Created by the main session, not included in coreTools or inherited by subagents. Without `multiSelect` among the
 * client's capabilities the model never hears of it, and a question that has it is refused before anyone is asked.
 */
export function createAskUserTool(ask?: AskUser, capabilities: UserQuestionCapabilities = {}): ToolDefinition {
	const multiSelect = capabilities.multiSelect === true;
	return defineTool({
		name: ASK_USER_TOOL,
		description: `${ASKS}${multiSelect ? RECOMMENDS_ANY : RECOMMENDS_ONE}${REST}`,
		inputShape: {
			questions: (multiSelect ? batch(anyChoice) : batch(singleChoice)).describe(
				"One complete batch of questions for the user",
			),
		},
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
