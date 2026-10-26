import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEventBody,
	type BackendName,
	decodeServerMessage,
	FakeBackend,
	FakeMemory,
	type FakeStep,
	MissingApiKeyError,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const SUMMARY = "## Goal\n- carried";
const CARRIED = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${SUMMARY}\n</summary>`;

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-rpc-backend-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

function serve(turns: Partial<Record<BackendName, FakeStep[][]>> = {}, memory?: FakeMemory) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const backends: FakeBackend[] = [];
	const refused = new Set<string>();
	const failing = new Set<string>();
	const server = new RpcServer({
		input,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend: (name) => {
			if (refused.has(name)) throw new MissingApiKeyError(`No key for ${name}.`);
			const backend = new FakeBackend(turns[name] ?? [[{ event: finished }], [{ event: finished }]], name);
			if (failing.has(name)) backend.startError = "no network";
			backends.push(backend);
			return backend;
		},
		...(memory ? { connectMemory: async () => memory } : {}),
		tools: [],
		systemPromptAppend: "",
		home,
	});
	const done = server.run();
	let next = 0;
	const ask = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		for (let i = 0; i < 400; i++) {
			const found = messages.find((m) => m.type === "response" && m.id === id);
			if (found) return found as Extract<ServerMessage, { type: "response" }>;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`No response to ${id}`);
	};
	const eventsOf = (sessionId: string) =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	const open = async (extra: Record<string, unknown> = {}) => {
		const response = await ask({ command: "session.start", cwd: home, backend: "claude-code", ...extra });
		return (response as unknown as { result: { sessionId: string } }).result.sessionId;
	};
	const turn = async (sessionId: string, prompt = "hi") => {
		const before = eventsOf(sessionId).filter((e) => e.type === "turn_finished").length;
		expect((await ask({ command: "session.send", sessionId, prompt })).ok).toBe(true);
		for (let i = 0; i < 400 && eventsOf(sessionId).filter((e) => e.type === "turn_finished").length === before; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		return eventsOf(sessionId);
	};
	const close = () => {
		input.end();
		return done;
	};
	return { ask, open, turn, eventsOf, backends, refused, failing, close };
}

describe("session.set_backend", () => {
	it("answers the new backend and model and that a summary carried the history; the next turn runs there", async () => {
		const h = serve();
		const sessionId = await h.open();
		await h.turn(sessionId, "first");
		const response = await h.ask({
			command: "session.set_backend",
			sessionId,
			backend: "anthropic-api",
			model: "claude-opus-5-5",
		});
		expect(response).toMatchObject({
			ok: true,
			result: {
				backend: "anthropic-api",
				model: "claude-opus-5-5",
				permissionMode: "normal",
				pending: false,
				backendChange: { from: "claude-code", summarized: true },
			},
		});
		const [old, fresh] = h.backends;
		expect(old?.closed).toBe(true);
		expect(old?.calls).toEqual(["send", "summarize"]);
		const events = await h.turn(sessionId, "second");
		expect(fresh?.prompts).toEqual([`${CARRIED}\n\nsecond`]);
		expect(events.filter((e) => e.type === "session_configured")).toMatchObject([
			{ backend: "anthropic-api", model: "claude-opus-5-5", backendChange: { from: "claude-code", summarized: true } },
		]);
		await h.close();
	});

	it("takes the backend's default model when none is given", async () => {
		const h = serve();
		const sessionId = await h.open();
		await h.turn(sessionId);
		const response = await h.ask({ command: "session.set_backend", sessionId, backend: "anthropic-api" });
		expect(response.ok && response.result).not.toHaveProperty("model");
		expect(h.backends[1]?.startOptions).not.toHaveProperty("model");
		await h.close();
	});

	it("refuses a name the server cannot create, as session.start does, and the session keeps its backend", async () => {
		const h = serve();
		const sessionId = await h.open();
		await h.turn(sessionId, "first");
		expect(await h.ask({ command: "session.set_backend", sessionId, backend: "gemini" })).toMatchObject({
			ok: false,
			error: { code: "invalid_command" },
		});
		h.refused.add("anthropic-api");
		expect(await h.ask({ command: "session.set_backend", sessionId, backend: "anthropic-api" })).toMatchObject({
			ok: false,
			error: { code: "missing_api_key", message: "No key for anthropic-api." },
		});
		expect(h.backends[0]?.closed).toBe(false);
		expect(h.backends[0]?.calls).toEqual(["send"]);
		await h.turn(sessionId, "again");
		expect(h.backends[0]?.prompts).toEqual(["first", "again"]);
		await h.close();
	});

	it("answers an error and keeps the old backend when the summary fails", async () => {
		const h = serve();
		const sessionId = await h.open();
		await h.turn(sessionId, "first");
		const old = h.backends[0] as FakeBackend;
		old.summary = "model overloaded";
		expect(await h.ask({ command: "session.set_backend", sessionId, backend: "anthropic-api" })).toMatchObject({
			ok: false,
			error: {
				code: "summary_failed",
				message:
					"The summary of the conversation could not be made, so the session stays on claude-code: model overloaded",
			},
		});
		expect(old.closed).toBe(false);
		const events = await h.turn(sessionId, "again");
		expect(old.prompts).toEqual(["first", "again"]);
		expect(events.filter((e) => e.type === "session_configured")).toEqual([]);
		await h.close();
	});

	it("answers an error and keeps the old backend when the new one cannot start", async () => {
		const h = serve();
		const sessionId = await h.open();
		await h.turn(sessionId, "first");
		h.failing.add("anthropic-api");
		expect(await h.ask({ command: "session.set_backend", sessionId, backend: "anthropic-api" })).toMatchObject({
			ok: false,
			error: {
				code: "backend_start_failed",
				message: "anthropic-api could not start, so the session stays on claude-code: no network",
			},
		});
		expect(h.backends[0]?.closed).toBe(false);
		await h.turn(sessionId, "again");
		expect(h.backends[0]?.prompts).toEqual(["first", "again"]);
		await h.close();
	});

	it("answers pending while a turn runs and switches when it ends", async () => {
		const h = serve({ "claude-code": [[{ waitForInterrupt: true }]] });
		const sessionId = await h.open();
		await h.ask({ command: "session.send", sessionId, prompt: "go" });
		const response = await h.ask({ command: "session.set_backend", sessionId, backend: "anthropic-api" });
		expect(response).toMatchObject({ ok: true, result: { backend: "anthropic-api", pending: true } });
		expect(h.backends[0]?.calls).toEqual(["send"]);
		await h.ask({ command: "session.interrupt", sessionId });
		for (let i = 0; i < 400 && !h.eventsOf(sessionId).some((e) => e.type === "turn_finished"); i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.backends[0]?.calls).toEqual(["send", "summarize"]);
		expect(
			h
				.eventsOf(sessionId)
				.map((e) => e.type)
				.slice(-2),
		).toEqual(["session_configured", "turn_finished"]);
		await h.close();
	});

	it("saves the summary to memory", async () => {
		const memory = new FakeMemory("proj");
		const h = serve({}, memory);
		const sessionId = await h.open();
		await h.turn(sessionId, "first");
		await h.ask({ command: "session.set_backend", sessionId, backend: "anthropic-api" });
		expect(memory.saved).toMatchObject([{ type: "session_summary", content: SUMMARY }]);
		await h.close();
	});

	it("refuses the backend the session already runs on and an unknown session", async () => {
		const h = serve();
		const sessionId = await h.open();
		expect(await h.ask({ command: "session.set_backend", sessionId, backend: "claude-code" })).toMatchObject({
			ok: false,
			error: { code: "same_backend" },
		});
		expect(await h.ask({ command: "session.set_backend", sessionId: "nope", backend: "anthropic-api" })).toMatchObject({
			ok: false,
			error: { code: "unknown_session", message: "No session nope." },
		});
		await h.close();
	});
});
