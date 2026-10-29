import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	FakeMemory,
	type FakeStep,
	type FrozenProfile,
	freezeProfile,
	Session,
	type SessionOptions,
} from "../src/index.ts";

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.5 };
const SUMMARY = "## Goal\n- carried";
const CARRIED = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${SUMMARY}\n</summary>`;

let base: string;
beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-backend-")));
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function drain(session: Session, prompt = "go"): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of session.send(prompt)) events.push(event);
	return events;
}

const configured = (events: AtelierEvent[]) => events.filter((event) => event.type === "session_configured");
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
};

async function start(turns: FakeStep[][], options: Partial<SessionOptions> = {}) {
	const backend = new FakeBackend(turns);
	const session = await Session.start({ backend, cwd: base, tools: [], ...options });
	return { backend, session };
}

/** A session with one finished turn behind it, so there is a conversation to carry. */
async function started(options: Partial<SessionOptions> = {}, next: FakeStep[][] = [[{ event: finished }]]) {
	const old = await start([[{ event: finished }]], options);
	await drain(old.session, "first");
	return { ...old, next: new FakeBackend(next, "anthropic-api") };
}

describe("Session.setBackend", () => {
	it("sends the next turn to the new backend, with the summary in its first input, and closes the old one", async () => {
		const { backend, session, next } = await started({ model: "opus", thinking: "high" });
		const result = await session.setBackend(next, "claude-sonnet-5-5");
		expect(result).toEqual({
			backend: "anthropic-api",
			model: "claude-sonnet-5-5",
			thinking: "high",
			effort: "high",
			permissionMode: "normal",
			pending: false,
			backendChange: { from: "fake", summarized: true },
		});
		expect(backend.calls).toEqual(["send", "summarize"]);
		expect(backend.closed).toBe(true);
		expect(next.startOptions?.model).toBe("claude-sonnet-5-5");
		expect(next.startOptions?.thinking).toBe("high");

		const events = await drain(session, "second");
		expect(next.prompts).toEqual([`${CARRIED}\n\nsecond`]);
		expect(backend.prompts).toEqual(["first"]);
		expect(events[0]).toMatchObject({
			type: "session_configured",
			backend: "anthropic-api",
			model: "claude-sonnet-5-5",
			backendChange: { from: "fake", summarized: true },
		});
		expect(configured(events)).toHaveLength(1);

		// The summary is given once: the turn after it is the prompt alone.
		await drain(session, "third");
		expect(next.prompts.at(-1)).toBe("third");
		expect(configured(await drain(session, "fourth"))).toEqual([]);
	});

	it("starts the new backend with the session's folder, tools and prompt append, and the backend's default model", async () => {
		const { backend, session, next } = await started({ systemPromptAppend: "be brief" });
		await session.setBackend(next);
		expect(next.startOptions).toMatchObject({
			cwd: base,
			systemPromptAppend: backend.startOptions?.systemPromptAppend,
			tools: backend.startOptions?.tools,
		});
		expect(next.startOptions).not.toHaveProperty("model");
		expect(next.startOptions?.systemPromptAppend).toBe("be brief");
	});

	it("takes the profile's orchestrator model when none is given, and keeps a given one over it", async () => {
		await mkdir(join(base, ".atelier"), { recursive: true });
		await writeFile(
			join(base, ".atelier", "profiles.json"),
			JSON.stringify({
				kind: "atelier.agent_model_profiles",
				version: 1,
				active: "p",
				profiles: { p: { orchestrator: { model: "anthropic-api/claude-haiku-5-5", thinking: "low" } } },
			}),
		);
		const profile: FrozenProfile = await freezeProfile({ cwd: base, home: base, pins: {}, choice: "p" });
		const first = await started({ profile });
		expect(await first.session.setBackend(first.next)).toMatchObject({
			backend: "anthropic-api",
			model: "claude-haiku-5-5",
		});
		expect(first.next.startOptions).toMatchObject({ model: "claude-haiku-5-5" });
		const second = await started({ profile });
		expect(await second.session.setBackend(second.next, "claude-opus-5-5")).toMatchObject({
			model: "claude-opus-5-5",
		});
	});

	it("configures the new backend, not the old one, after the change", async () => {
		const { session, next } = await started();
		await session.setBackend(next, "claude-opus-5-5");
		await session.configure({ thinking: "max" });
		expect(next.configured).toEqual([{ thinking: "max" }]);
	});

	it("holds the change while a turn runs and switches when it ends, saying so in that turn", async () => {
		const old = new FakeBackend([[{ waitForInterrupt: true }]]);
		const running = await Session.start({ backend: old, cwd: base, tools: [] });
		const next = new FakeBackend([[{ event: finished }]], "anthropic-api");
		const turn = drain(running);
		await until(() => running.busy);
		const result = await running.setBackend(next, "claude-opus-5-5");
		expect(result).toMatchObject({
			backend: "anthropic-api",
			model: "claude-opus-5-5",
			pending: true,
			backendChange: { from: "fake", summarized: true },
		});
		expect(old.calls).toEqual(["send"]);
		expect(next.startOptions).toBeUndefined();
		await running.interrupt();
		const events = await turn;
		expect(old.calls).toEqual(["send", "summarize"]);
		expect(old.closed).toBe(true);
		expect(events.map((event) => event.type).slice(-2)).toEqual(["session_configured", "turn_finished"]);
		expect(configured(events)).toMatchObject([{ backend: "anthropic-api", backendChange: { from: "fake" } }]);
		await drain(running, "after");
		expect(next.prompts).toEqual([`${CARRIED}\n\nafter`]);
	});

	it("a prompt sent while the change is being made goes to the new backend", async () => {
		const { session, next } = await started({}, [[{ event: finished }]]);
		const changing = session.setBackend(next);
		const events = await drain(session, "meanwhile");
		await changing;
		expect(next.prompts).toEqual([`${CARRIED}\n\nmeanwhile`]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished" });
	});

	it("keeps the old backend when the summary fails, and says why", async () => {
		const { backend, session, next } = await started({}, []);
		backend.summary = "model overloaded";
		await expect(session.setBackend(next)).rejects.toMatchObject({
			code: "summary_failed",
			message: "The summary of the conversation could not be made, so the session stays on fake: model overloaded",
		});
		expect(backend.closed).toBe(false);
		expect(next.startOptions).toBeUndefined();
		expect(session.configuration()).toMatchObject({ backend: "fake", pending: false });
		expect(session.configuration()).not.toHaveProperty("backendChange");
		const events = await drain(session, "again");
		expect(backend.prompts).toEqual(["first", "again"]);
		expect(configured(events)).toEqual([]);
	});

	it("keeps the old backend, untouched, when the new one fails to start", async () => {
		const { backend, session, next } = await started();
		next.startError = "no credentials";
		await expect(session.setBackend(next, "claude-opus-5-5")).rejects.toMatchObject({
			code: "backend_start_failed",
			message: "anthropic-api could not start, so the session stays on fake: no credentials",
		});
		expect(backend.closed).toBe(false);
		expect(session.configuration()).toMatchObject({ backend: "fake" });
		const events = await drain(session, "again");
		expect(backend.prompts).toEqual(["first", "again"]);
		expect(configured(events)).toEqual([]);
		// The old backend never saw a summary as input.
		expect(backend.prompts.some((prompt) => prompt.includes("<summary>"))).toBe(false);
	});

	it("refuses to leave a backend that cannot summarize, and says which", async () => {
		const next = new FakeBackend([], "anthropic-api");
		const old = new FakeBackend([[{ event: finished }]]);
		old.summarizable = false;
		const quiet = await Session.start({ backend: old, cwd: base, tools: [] });
		await drain(quiet);
		await expect(quiet.setBackend(next)).rejects.toMatchObject({
			code: "summary_unsupported",
			message: "The fake backend cannot summarize its conversation, so the session cannot leave it.",
		});
		expect(old.closed).toBe(false);
		expect(next.startOptions).toBeUndefined();
	});

	it("switches without a summary when nothing was said yet", async () => {
		const old = new FakeBackend([]);
		old.summarizable = false;
		const session = await Session.start({ backend: old, cwd: base, tools: [] });
		const next = new FakeBackend([[{ event: finished }]], "anthropic-api");
		expect(await session.setBackend(next)).toMatchObject({
			backend: "anthropic-api",
			backendChange: { from: "fake", summarized: false },
		});
		expect(old.closed).toBe(true);
		await drain(session, "hello");
		expect(next.prompts).toEqual(["hello"]);
	});

	it("refuses the backend the session already runs on", async () => {
		const { backend, session } = await started();
		await expect(session.setBackend(new FakeBackend([]))).rejects.toMatchObject({
			code: "same_backend",
			message: "The session already runs on fake; session.set_model changes its model.",
		});
		expect(backend.closed).toBe(false);
		expect(backend.calls).toEqual(["send"]);
	});

	it("adds the summary's cost to the next turn_finished as the handoff part", async () => {
		const { session, next } = await started({}, [[{ event: finished }]]);
		await session.setBackend(next);
		const events = await drain(session, "second");
		const end = events.at(-1);
		expect(end).toMatchObject({
			type: "turn_finished",
			usage: { input: 17, output: 8, cacheRead: 3, cacheWrite: 2 },
			costUsd: 0.51,
			requests: 1,
			phases: {
				handoff: { usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01, requests: 1 },
				main: { usage, costUsd: 0.5 },
			},
		});
		// Said once.
		const later = await drain(session, "third");
		expect(later.at(-1)).not.toHaveProperty("phases.handoff");
	});

	it("refuses on a closed session and leaves the new backend unstarted", async () => {
		const { session, next } = await started();
		await session.close();
		await expect(session.setBackend(next)).rejects.toMatchObject({ code: "session_closed" });
		expect(next.startOptions).toBeUndefined();
	});
});

describe("Session.setBackend and memory", () => {
	it("saves the summary to memory as a compaction summary is saved", async () => {
		const memory = new FakeMemory("proj");
		const { session, next } = await started({ memory });
		await session.setBackend(next);
		expect(memory.saved).toEqual([
			{
				title: expect.stringMatching(/^Session summary: proj, \d{4}-\d{2}-\d{2}$/),
				type: "session_summary",
				content: SUMMARY,
				topicKey: expect.stringMatching(/^session\/.+\/summary$/),
			},
		]);
		const events = await drain(session, "second");
		expect(events).toContainEqual(
			expect.objectContaining({ type: "memory_summary_saved", id: 1, preview: SUMMARY.split("\n")[0] }),
		);
		// The new backend's own compactions update the same entry.
		next.startOptions?.compacted?.("## Goal\n- later");
		await until(() => memory.saved.length === 2);
		expect(memory.saved[1]?.topicKey).toBe(memory.saved[0]?.topicKey);
	});

	it("saves nothing without memory, and gives the new backend a compaction callback only with it", async () => {
		const { session, next } = await started();
		await session.setBackend(next);
		expect(next.startOptions?.compacted).toBeUndefined();
	});

	it("does not save a summary that looks like a credential, and says so in the next turn", async () => {
		const memory = new FakeMemory("proj");
		const { backend, session, next } = await started({ memory });
		backend.summary = {
			text: "## Goal\n- key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
			usage,
		};
		await session.setBackend(next);
		expect(memory.saved).toEqual([]);
		const events = await drain(session, "second");
		expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "memory_summary_skipped" }));
	});

	it("says a failed save in the next turn and still switches", async () => {
		const memory = new FakeMemory("proj");
		memory.save = async () => {
			throw new Error("closed");
		};
		const { session, next } = await started({ memory });
		expect(await session.setBackend(next)).toMatchObject({ backend: "anthropic-api" });
		const events = await drain(session, "second");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "error",
				code: "memory_summary_failed",
				message: "The compaction summary was not saved to memory: closed",
			}),
		);
	});
});
