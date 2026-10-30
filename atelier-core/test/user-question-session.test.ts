import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type AskUser,
	type AtelierEvent,
	FakeBackend,
	type FakeStep,
	PermissionRules,
	Session,
	type SessionOptions,
} from "../src/index.ts";

const input = {
	questions: [
		{
			id: "q1",
			question: "Which?",
			options: [
				{ id: "a", label: "A", recommended: true },
				{ id: "b", label: "B" },
			],
		},
	],
};
const call: FakeStep = { toolCall: { callId: "choice-1", tool: "ask_user", input } };
const end: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
};
const answered = { status: "answered" as const, answers: [{ questionId: "q1", other: "C" }] };
async function start(options: Partial<SessionOptions> = {}) {
	const backend = options.backend instanceof FakeBackend ? options.backend : new FakeBackend([[call, end]]);
	const session = await Session.start({ backend, cwd: process.cwd(), tools: [], ...options });
	const events: AtelierEvent[] = [];
	const done = (async () => {
		for await (const event of session.send("go")) events.push(event);
	})();
	return { session, backend, events, done };
}
async function until(condition: () => boolean) {
	await vi.waitUntil(condition, { timeout: 2000, interval: 1 });
}

it.each(["normal", "auto", "yolo"] as const)(
	"asks only the user in %s and returns their Other answer",
	async (permissionMode) => {
		const ask = vi.fn<AskUser>().mockResolvedValue(answered);
		const { session, backend, events, done } = await start({ permissionMode, askUser: ask });
		await done;
		expect(ask).toHaveBeenCalledOnce();
		expect(backend.toolResults[0]).toMatchObject({ ok: true, output: JSON.stringify(answered) });
		expect(events.filter((e) => e.type.startsWith("user_question_"))).toMatchObject([
			{ type: "user_question_requested", callId: "choice-1", questions: input.questions },
			{ type: "user_question_resolved", callId: "choice-1", result: answered },
		]);
		expect(events.some((e) => e.type === "approval_requested" || e.type === "permission_classified")).toBe(false);
		await session.close();
	},
);

it("registers before emitting, validates before consuming and rejects stale and duplicate replies", async () => {
	const { session, backend, events, done } = await start({ userQuestions: true });
	await until(() => events.some((e) => e.type === "user_question_requested"));
	expect(() => session.answerUser("choice-1", [])).toThrow();
	expect(() => session.answerUser("choice-1", [{ questionId: "q1", optionId: "missing" }])).toThrow();
	session.answerUser("choice-1", answered.answers);
	expect(() => session.answerUser("choice-1", answered.answers)).toThrow(/pending/);
	await done;
	expect(backend.toolResults[0]?.ok).toBe(true);
	await session.close();
});

it.each(["steer", "follow_up"] as const)(
	"supersedes a pending batch on a new %s without losing the message",
	async (kind) => {
		let signal: AbortSignal | undefined;
		let late: ((result: typeof answered) => void) | undefined;
		const askUser: AskUser = (_questions, context) => {
			signal = context.signal;
			return new Promise((resolve) => {
				late = resolve;
			});
		};
		const { session, backend, events, done } = await start({ askUser });
		await until(() => signal !== undefined);
		session.queue(kind, "new request");
		late?.(answered);
		await done;
		expect(signal?.aborted).toBe(true);
		expect(JSON.parse(backend.toolResults[0]?.output ?? "")).toEqual({ status: "superseded" });
		expect(events.filter((e) => e.type === "user_question_resolved")).toHaveLength(1);
		if (kind === "steer") expect(backend.toolResults[0]?.steering).toContain("new request");
		else expect(session.queued[0]?.text).toBe("new request");
		await session.close();
	},
);

it.each(["interrupt", "close", "cancel"] as const)(
	"settles a silent user on %s and invalidates the question",
	async (action) => {
		const { session, backend, events, done } = await start({ userQuestions: true });
		await until(() => events.some((e) => e.type === "user_question_requested"));
		if (action === "cancel") session.answerUser("choice-1", null);
		else await session[action]();
		await done;
		expect(JSON.parse(backend.toolResults[0]?.output ?? "")).toEqual({
			status: "cancelled",
			reason: action === "cancel" ? "user" : action === "close" ? "closed" : "interrupted",
		});
		expect(() => session.answerUser("choice-1", answered.answers)).toThrow(/pending/);
		await session.close();
	},
);

it("never registers a question after closing during a permission-rules read", async () => {
	const permissionRules = new PermissionRules();
	const empty = { bash: [], projectBash: [], paths: [] };
	let release!: () => void;
	const reading = new Promise<void>((resolve) => {
		release = resolve;
	});
	const current = vi
		.spyOn(permissionRules, "current")
		.mockResolvedValue(empty)
		.mockResolvedValueOnce(empty)
		.mockImplementationOnce(async () => {
			await reading;
			return empty;
		});
	const askUser = vi.fn<AskUser>().mockResolvedValue(answered);
	const { session, backend, events, done } = await start({ permissionRules, askUser });
	await until(() => events.some((event) => event.type === "tool_call_started") && current.mock.calls.length === 2);
	await session.close();
	release();
	await done;
	expect(events.filter((event) => event.type === "user_question_requested")).toHaveLength(0);
	expect(askUser).not.toHaveBeenCalled();
	expect(backend.toolResults[0]).toMatchObject({
		ok: false,
		output: JSON.stringify({ status: "cancelled", reason: "closed" }),
	});
});

it("returns unavailable without an interactive channel", async () => {
	const { session, backend, done } = await start();
	await done;
	expect(JSON.parse(backend.toolResults[0]?.output ?? "")).toEqual({
		status: "unavailable",
		reason: "no_interactive_client",
	});
	await session.close();
});

it("accepts a reply immediately from the request event", async () => {
	const backend = new FakeBackend([[call, end]]);
	const session = await Session.start({ backend, cwd: process.cwd(), tools: [], userQuestions: true });
	for await (const event of session.send("go")) {
		if (event.type === "user_question_requested") session.answerUser(event.callId, answered.answers);
	}
	expect(JSON.parse(backend.toolResults[0]?.output ?? "")).toEqual(answered);
	await session.close();
});

it("settles the question when its event consumer leaves", async () => {
	const backend = new FakeBackend([[call, end]]);
	const session = await Session.start({ backend, cwd: process.cwd(), tools: [], userQuestions: true });
	for await (const event of session.send("go")) if (event.type === "user_question_requested") break;
	expect(JSON.parse(backend.toolResults[0]?.output ?? "")).toEqual({ status: "cancelled", reason: "interrupted" });
	await session.close();
});

it("refuses a concurrent batch while preserving the first", async () => {
	const backend = new FakeBackend([
		[
			{
				run: async () => {
					const execute = backend.startOptions?.executeTool;
					if (!execute) throw new Error("No executor");
					backend.toolResults.push(
						...(await Promise.all([
							execute({ tool: "ask_user", callId: "first", input }),
							execute({ tool: "ask_user", callId: "second", input }),
						])),
					);
				},
			},
			end,
		],
	]);
	const { session, events, done } = await start({ backend, userQuestions: true });
	await until(() => events.some((e) => e.type === "tool_call_finished" && e.callId === "second"));
	session.answerUser("first", answered.answers);
	await done;
	expect(JSON.parse(backend.toolResults[1]?.output ?? "")).toEqual({
		status: "unavailable",
		reason: "question_pending",
	});
	expect(events.filter((e) => e.type === "user_question_requested")).toHaveLength(1);
	await session.close();
});

describe("multi-select questions", () => {
	const checks = {
		id: "checks",
		question: "Which checks?",
		multiSelect: true,
		options: [
			{ id: "biome", label: "Biome", recommended: true },
			{ id: "tsc", label: "TypeScript" },
		],
	};
	const multiCall: FakeStep = { toolCall: { callId: "choice-1", tool: "ask_user", input: { questions: [checks] } } };
	const schemaOf = (backend: FakeBackend) =>
		JSON.stringify(
			z.toJSONSchema(z.object(backend.startOptions?.tools.find((tool) => tool.name === "ask_user")?.inputShape ?? {})),
		);
	const codeOf = (reply: () => void) => {
		try {
			reply();
		} catch (error) {
			return (error as { code?: string }).code;
		}
	};

	it("answers with the options checked when the client asked for them, and refuses the wrong forms", async () => {
		const backend = new FakeBackend([[multiCall, end]]);
		const { session, events, done } = await start({ backend, userQuestions: { multiSelect: true } });
		await until(() => events.some((e) => e.type === "user_question_requested"));
		expect(schemaOf(backend)).toContain("multiSelect");
		for (const wrong of [
			{ questionId: "checks", optionId: "biome" },
			{ questionId: "checks", other: "Mine" },
			{ questionId: "checks", optionIds: ["tsc", "tsc"] },
			{ questionId: "checks", optionIds: ["missing"] },
		])
			expect(codeOf(() => session.answerUser("choice-1", [wrong]))).toBe("invalid_answer");
		session.answerUser("choice-1", [{ questionId: "checks", optionIds: ["tsc", "biome"] }]);
		await done;
		expect(JSON.parse(backend.toolResults[0]?.output ?? "")).toEqual({
			status: "answered",
			answers: [{ questionId: "checks", optionIds: ["tsc", "biome"], labels: ["TypeScript", "Biome"] }],
		});
		await session.close();
	});

	it("keeps userQuestions: true single-choice: no multiSelect for the model, no optionIds from the client", async () => {
		const backend = new FakeBackend([[multiCall, call, end]]);
		const { session, events, done } = await start({ backend, userQuestions: true });
		await until(() => events.some((e) => e.type === "user_question_requested"));
		expect(schemaOf(backend)).not.toContain("multiSelect");
		expect(backend.toolResults[0]?.ok).toBe(false);
		const requested = events.filter((e) => e.type === "user_question_requested");
		expect(requested).toMatchObject([{ questions: input.questions }]);
		expect(codeOf(() => session.answerUser("choice-1", [{ questionId: "q1", optionIds: ["a"] }]))).toBe(
			"invalid_answer",
		);
		session.answerUser("choice-1", answered.answers);
		await done;
		expect(JSON.parse(backend.toolResults[1]?.output ?? "")).toEqual(answered);
		await session.close();
	});

	it("reaches a direct callback that declares them, and only that one", async () => {
		const ask = vi.fn<AskUser>().mockResolvedValue({
			status: "answered",
			answers: [{ questionId: "checks", optionIds: [] }],
		});
		const declared = await start({
			backend: new FakeBackend([[multiCall, end]]),
			askUser: ask,
			userQuestions: { multiSelect: true },
		});
		await declared.done;
		expect(ask).toHaveBeenCalledExactlyOnceWith([checks], expect.anything());
		expect(JSON.parse(declared.backend.toolResults[0]?.output ?? "")).toMatchObject({
			answers: [{ optionIds: [], labels: [] }],
		});
		await declared.session.close();
		const plain = await start({ backend: new FakeBackend([[multiCall, end]]), askUser: ask });
		await plain.done;
		expect(schemaOf(plain.backend)).not.toContain("multiSelect");
		expect(ask).toHaveBeenCalledOnce();
		expect(plain.backend.toolResults[0]?.ok).toBe(false);
		await plain.session.close();
	});
});

it("never offers ask_user to a custom subagent requesting it", async () => {
	const child = new FakeBackend([[call, end]]);
	const backend = new FakeBackend([[{ toolCall: { tool: "task", input: { agent: "custom", prompt: "go" } } }, end]]);
	const { session, done } = await start({
		backend,
		userQuestions: true,
		subagents: {
			agents: [
				{ name: "custom", description: "test", tools: ["ask_user"], prompt: "test", models: {}, maxRequests: 2 },
			],
			createBackend: () => child,
		},
	});
	await done;
	expect(child.startOptions?.tools.some((tool) => tool.name === "ask_user")).toBe(false);
	expect(child.toolResults[0]).toMatchObject({ ok: false, output: "Unknown tool: ask_user" });
	await session.close();
});
