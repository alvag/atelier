import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEventBody,
	decodeServerMessage,
	defineTool,
	FakeBackend,
	type FakeStep,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";

const finished: AtelierEventBody = {
	type: "turn_finished",
	stopReason: "end_turn",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

const shell = defineTool({
	name: "shell",
	description: "Runs a command",
	inputShape: { command: z.string() },
	approvalCommand: ({ command }) => command,
	execute: async ({ command }) => ({ ok: true, output: `ran ${command}`, summary: command, truncated: false }),
});

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-rpc-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** A server over in-memory streams; `backends` are handed out in session order. */
function harness(turnsPerSession: FakeStep[][][]) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const raw: string[] = [];
	const backends: FakeBackend[] = [];
	let shutdowns = 0;
	const server = new RpcServer({
		input,
		write: (line) => {
			raw.push(line);
			messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage);
		},
		createBackend: () => {
			const backend = new FakeBackend(turnsPerSession[backends.length] ?? []);
			backends.push(backend);
			return backend;
		},
		tools: [shell],
		systemPromptAppend: "",
		onShutdown: () => {
			shutdowns++;
		},
	});
	const done = server.run();
	let next = 0;
	const send = (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		return id;
	};
	const waitFor = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
		for (let i = 0; i < 200; i++) {
			const found = messages.find(predicate);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`Timed out; got ${JSON.stringify(messages)}`);
	};
	const responseTo = (id: string) => waitFor((m) => m.type === "response" && m.id === id);
	const start = async () => {
		const response = await responseTo(send({ command: "session.start", cwd }));
		return (response as unknown as { result: { sessionId: string } }).result.sessionId;
	};
	const events = (sessionId: string) =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	return { input, messages, raw, backends, send, waitFor, responseTo, start, events, done, shutdowns: () => shutdowns };
}

describe("RpcServer", () => {
	it("greets with the protocol version first", async () => {
		const h = harness([]);
		await h.waitFor(() => true);
		expect(h.messages[0]).toEqual({ type: "hello", protocol: 2, core: "0.0.0" });
	});

	it("offers subagents in every session, on the session's own backend", async () => {
		const h = harness([]);
		await h.start();
		expect(h.backends[0]?.startOptions?.tools.map((t) => t.name)).toContain("task");
	});

	it("starts a session, runs a turn and streams its events", async () => {
		const h = harness([[[{ event: { type: "text_delta", text: "hi" } }, { event: finished }]]]);
		const sessionId = await h.start();
		const response = await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "hello" }));
		const turnId = (response as unknown as { result: { turnId: string } }).result.turnId;

		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(h.backends[0]?.prompts).toEqual(["hello"]);
		expect(h.backends[0]?.startOptions?.cwd).toBe(cwd);
		expect(h.events(sessionId)).toEqual([
			{ type: "text_delta", text: "hi", seq: 1, turnId },
			{ ...finished, seq: 2, turnId },
		]);
	});

	it("answers every command exactly once, including failures", async () => {
		const h = harness([]);
		const ids = [
			h.send({ command: "session.send", sessionId: "nope", prompt: "x" }),
			h.send({ command: "session.interrupt", sessionId: "nope" }),
			h.send({ command: "session.close", sessionId: "nope" }),
			h.send({ command: "session.approve", sessionId: "nope", callId: "k", approved: true }),
		];
		for (const id of ids) {
			expect(await h.responseTo(id)).toMatchObject({
				ok: false,
				error: { code: "unknown_session", message: "No session nope." },
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.messages.filter((m) => m.type === "response")).toHaveLength(ids.length);
	});

	it("answers invalid commands by id, and unattributable lines with protocol_error", async () => {
		const h = harness([]);
		h.input.write('{"type":"command","id":"bad1","command":"session.send"}\n');
		expect(await h.responseTo("bad1")).toMatchObject({ ok: false, error: { code: "invalid_command" } });
		h.input.write("{not json\n");
		expect(await h.waitFor((m) => m.type === "protocol_error")).toEqual({
			type: "protocol_error",
			message: "Invalid JSON.",
		});
	});

	it("rejects a reused command id", async () => {
		const h = harness([]);
		h.input.write('{"type":"command","id":"same","command":"session.close","sessionId":"x"}\n');
		await h.responseTo("same");
		h.input.write('{"type":"command","id":"same","command":"session.close","sessionId":"x"}\n');
		await h.waitFor((m) => m.type === "response" && m.ok === false && m.error.code === "duplicate_id");
	});

	it("rejects a working directory that does not exist", async () => {
		const h = harness([]);
		const id = h.send({ command: "session.start", cwd: join(cwd, "missing") });
		expect(await h.responseTo(id)).toMatchObject({ ok: false, error: { code: "invalid_cwd" } });
		expect(h.backends).toHaveLength(0);
	});

	it("reports a backend that fails to start", async () => {
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		const server = new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => ({
				id: "broken",
				start: async () => {
					throw new Error("claude not found");
				},
			}),
			tools: [],
			systemPromptAppend: "",
		});
		void server.run();
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(messages.find((m) => m.type === "response")).toMatchObject({
			ok: false,
			error: { code: "session_start_failed", message: "claude not found" },
		});
	});

	it("rejects a second turn while one is running", async () => {
		const h = harness([[[{ waitForInterrupt: true }]]]);
		const sessionId = await h.start();
		await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "one" }));
		const second = await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "two" }));
		expect(second).toMatchObject({ ok: false, error: { code: "busy" } });
		await h.responseTo(h.send({ command: "session.interrupt", sessionId }));
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
	});

	describe("approvals", () => {
		const turn: FakeStep[][][] = [
			[[{ toolCall: { tool: "shell", input: { command: "rm x" }, callId: "k1" } }, { event: finished }]],
		];

		it("waits for session.approve and runs the command when approved", async () => {
			const h = harness(turn);
			const sessionId = await h.start();
			h.send({ command: "session.send", sessionId, prompt: "x" });
			await h.waitFor((m) => m.type === "event" && m.event.type === "approval_requested");
			expect(h.backends[0]?.toolResults).toEqual([]);

			const id = h.send({ command: "session.approve", sessionId, callId: "k1", approved: true });
			expect(await h.responseTo(id)).toMatchObject({ ok: true });
			await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
			expect(h.backends[0]?.toolResults).toEqual([{ ok: true, output: "ran rm x" }]);
		});

		it("denies the command when the answer is no", async () => {
			const h = harness(turn);
			const sessionId = await h.start();
			h.send({ command: "session.send", sessionId, prompt: "x" });
			await h.waitFor((m) => m.type === "event" && m.event.type === "approval_requested");
			await h.responseTo(h.send({ command: "session.approve", sessionId, callId: "k1", approved: false }));
			await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
			expect(h.backends[0]?.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
		});

		it.each([
			["the turn is interrupted", { command: "session.interrupt" }],
			["the session is closed", { command: "session.close" }],
		])("denies a pending approval when %s", async (_name, command) => {
			const h = harness(turn);
			const sessionId = await h.start();
			h.send({ command: "session.send", sessionId, prompt: "x" });
			await h.waitFor((m) => m.type === "event" && m.event.type === "approval_requested");
			await h.responseTo(h.send({ ...command, sessionId }));
			await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
			expect(h.backends[0]?.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
		});

		it("rejects an approval nobody asked for", async () => {
			const h = harness([[]]);
			const sessionId = await h.start();
			const id = h.send({ command: "session.approve", sessionId, callId: "ghost", approved: true });
			expect(await h.responseTo(id)).toMatchObject({ ok: false, error: { code: "unknown_approval" } });
		});

		it("denies pending approvals and closes every session when the client disconnects", async () => {
			const h = harness(turn);
			const sessionId = await h.start();
			h.send({ command: "session.send", sessionId, prompt: "x" });
			await h.waitFor((m) => m.type === "event" && m.event.type === "approval_requested");
			h.input.end();
			await h.done;
			expect(h.backends[0]?.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
			expect(h.backends[0]?.closed).toBe(true);
		});
	});

	it("runs several sessions at once", async () => {
		const h = harness([
			[[{ event: { type: "text_delta", text: "from one" } }, { event: finished }]],
			[[{ event: { type: "text_delta", text: "from two" } }, { event: finished }]],
		]);
		const one = await h.start();
		const two = await h.start();
		expect(one).not.toBe(two);
		h.send({ command: "session.send", sessionId: one, prompt: "a" });
		h.send({ command: "session.send", sessionId: two, prompt: "b" });
		await h.waitFor((m) => m.type === "event" && m.sessionId === one && m.event.type === "turn_finished");
		await h.waitFor((m) => m.type === "event" && m.sessionId === two && m.event.type === "turn_finished");
		expect(h.events(one)[0]).toMatchObject({ type: "text_delta", text: "from one" });
		expect(h.events(two)[0]).toMatchObject({ type: "text_delta", text: "from two" });
	});

	it("closes a session whose start was still running when the client disconnected", async () => {
		const input = new PassThrough();
		const fake = new FakeBackend([]);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = new RpcServer({
			input,
			write: () => {},
			createBackend: () => ({
				id: "slow",
				start: async (options) => {
					await gate;
					return fake.start(options);
				},
			}),
			tools: [],
			systemPromptAppend: "",
		});
		const done = server.run();
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 20));
		input.end();
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();
		await done;
		expect(fake.closed).toBe(true);
	});

	it("does not start a backend for a session.start that arrives with shutdown", async () => {
		const h = harness([[]]);
		await h.waitFor(() => true);
		h.input.write(
			`${JSON.stringify({ type: "command", id: "bye", command: "shutdown" })}\n${JSON.stringify({ type: "command", id: "late", command: "session.start", cwd })}\n`,
		);
		await h.done;
		expect(h.messages.find((m) => m.type === "response" && m.id === "late")).toMatchObject({
			ok: false,
			error: { code: "shutting_down" },
		});
		expect(h.backends).toHaveLength(0);
	});

	it("survives an output that fails while a turn streams", async () => {
		const input = new PassThrough();
		let sessionId = "";
		const server = new RpcServer({
			input,
			write: (line) => {
				const message = decodeServerMessage(line.trimEnd());
				if (message.type === "response" && message.ok && typeof message.result.sessionId === "string")
					sessionId = message.result.sessionId;
				if (message.type === "event") throw new Error("EPIPE");
			},
			createBackend: () => new FakeBackend([[{ event: { type: "text_delta", text: "x" } }, { event: finished }]]),
			tools: [],
			systemPromptAppend: "",
		});
		const done = server.run();
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		for (let i = 0; i < 100 && sessionId === ""; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		input.write(`${JSON.stringify({ type: "command", id: "t", command: "session.send", sessionId, prompt: "x" })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		input.end();
		await done;
	});

	it("closes sessions and stops on shutdown", async () => {
		const h = harness([[]]);
		await h.start();
		expect(await h.responseTo(h.send({ command: "shutdown" }))).toMatchObject({ ok: true });
		await h.done;
		expect(h.backends[0]?.closed).toBe(true);
		expect(h.shutdowns()).toBe(1);
	});

	it("writes exactly one JSON message per line", async () => {
		const h = harness([[[{ event: { type: "text_delta", text: "multi\nline" } }, { event: finished }]]]);
		const sessionId = await h.start();
		h.send({ command: "session.send", sessionId, prompt: "x" });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		for (const line of h.raw) {
			expect(line.endsWith("\n")).toBe(true);
			expect(line.slice(0, -1)).not.toContain("\n");
			expect(decodeServerMessage(line.trimEnd()).type).not.toBe("unknown");
		}
	});
});
