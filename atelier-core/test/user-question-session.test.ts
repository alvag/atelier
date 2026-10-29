import { expect, it, vi } from "vitest";
import {
	type AskUser,
	type AtelierEvent,
	FakeBackend,
	type FakeStep,
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
