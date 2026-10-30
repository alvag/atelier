import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEventBody,
	decodeClientMessage,
	decodeServerMessage,
	FakeBackend,
	type FakeStep,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";

const end: AtelierEventBody = {
	type: "turn_finished",
	stopReason: "end_turn",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
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
const turn: FakeStep[] = [call, { event: end }];

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-rpc-questions-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function serve(...backends: FakeStep[][][]) {
	let created = 0;
	const made: FakeBackend[] = [];
	const stream = new PassThrough();
	const messages: ServerMessage[] = [];
	const server = new RpcServer({
		input: stream,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend: (name) => {
			const backend = new FakeBackend(backends[Math.min(created++, backends.length - 1)] ?? [turn], name);
			made.push(backend);
			return backend;
		},
		tools: [],
		systemPromptAppend: "",
		home,
	});
	const done = server.run();
	let next = 0;
	const wait = async <T>(find: () => T | undefined): Promise<T> => {
		for (let i = 0; i < 400; i++) {
			const found = find();
			if (found !== undefined) return found;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("Timed out");
	};
	const ask = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		stream.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		return await wait(
			() => messages.find((m) => m.type === "response" && m.id === id) as Extract<ServerMessage, { type: "response" }>,
		);
	};
	const events = (sessionId: string) =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	const eventOf = (sessionId: string, type: string) => wait(() => events(sessionId).find((e) => e.type === type));
	const open = async (extra: Record<string, unknown> = {}) => {
		const response = await ask({ command: "session.start", cwd: home, ...extra });
		return (response as unknown as { result: { sessionId: string } }).result.sessionId;
	};
	const send = async (sessionId: string) =>
		expect((await ask({ command: "session.send", sessionId, prompt: "go" })).ok).toBe(true);
	const close = () => {
		stream.end();
		return done;
	};
	return { ask, open, send, events, eventOf, close, made };
}

const answer = (sessionId: string, answers: unknown, callId = "choice-1") => ({
	command: "session.answer_user",
	sessionId,
	callId,
	answers,
});
const pick = [{ questionId: "q1", optionId: "b" }];

describe("session.answer_user", () => {
	it("asks through the opted-in channel and a valid answer resolves the call", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		expect(await h.eventOf(sessionId, "user_question_requested")).toMatchObject({ callId: "choice-1" });
		expect(await h.ask(answer(sessionId, pick))).toMatchObject({ ok: true, result: {} });
		expect(await h.eventOf(sessionId, "user_question_resolved")).toMatchObject({
			callId: "choice-1",
			result: { status: "answered", answers: pick },
		});
		await h.eventOf(sessionId, "turn_finished");
		await h.close();
	});

	it("null cancels", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		expect((await h.ask(answer(sessionId, null))).ok).toBe(true);
		expect(await h.eventOf(sessionId, "user_question_resolved")).toMatchObject({
			result: { status: "cancelled", reason: "user" },
		});
		await h.close();
	});

	it("an invalid answer fails with invalid_answer and leaves the question live", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		expect(await h.ask(answer(sessionId, [{ questionId: "q1", optionId: "zzz" }]))).toMatchObject({
			ok: false,
			error: { code: "invalid_answer" },
		});
		expect(h.events(sessionId).some((e) => e.type === "user_question_resolved")).toBe(false);
		expect((await h.ask(answer(sessionId, pick))).ok).toBe(true);
		await h.eventOf(sessionId, "user_question_resolved");
		await h.close();
	});

	it("a stale duplicate or unknown call fails with unknown_question", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		expect(await h.ask(answer(sessionId, pick, "other"))).toMatchObject({ error: { code: "unknown_question" } });
		expect((await h.ask(answer(sessionId, pick))).ok).toBe(true);
		expect(await h.ask(answer(sessionId, pick))).toMatchObject({ error: { code: "unknown_question" } });
		await h.close();
	});

	it("an unknown session fails with unknown_session", async () => {
		const h = serve();
		expect(await h.ask(answer("nope", pick))).toMatchObject({ error: { code: "unknown_session" } });
		await h.close();
	});

	it.each([
		["absent", {}],
		["false", { userQuestions: false }],
	])("without the capability (%s) the call is unavailable at once", async (_name, extra) => {
		const h = serve();
		const sessionId = await h.open(extra);
		await h.send(sessionId);
		await h.eventOf(sessionId, "turn_finished");
		expect(h.events(sessionId).some((e) => e.type === "user_question_requested")).toBe(false);
		await h.close();
	});

	it("session.resume opts in on its own", async () => {
		const h = serve([[{ event: end }]], [turn]);
		const started = (await h.ask({ command: "session.start", cwd: home })) as unknown as {
			result: { sessionId: string; savedId: string };
		};
		const first = started.result.sessionId;
		await h.send(first);
		await h.eventOf(first, "turn_finished");
		const saved = started;
		await h.ask({ command: "session.close", sessionId: first });
		const resumed = (await h.ask({
			command: "session.resume",
			sessionId: saved.result.savedId,
			cwd: home,
			userQuestions: true,
		})) as unknown as { ok: boolean; result: { sessionId: string } };
		expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
		await h.send(resumed.result.sessionId);
		await h.eventOf(resumed.result.sessionId, "user_question_requested");
		await h.close();
	});

	it("an interrupt supersedes or cancels the pending question", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		await h.ask({ command: "session.interrupt", sessionId });
		expect(await h.eventOf(sessionId, "user_question_resolved")).toMatchObject({
			result: { status: "cancelled", reason: "interrupted" },
		});
		expect(await h.ask(answer(sessionId, pick))).toMatchObject({ error: { code: "unknown_question" } });
		await h.close();
	});

	it("closing the session cancels the pending question", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		await h.ask({ command: "session.close", sessionId });
		expect(h.events(sessionId).find((e) => e.type === "user_question_resolved")).toMatchObject({
			result: { status: "cancelled", reason: "closed" },
		});
		await h.close();
	});

	it("input disconnect closes pending questions", async () => {
		const h = serve();
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		await h.close();
		expect(h.events(sessionId).find((e) => e.type === "user_question_resolved")).toMatchObject({
			result: { status: "cancelled", reason: "closed" },
		});
	});
});

describe("multi-select questions", () => {
	const checks = {
		id: "checks",
		question: "Which checks?",
		multiSelect: true,
		options: [
			{ id: "biome", label: "Biome" },
			{ id: "tsc", label: "TypeScript" },
		],
	};
	const multiTurn: FakeStep[] = [
		{ toolCall: { callId: "choice-1", tool: "ask_user", input: { questions: [checks] } } },
		{ event: end },
	];
	/** The `ask_user` tool's schema as the model gets it, from the session's last backend. */
	const schemaOf = (h: ReturnType<typeof serve>) =>
		JSON.stringify(
			z.toJSONSchema(
				z.object(h.made.at(-1)?.startOptions?.tools.find((tool) => tool.name === "ask_user")?.inputShape ?? {}),
			),
		);

	it("asks them of a client that opted in with { multiSelect: true } and takes optionIds", async () => {
		const h = serve([multiTurn]);
		const sessionId = await h.open({ userQuestions: { multiSelect: true } });
		await h.send(sessionId);
		expect(await h.eventOf(sessionId, "user_question_requested")).toMatchObject({ questions: [checks] });
		expect(schemaOf(h)).toContain("multiSelect");
		const wrong = await h.ask(answer(sessionId, [{ questionId: "checks", optionIds: ["biome", "biome"] }]));
		expect(wrong).toMatchObject({ ok: false, error: { code: "invalid_answer" } });
		const checked = [{ questionId: "checks", optionIds: ["tsc"], other: "docs" }];
		expect(await h.ask(answer(sessionId, checked))).toMatchObject({ ok: true, result: {} });
		expect(await h.eventOf(sessionId, "user_question_resolved")).toMatchObject({
			result: { status: "answered", answers: checked },
		});
		await h.eventOf(sessionId, "turn_finished");
		expect(JSON.parse(h.made.at(-1)?.toolResults[0]?.output ?? "")).toEqual({
			status: "answered",
			answers: [{ ...checked[0], labels: ["TypeScript"] }],
		});
		await h.close();
	});

	it("refuses every wrong answer form before resolving, then takes nothing checked", async () => {
		const h = serve([multiTurn]);
		const sessionId = await h.open({ userQuestions: { multiSelect: true } });
		await h.send(sessionId);
		await h.eventOf(sessionId, "user_question_requested");
		const reply = (form: Record<string, unknown>) => h.ask(answer(sessionId, [{ questionId: "checks", ...form }]));
		expect(await reply({ optionId: "biome", optionIds: ["biome"] })).toMatchObject({
			ok: false,
			error: { code: "invalid_command" },
		});
		expect(h.events(sessionId).some((e) => e.type === "user_question_resolved")).toBe(false);
		for (const form of [
			{ optionId: "biome" },
			{ other: "custom" },
			{ optionIds: ["biome", "biome"] },
			{ optionIds: ["missing"] },
		]) {
			expect(await reply(form), JSON.stringify(form)).toMatchObject({ ok: false, error: { code: "invalid_answer" } });
			expect(h.events(sessionId).some((e) => e.type === "user_question_resolved")).toBe(false);
		}
		expect(await reply({ optionIds: [] })).toMatchObject({ ok: true, result: {} });
		expect(await h.eventOf(sessionId, "user_question_resolved")).toMatchObject({
			result: { status: "answered", answers: [{ questionId: "checks", optionIds: [] }] },
		});
		await h.eventOf(sessionId, "turn_finished");
		expect(JSON.parse(h.made.at(-1)?.toolResults[0]?.output ?? "")).toEqual({
			status: "answered",
			answers: [{ questionId: "checks", optionIds: [], labels: [] }],
		});
		await h.close();
	});

	it("never sends one to a client of today's userQuestions: true, and refuses its optionIds", async () => {
		const h = serve([[...multiTurn.slice(0, 1), call, { event: end }]]);
		const sessionId = await h.open({ userQuestions: true });
		await h.send(sessionId);
		expect(await h.eventOf(sessionId, "user_question_requested")).toMatchObject({ questions: input.questions });
		expect(h.events(sessionId).filter((e) => e.type === "user_question_requested")).toHaveLength(1);
		expect(schemaOf(h)).not.toContain("multiSelect");
		expect(await h.ask(answer(sessionId, [{ questionId: "q1", optionIds: ["b"] }]))).toMatchObject({
			ok: false,
			error: { code: "invalid_answer" },
		});
		expect(h.events(sessionId).some((e) => e.type === "user_question_resolved")).toBe(false);
		expect((await h.ask(answer(sessionId, pick))).ok).toBe(true);
		await h.eventOf(sessionId, "turn_finished");
		await h.close();
	});

	it("session.resume asks for them again on its own", async () => {
		const h = serve([[{ event: end }]], [multiTurn]);
		const started = (await h.ask({ command: "session.start", cwd: home, userQuestions: true })) as unknown as {
			result: { sessionId: string; savedId: string };
		};
		await h.send(started.result.sessionId);
		await h.eventOf(started.result.sessionId, "turn_finished");
		await h.ask({ command: "session.close", sessionId: started.result.sessionId });
		const resumed = (await h.ask({
			command: "session.resume",
			sessionId: started.result.savedId,
			cwd: home,
			userQuestions: { multiSelect: true },
		})) as unknown as { ok: boolean; result: { sessionId: string } };
		expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
		await h.send(resumed.result.sessionId);
		expect(await h.eventOf(resumed.result.sessionId, "user_question_requested")).toMatchObject({
			questions: [checks],
		});
		await h.close();
	});
});

describe("session.answer_user codec", () => {
	const decode = (value: Record<string, unknown>) =>
		decodeClientMessage(JSON.stringify({ type: "command", id: "1", command: "session.answer_user", ...value })).ok;
	const base = { sessionId: "s", callId: "c" };
	const other = { questionId: "q", other: "text" };

	it("takes one answer per question or null", () => {
		expect(decode({ ...base, answers: null })).toBe(true);
		expect(decode({ ...base, answers: [{ questionId: "q", optionId: "a" }, other] })).toBe(true);
	});

	it.each([
		["missing answers", {}],
		["empty batch", { answers: [] }],
		["five answers", { answers: Array.from({ length: 5 }, () => other) }],
		["both forms", { answers: [{ questionId: "q", optionId: "a", other: "x" }] }],
		["neither form", { answers: [{ questionId: "q" }] }],
		["blank other", { answers: [{ questionId: "q", other: "  " }] }],
		["long other", { answers: [{ questionId: "q", other: "x".repeat(2001) }] }],
		["long id", { answers: [{ questionId: "q".repeat(65), optionId: "a" }] }],
		["extra key", { answers: [{ ...other, extra: 1 }] }],
		["empty callId", { callId: "", answers: null }],
	])("rejects %s", (_name, extra) => {
		expect(decode({ ...base, ...extra })).toBe(false);
	});

	it("takes a multi-select answer, none checked included", () => {
		expect(decode({ ...base, answers: [{ questionId: "q", optionIds: [] }] })).toBe(true);
		expect(decode({ ...base, answers: [{ questionId: "q", optionIds: ["a", "b"], other: "x" }] })).toBe(true);
	});

	it.each([
		["optionId with optionIds", { questionId: "q", optionId: "a", optionIds: ["a"] }],
		["five optionIds", { questionId: "q", optionIds: ["a", "b", "c", "d", "e"] }],
		["a blank optionId among them", { questionId: "q", optionIds: [" "] }],
		["optionIds that are not a list", { questionId: "q", optionIds: "a" }],
		["blank other with them", { questionId: "q", optionIds: [], other: " " }],
	])("rejects %s", (_name, entry) => {
		expect(decode({ ...base, answers: [entry] })).toBe(false);
	});

	it.each(["session.start", "session.resume"])(
		"accepts userQuestions on %s as a boolean or the capabilities, and nothing it does not know",
		(command) => {
			const open = (userQuestions: unknown) =>
				decodeClientMessage(
					JSON.stringify({ type: "command", id: "1", command, sessionId: "saved", cwd: "/", userQuestions }),
				).ok;
			for (const accepted of [true, false, {}, { multiSelect: true }, { multiSelect: false }])
				expect(open(accepted), JSON.stringify(accepted)).toBe(true);
			for (const refused of ["yes", null, { multiSelect: "yes" }, { preview: true }])
				expect(open(refused), JSON.stringify(refused)).toBe(false);
		},
	);
});
