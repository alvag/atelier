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

describe("multi-select questions", () => {
	const checks = (recommended: boolean[] = [true, true, false]) => ({
		id: "checks",
		question: "Which checks?",
		multiSelect: true,
		options: ["biome", "tsc", "vitest"].map((id, index) => ({
			id,
			label: { biome: "Biome", tsc: "TypeScript", vitest: "Vitest" }[id] as string,
			recommended: recommended[index] ?? false,
		})),
	});
	const schemaOf = (multiSelect: boolean) =>
		JSON.stringify(z.toJSONSchema(z.object(createAskUserTool(undefined, { multiSelect }).inputShape)));

	it("keeps them away from a session that did not ask for them: schema, description and input", async () => {
		expect(schemaOf(false)).not.toContain("multiSelect");
		expect(createAskUserTool(undefined, { multiSelect: false }).description).toBe(createAskUserTool().description);
		expect(createAskUserTool().description).not.toContain("multiSelect");
		for (const multiSelect of [true, false]) {
			const ask = vi.fn<AskUser>();
			const questions = [{ ...question(), multiSelect }];
			await expect(createAskUserTool(ask).execute({ questions }, context)).rejects.toThrow(ToolInputError);
			expect(ask).not.toHaveBeenCalled();
		}
	});

	it("tells the model about them when the session asked for them", () => {
		const tool = createAskUserTool(undefined, { multiSelect: true });
		expect(tool.description).toContain(
			"A question takes one answer unless multiSelect: true lets the user check any number of its options, or none. " +
				"Mark exactly one option of a single-choice question recommended: true, and any number, or none, of a multi-select one;",
		);
		expect(schemaOf(true)).toContain("multiSelect");
	});

	it.each([[[false, false, false]], [[true, true, false]], [[true, true, true]]])(
		"accepts %j recommended in a multi-select question",
		async (recommended) => {
			const ask = vi.fn<AskUser>().mockResolvedValue({ status: "cancelled", reason: "user" });
			const questions = [checks(recommended)];
			await createAskUserTool(ask, { multiSelect: true }).execute({ questions }, context);
			expect(ask).toHaveBeenCalledExactlyOnceWith(questions, context);
		},
	);

	it.each([[[false, false]], [[true, true]]])(
		"still wants one recommended of a single-choice question, not %j",
		async (flags) => {
			const ask = vi.fn<AskUser>();
			const options = question().options.map((option, index) => ({ ...option, recommended: flags[index] }));
			for (const multiSelect of [false, undefined]) {
				const questions = [{ ...question(), options, ...(multiSelect === undefined ? {} : { multiSelect }) }];
				await expect(createAskUserTool(ask, { multiSelect: true }).execute({ questions }, context)).rejects.toThrow(
					ToolInputError,
				);
			}
			expect(ask).not.toHaveBeenCalled();
		},
	);

	it("returns the options checked, none included, with their labels and the user's own text", async () => {
		const questions = [checks(), { ...checks(), id: "extras" }, question()];
		const answers = [
			{ questionId: "checks", optionIds: ["biome", "tsc"], other: " also docs " },
			{ questionId: "extras", optionIds: [] },
			{ questionId: "q1", optionId: "a" },
		];
		const tool = createAskUserTool(async () => ({ status: "answered", answers }), { multiSelect: true });
		const outcome = await tool.execute({ questions }, context);
		expect(outcome).toMatchObject({ ok: true, summary: "User answered 3 questions." });
		expect(JSON.parse(outcome.output)).toEqual({
			status: "answered",
			answers: [
				{ ...answers[0], labels: ["Biome", "TypeScript"] },
				{ ...answers[1], labels: [] },
				{ ...answers[2], label: "Minimal change" },
			],
		});
	});

	it.each([
		["several options for a single-choice question", "q1", { optionIds: ["a", "b"] }],
		["no option for a single-choice question", "q1", { optionIds: [] }],
		["one optionId for a multi-select question", "checks", { optionId: "biome" }],
		["bare Other for a multi-select question", "checks", { other: "Mine" }],
		["a repeated option", "checks", { optionIds: ["biome", "biome"] }],
		["an unknown option", "checks", { optionIds: ["biome", "missing"] }],
		["blank Other", "checks", { optionIds: [], other: " " }],
		["both optionId and optionIds", "checks", { optionId: "biome", optionIds: ["biome"] }],
	])("rejects %s", (_name, questionId, form) => {
		const questions = [question(), checks()];
		const answers = questions.map((entry) =>
			entry.id === questionId
				? { questionId, ...form }
				: entry.id === "q1"
					? { questionId: "q1", optionId: "a" }
					: { questionId: entry.id, optionIds: [] },
		);
		expect(() => parseUserAnswers(questions, answers)).toThrow();
	});
});

describe("option previews", () => {
	const SNIPPET = 'web_fetch("http://10.0.0.1")\n→ Error: refused to fetch a private or internal address';
	const previewed = (preview: string) => ({
		...question(),
		options: question().options.map((option, index) => (index === 0 ? { ...option, preview } : option)),
	});
	const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
	const schemaOf = (capabilities: Parameters<typeof createAskUserTool>[1]) =>
		JSON.stringify(z.toJSONSchema(z.object(createAskUserTool(undefined, capabilities).inputShape)));

	it("keeps them away from a session that did not ask for them: schema, description and input", async () => {
		for (const capabilities of [{}, { multiSelect: true }, { preview: false }]) {
			expect(schemaOf(capabilities)).not.toContain("preview");
			expect(createAskUserTool(undefined, capabilities).description).not.toContain("preview");
			const ask = vi.fn<AskUser>();
			await expect(
				createAskUserTool(ask, capabilities).execute({ questions: [previewed(SNIPPET)] }, context),
			).rejects.toThrow(ToolInputError);
			expect(ask).not.toHaveBeenCalled();
		}
		expect(createAskUserTool(undefined, { preview: false }).description).toBe(createAskUserTool().description);
	});

	it("tells the model about them when the session asked for them, with or without multi-select questions", () => {
		expect(createAskUserTool(undefined, { preview: true }).description).toContain(
			"Each option may include a nonblank description of up to 300 characters. " +
				"It may also include a preview of up to 1500 characters and 20 lines, such as a code snippet, a config fragment or a layout sketch, which the user sees while on that option. " +
				"Every question also offers Other...",
		);
		expect(createAskUserTool(undefined, { multiSelect: true, preview: true }).description).toContain(
			"Each option may include a nonblank description of up to 300 characters. " +
				"An option of a single-choice question may also include a preview of up to 1500 characters and 20 lines, such as a code snippet, a config fragment or a layout sketch, which the user sees while on that option; a multi-select question takes none. " +
				"Every question also offers Other...",
		);
		expect(schemaOf({ preview: true })).toContain("preview");
		expect(schemaOf({ multiSelect: true, preview: true })).toContain("preview");
	});

	it.each([
		["1500 characters", "x".repeat(1500)],
		["20 lines", lines(20)],
		["20 lines and a final newline", `${lines(20)}\n`],
		["a code snippet", SNIPPET],
	])("passes a preview of %s to the user callback as written", async (_name, preview) => {
		const ask = vi.fn<AskUser>().mockResolvedValue({ status: "cancelled", reason: "user" });
		const questions = [previewed(preview)];
		await createAskUserTool(ask, { preview: true }).execute({ questions }, context);
		expect(ask).toHaveBeenCalledExactlyOnceWith(questions, context);
	});

	it.each([
		["1501 characters", "x".repeat(1501), ""],
		["21 lines", lines(21), "A preview may have at most 20 lines"],
		["an empty preview", "", ""],
		["a blank preview", " \n ", ""],
	])("rejects %s before asking anyone", async (_name, preview, message) => {
		const ask = vi.fn<AskUser>();
		await expect(
			createAskUserTool(ask, { preview: true }).execute({ questions: [previewed(preview)] }, context),
		).rejects.toThrow(message);
		expect(ask).not.toHaveBeenCalled();
	});

	it("refuses a preview in a multi-select question, saying why, and takes it in a single-choice one", async () => {
		const ask = vi.fn<AskUser>().mockResolvedValue({ status: "cancelled", reason: "user" });
		const tool = createAskUserTool(ask, { multiSelect: true, preview: true });
		const multi = { ...previewed(SNIPPET), id: "q2", multiSelect: true };
		await expect(tool.execute({ questions: [previewed(SNIPPET), multi] }, context)).rejects.toThrow(
			"preview is only for single-choice questions: remove it from the options of a multiSelect question",
		);
		expect(ask).not.toHaveBeenCalled();
		const questions = [previewed(SNIPPET), { ...multi, options: question().options }];
		await tool.execute({ questions }, context);
		expect(ask).toHaveBeenCalledExactlyOnceWith(questions, context);
	});

	it("tells the model the same answer as without a preview", async () => {
		const answers = [{ questionId: "q1", optionId: "a" }];
		const outcome = await createAskUserTool(async () => ({ status: "answered", answers }), { preview: true }).execute(
			{ questions: [previewed(SNIPPET)] },
			context,
		);
		expect(JSON.parse(outcome.output)).toEqual({
			status: "answered",
			answers: [{ questionId: "q1", optionId: "a", label: "Minimal change" }],
		});
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
