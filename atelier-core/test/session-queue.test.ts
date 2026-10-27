import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	Session,
	SessionStore,
} from "../src/index.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const toolCall = (callId: string): FakeStep => ({ toolCall: { tool: "nope", input: {}, callId } });

let cwd: string;
beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-queue-")));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

async function collect(events: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
	const all: AtelierEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

/** A session whose scripted turns can reach it, to queue messages while they run. */
async function started(script: (session: () => Session) => FakeStep[][], home?: string) {
	let session: Session | undefined;
	const backend = new FakeBackend(script(() => session as Session));
	const record = home === undefined ? undefined : new SessionStore(home).create(cwd);
	session = await Session.start({ backend, cwd, tools: [], ...(record === undefined ? {} : { record }) });
	return { backend, session, record };
}

const queueUpdates = (events: AtelierEvent[]) =>
	events.flatMap((event) => (event.type === "queue_update" ? [event] : []));

describe("queued messages", () => {
	it("gives a steer to the backend with the next tool result, says it entered and takes it off the queue", async () => {
		const { backend, session } = await started((session) => [
			[{ run: () => void session().queue("steer", "use tabs") }, toolCall("c1"), toolCall("c2"), { event: finished }],
		]);
		const events = await collect(session.send("go"));

		expect(backend.toolResults[0]?.steering).toContain("use tabs");
		expect(backend.toolResults[1]?.steering).toBeUndefined();
		const entered = events.find((event) => event.type === "queued_message");
		expect(entered).toMatchObject({ kind: "steer", text: "use tabs" });
		expect(queueUpdates(events).map((event) => event.messages.map((message) => message.text))).toEqual([
			["use tabs"],
			[],
		]);
		// It entered after the tool's end and before the turn's.
		const order = events.map((event) => event.type);
		expect(order.indexOf("queued_message")).toBeGreaterThan(order.indexOf("tool_call_finished"));
		expect(session.queued).toEqual([]);
	});

	it("keeps a follow-up for its own turn, which starts by saying it entered", async () => {
		const { backend, session } = await started((session) => [
			[{ run: () => void session().queue("follow_up", "now the docs") }, toolCall("c1"), { event: finished }],
			[{ event: finished }],
		]);
		await collect(session.send("go"));
		expect(backend.toolResults[0]?.steering).toBeUndefined();
		expect(session.queued.map((message) => message.text)).toEqual(["now the docs"]);

		const next = session.nextQueued();
		expect(next).toBeDefined();
		const events = await collect(next as AsyncIterable<AtelierEvent>);
		expect(backend.prompts).toEqual(["go", "now the docs"]);
		const types = events.map((event) => event.type);
		expect(types.indexOf("queued_message")).toBe(0);
		expect(events[0]).toMatchObject({ kind: "follow_up", text: "now the docs" });
		expect(session.queued).toEqual([]);
		expect(session.nextQueued()).toBeUndefined();
	});

	it("runs a steer that found no tool result before the follow-ups, one turn each", async () => {
		const { backend, session } = await started((session) => [
			[
				{ run: () => void session().queue("follow_up", "second") },
				{ run: () => void session().queue("steer", "first") },
				{ event: finished },
			],
			[{ event: finished }],
			[{ event: finished }],
		]);
		await collect(session.send("go"));
		await collect(session.nextQueued() as AsyncIterable<AtelierEvent>);
		await collect(session.nextQueued() as AsyncIterable<AtelierEvent>);
		expect(backend.prompts).toEqual(["go", "first", "second"]);
	});

	it("gives the queue back when the turn is interrupted, and runs none of it", async () => {
		const { session } = await started((session) => [
			[
				{ run: () => void session().queue("steer", "a") },
				{ run: () => void session().queue("follow_up", "b") },
				{ waitForInterrupt: true },
			],
		]);
		const turn = collect(session.send("go"));
		for (let i = 0; i < 400 && session.queued.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2));
		await session.interrupt();
		const events = await turn;

		const last = queueUpdates(events).at(-1);
		expect(last?.messages).toEqual([]);
		expect(last?.returned?.map((message) => [message.kind, message.text])).toEqual([
			["steer", "a"],
			["follow_up", "b"],
		]);
		expect(events.at(-1)?.type).toBe("turn_finished");
		expect(session.queued).toEqual([]);
		expect(session.nextQueued()).toBeUndefined();
	});

	it("edits and removes queued messages until they enter", async () => {
		const { backend, session } = await started((session) => [
			[
				{
					run: () => {
						const one = session().queue("steer", "typo");
						const two = session().queue("follow_up", "drop me");
						session().queue("follow_up", "keep me");
						expect(session().editQueued(one.id, "fixed")).toBe(true);
						expect(
							session()
								.unqueue(two.id)
								.map((message) => message.text),
						).toEqual(["drop me"]);
						expect(session().editQueued("unknown", "x")).toBe(false);
					},
				},
				toolCall("c1"),
				{ run: () => expect(session().editQueued(session().queued[0]?.id ?? "", "late")).toBe(true) },
				{ event: finished },
			],
		]);
		const events = await collect(session.send("go"));
		expect(backend.toolResults[0]?.steering).toContain("fixed");
		expect(session.queued.map((message) => message.text)).toEqual(["late"]);
		expect(queueUpdates(events).length).toBeGreaterThanOrEqual(5);
		expect(session.unqueue().map((message) => message.text)).toEqual(["late"]);
		expect(session.queued).toEqual([]);
	});

	it("saves a steer when it enters and a follow-up as its turn's prompt, never what is still queued", async () => {
		const home = await realpath(await mkdtemp(join(tmpdir(), "atelier-queue-home-")));
		try {
			const { session, record } = await started(
				(session) => [
					[
						{ run: () => void session().queue("steer", "steered") },
						{ run: () => void session().queue("follow_up", "followed") },
						{ run: () => void session().queue("follow_up", "never sent") },
						toolCall("c1"),
						{ event: finished },
					],
					[{ event: finished }],
				],
				home,
			);
			await collect(session.send("go"));
			await collect(session.nextQueued() as AsyncIterable<AtelierEvent>);
			await session.close();
			const saved = (await readFile(record?.path ?? "", "utf8")).split("\n").filter((line) => line !== "");
			const lines = saved.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(saved.join("\n")).not.toContain("never sent");
			expect(lines.filter((line) => line.type === "prompt").map((line) => line.text)).toEqual(["go", "followed"]);
			const entered = lines.flatMap((line) =>
				line.type === "event" && (line.event as { type: string }).type === "queued_message" ? [line.event] : [],
			);
			expect(entered).toEqual([expect.objectContaining({ kind: "steer", text: "steered" })]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
