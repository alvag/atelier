import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AskUser, coreTools, createAskUserTool, parseUserAnswers, ToolInputError } from "../src/index.ts";

const question = () => ({
	id: "q1",
	question: "Which approach?",
	options: [
		{ id: "a", label: "Minimal change", description: "Keep the current interface.", recommended: true },
		{ id: "b", label: "Refactor", recommended: false },
	],
});
const input = () => ({ questions: [question()] });
const context = { cwd: process.cwd(), callId: "call-1", signal: new AbortController().signal };

it("publishes the model contract without enabling the tool in existing sessions", () => {
	const tool = createAskUserTool();
	expect(tool.name).toBe("ask_user");
	expect(tool.description).toBe(
		"Ask the user 1 to 4 questions, each with 2 to 4 options. " +
			"Mark exactly one option per question recommended: true; clients show it first with (Recommended), never preselected. " +
			"Each option may include a nonblank description of up to 300 characters. " +
			"Every question also offers Other..., where the user can write 1 to 2000 characters; you cannot disable it. " +
			"Only the user can answer, including in yolo mode. " +
			"Wait for the result; never infer an answer from a cancelled, superseded or unavailable question.",
	);
	expect(coreTools.some((candidate) => candidate.name === tool.name)).toBe(false);
	expect(z.toJSONSchema(z.object(tool.inputShape))).toMatchObject({
		properties: { questions: { minItems: 1, maxItems: 4 } },
	});
});

it("passes validated questions and call context to the user callback, without permission approval", async () => {
	const result = { status: "answered" as const, answers: [{ questionId: "q1", optionId: "b" }] };
	const ask = vi.fn<AskUser>().mockResolvedValue(result);
	const tool = createAskUserTool(ask);
	expect(tool.approvalCommand(input())).toBeUndefined();
	expect(await tool.execute(input(), context)).toEqual({
		ok: true,
		output: JSON.stringify({
			status: "answered",
			answers: [{ questionId: "q1", optionId: "b", label: "Refactor" }],
		}),
		summary: "User answered 1 question.",
		truncated: false,
	});
	expect(ask).toHaveBeenCalledExactlyOnceWith(input().questions, context);
});

it("accepts boundary lengths and returns a complete mixed batch without trimming Other text", async () => {
	const questions = Array.from({ length: 4 }, (_, index) => ({
		id: `${index}${"q".repeat(63)}`,
		question: "?".repeat(500),
		options: Array.from({ length: 4 }, (_, option) => ({
			id: `${option}${"a".repeat(63)}`,
			label: "L".repeat(200),
			description: "d".repeat(300),
			recommended: option === 3,
		})),
	}));
	const answers = questions.map((q, index) =>
		index % 2 === 0
			? { questionId: q.id, other: ` ${"x".repeat(1998)} ` }
			: { questionId: q.id, optionId: q.options[0]?.id as string },
	);
	const tool = createAskUserTool(async () => ({ status: "answered", answers }));
	// The model also gets the label of each option chosen; the user's own text comes as written, without one.
	const labelled = answers.map((entry) => ("optionId" in entry ? { ...entry, label: "L".repeat(200) } : entry));
	expect(JSON.parse((await tool.execute({ questions }, context)).output)).toEqual({
		status: "answered",
		answers: labelled,
	});
});

describe("ask_user input validation", () => {
	it.each(["", "  ", "\n\t"])("rejects blank descriptions %j before asking anyone", async (description) => {
		const ask = vi.fn<AskUser>();
		const questions = [
			{ ...question(), options: question().options.map((option) => ({ ...option, description })) },
			{ ...question(), id: "q2" },
		];
		await expect(createAskUserTool(ask).execute({ questions }, context)).rejects.toThrow(ToolInputError);
		expect(ask).not.toHaveBeenCalled();
	});

	it.each([
		["no questions", { questions: [] }],
		["five questions", { questions: Array.from({ length: 5 }, (_, i) => ({ ...question(), id: String(i) })) }],
		["duplicate questions", { questions: [question(), question()] }],
		...["id", "question"].flatMap((key) => [
			[`${key} blank`, { questions: [{ ...question(), [key]: "  " }] }],
			[`${key} too long`, { questions: [{ ...question(), [key]: "x".repeat(key === "id" ? 65 : 501) }] }],
		]),
		...[
			[],
			[question().options[0]],
			Array(5).fill(question().options[0]),
			question().options.map((o) => ({ ...o, recommended: false })),
			question().options.map((o) => ({ ...o, recommended: true })),
			question().options.map(({ recommended: _recommended, ...o }) => o),
			question().options.map((o) => ({ ...o, id: "a" })),
			...Object.entries({
				id: "x".repeat(65),
				label: "x".repeat(201),
				description: "x".repeat(301),
				recommended: "true",
			}).map(([key, value]) => [{ ...question().options[0], [key]: value }, question().options[1]]),
			...["id", "label"].map((key) => [{ ...question().options[0], [key]: " " }, question().options[1]]),
		].map((options, index) => [`invalid options ${index}`, { questions: [{ ...question(), options }] }]),
	])("rejects %s before asking anyone", async (_label, value) => {
		const ask = vi.fn<AskUser>();
		await expect(createAskUserTool(ask).execute(value, context)).rejects.toThrow(ToolInputError);
		expect(ask).not.toHaveBeenCalled();
	});
});

it("accepts an optional header of up to 16 characters and passes it to the user callback", async () => {
	const ask = vi.fn<AskUser>().mockResolvedValue({ status: "cancelled", reason: "user" });
	const questions = [
		{ ...question(), header: "x".repeat(16) },
		{ ...question(), id: "q2" },
	];
	await createAskUserTool(ask).execute({ questions }, context);
	expect(ask).toHaveBeenCalledExactlyOnceWith(questions, context);
	expect(z.toJSONSchema(z.object(createAskUserTool().inputShape))).toMatchObject({
		properties: { questions: { items: { properties: { header: { maxLength: 16 } } } } },
	});
});

it.each(["", "  ", "x".repeat(17)])("rejects the header %j before asking anyone", async (header) => {
	const ask = vi.fn<AskUser>();
	await expect(createAskUserTool(ask).execute({ questions: [{ ...question(), header }] }, context)).rejects.toThrow(
		ToolInputError,
	);
	expect(ask).not.toHaveBeenCalled();
});

it("accepts optional descriptions and omitted false recommendations", async () => {
	const questions = [
		{
			...question(),
			options: [
				{ id: "a", label: "A", recommended: true },
				{ id: "b", label: "B" },
			],
		},
	];
	expect((await createAskUserTool().execute({ questions }, context)).ok).toBe(false);
});

describe("user answers", () => {
	it.each([
		["missing", []],
		["unknown question", [{ questionId: "q2", optionId: "a" }]],
		["unknown option", [{ questionId: "q1", optionId: "missing" }]],
		["neither option nor Other", [{ questionId: "q1" }]],
		["both option and Other", [{ questionId: "q1", optionId: "a", other: "Both" }]],
		["empty Other", [{ questionId: "q1", other: "" }]],
		["blank Other", [{ questionId: "q1", other: "  " }]],
		["oversized Other", [{ questionId: "q1", other: "x".repeat(2001) }]],
		[
			"too many",
			[
				{ questionId: "q1", optionId: "a" },
				{ questionId: "q1", optionId: "b" },
			],
		],
	])("rejects %s answers", (_name, answers) => {
		expect(() => parseUserAnswers(input().questions, answers)).toThrow();
	});

	it("rejects duplicate answers even when the batch size is correct", () => {
		const answer = { questionId: "q1", optionId: "a" };
		expect(() => parseUserAnswers([question(), { ...question(), id: "q2" }], [answer, answer])).toThrow();
	});

	it("does not return an invalid callback answer to the model as success", async () => {
		const tool = createAskUserTool(async () => ({ status: "answered", answers: [{ questionId: "q1", other: "" }] }));
		await expect(tool.execute(input(), context)).rejects.toThrow();
	});
});

it.each([
	{ status: "cancelled", reason: "user" },
	{ status: "cancelled", reason: "interrupted" },
	{ status: "cancelled", reason: "closed" },
	{ status: "superseded" },
	{ status: "unavailable", reason: "no_interactive_client" },
	{ status: "unavailable", reason: "question_pending" },
] as const)("returns $status/$reason without an inferred or partial answer", async (result) => {
	const outcome = await createAskUserTool(async () => result).execute(input(), context);
	expect(outcome).toMatchObject({ ok: false, output: JSON.stringify(result), truncated: false });
});

it("returns unavailable when there is no user callback", async () => {
	const outcome = await createAskUserTool().execute(input(), context);
	expect(JSON.parse(outcome.output)).toEqual({ status: "unavailable", reason: "no_interactive_client" });
});
