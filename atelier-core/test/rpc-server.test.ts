import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEventBody,
	createBashTool,
	decodeServerMessage,
	defineTool,
	FakeBackend,
	type FakeStep,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

/** A sandbox library that is there and wraps nothing. */
const fakeManager: SandboxManagerLike = {
	isSupportedPlatform: () => true,
	checkDependencies: () => ({ errors: [], warnings: [] }),
	initialize: async () => {},
	wrapWithSandbox: async (command) => command,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};

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
		expect(h.messages[0]).toEqual({ type: "hello", protocol: 6, core: "0.0.0" });
	});

	it("offers subagents in every session, on the session's own backend", async () => {
		const h = harness([]);
		await h.start();
		expect(h.backends[0]?.startOptions?.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(["task", "feature", "phase"]),
		);
	});

	it("starts a session, runs a turn and streams its events", async () => {
		const h = harness([[[{ event: { type: "text_delta", text: "hi" } }, { event: finished }]]]);
		const sessionId = await h.start();
		const response = await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "hello" }));
		const turnId = (response as unknown as { result: { turnId: string } }).result.turnId;

		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(h.backends[0]?.prompts).toEqual(["hello"]);
		expect(h.backends[0]?.startOptions?.cwd).toBe(cwd);
		// This server has review off, so the first turn says so once.
		expect(h.events(sessionId)).toEqual([
			{
				type: "review_status",
				available: false,
				reason: "Review is off on this server (ATELIER_REVIEW=off).",
				seq: 1,
				turnId,
			},
			{ type: "text_delta", text: "hi", seq: 2, turnId },
			{ ...finished, phases: { main: { usage: finished.usage } }, durationMs: expect.any(Number), seq: 3, turnId },
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

	it("refuses to start a session when a sandbox configuration file is invalid, naming it", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-rpc-home-"));
		try {
			await mkdir(join(cwd, ".atelier"));
			await writeFile(join(cwd, ".atelier", "sandbox.json"), '{ "denyRead": "x" }');
			const input = new PassThrough();
			const messages: ServerMessage[] = [];
			const backends: FakeBackend[] = [];
			const server = new RpcServer({
				input,
				write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
				createBackend: () => {
					const backend = new FakeBackend([]);
					backends.push(backend);
					return backend;
				},
				tools: [],
				systemPromptAppend: "",
				home,
			});
			void server.run();
			input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(messages.find((m) => m.type === "response")).toMatchObject({
				ok: false,
				error: {
					code: "session_start_failed",
					message: `Invalid sandbox configuration ${join(cwd, ".atelier", "sandbox.json")}: "denyRead" must be an array of non-empty strings`,
				},
			});
			expect(backends).toEqual([]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	describe("without the sandbox", () => {
		const offerBash = (options: { noSandbox?: boolean } = {}) => {
			const input = new PassThrough();
			const messages: ServerMessage[] = [];
			const server = new RpcServer({
				input,
				write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
				createBackend: () => new FakeBackend([[{ event: finished }]]),
				tools: [createBashTool({ sandbox: new Sandbox({ platform: "darwin", manager: fakeManager }) })],
				systemPromptAppend: "",
				home: cwd,
				...options,
			});
			void server.run();
			const ask = async (command: Record<string, unknown>) => {
				const id = `i${messages.length}`;
				input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
				for (let i = 0; i < 200; i++) {
					const found = messages.find((m) => m.type === "response" && m.id === id);
					if (found) return found;
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				throw new Error("no response");
			};
			return { messages, ask };
		};
		const turnEvents = async (h: ReturnType<typeof offerBash>, noSandbox?: boolean) => {
			const started = (await h.ask({
				command: "session.start",
				cwd,
				...(noSandbox ? { noSandbox } : {}),
			})) as unknown as {
				ok: boolean;
				result: { sessionId: string };
			};
			await h.ask({ command: "session.send", sessionId: started.result.sessionId, prompt: "hi" });
			for (let i = 0; i < 200 && !h.messages.some((m) => m.type === "event" && m.event.type === "turn_finished"); i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			return h.messages.flatMap((m) => (m.type === "event" ? [m.event] : []));
		};

		it("starts with the sandbox when the client does not ask otherwise, and says so", async () => {
			const events = await turnEvents(offerBash());
			expect(events.find((e) => e.type === "sandbox_status")).toMatchObject({ sandboxed: true });
		});

		it("lets session.start turn the sandbox off, and does not read the configuration files then", async () => {
			await mkdir(join(cwd, ".atelier"));
			await writeFile(join(cwd, ".atelier", "sandbox.json"), "{ nope");
			const refused = offerBash();
			expect(await refused.ask({ command: "session.start", cwd })).toMatchObject({
				ok: false,
				error: { code: "session_start_failed" },
			});

			const h = offerBash();
			const events = await turnEvents(h, true);
			expect(events.find((e) => e.type === "sandbox_status")).toMatchObject({
				sandboxed: false,
				reason: "sandbox turned off for this session",
			});
		});

		it("honors the server's own setting (ATELIER_SANDBOX=off) for every session", async () => {
			await mkdir(join(cwd, ".atelier"));
			await writeFile(join(cwd, ".atelier", "sandbox.json"), "{ nope");
			const events = await turnEvents(offerBash({ noSandbox: true }));
			expect(events.find((e) => e.type === "sandbox_status")).toMatchObject({
				sandboxed: false,
				reason: "sandbox turned off for this session",
			});
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
		expect(h.events(one)[1]).toMatchObject({ type: "text_delta", text: "from one" });
		expect(h.events(two)[1]).toMatchObject({ type: "text_delta", text: "from two" });
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

describe("session.compact", () => {
	it("runs as a turn and says when the backend cannot compact", async () => {
		const h = harness([[]]);
		const sessionId = await h.start();
		const response = await h.responseTo(
			h.send({ command: "session.compact", sessionId, instructions: "Keep decisions." }),
		);
		expect(response).toMatchObject({ ok: true, result: { turnId: expect.any(String) } });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(h.events(sessionId).map((e) => e.type)).toEqual(["error", "turn_finished"]);
		expect(h.events(sessionId)[0]).toMatchObject({ code: "compaction_unavailable", recoverable: true });
		expect(h.events(sessionId)[1]).toMatchObject({ stopReason: "error" });
	});

	it("refuses instructions over 2000 bytes and keeps the session idle", async () => {
		const h = harness([[]]);
		const sessionId = await h.start();
		const response = await h.responseTo(
			h.send({ command: "session.compact", sessionId, instructions: "é".repeat(1001) }),
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "invalid_command", message: expect.stringMatching(/2000 bytes/) },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.events(sessionId)).toEqual([]);
		const ok = await h.responseTo(h.send({ command: "session.compact", sessionId, instructions: "x".repeat(2000) }));
		expect(ok).toMatchObject({ ok: true });
	});

	it("is refused while a turn is running", async () => {
		const h = harness([[[{ waitForInterrupt: true }]]]);
		const sessionId = await h.start();
		await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "one" }));
		const compact = await h.responseTo(h.send({ command: "session.compact", sessionId }));
		expect(compact).toMatchObject({ ok: false, error: { code: "busy" } });
		await h.responseTo(h.send({ command: "session.interrupt", sessionId }));
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
	});
});

describe("session.start profiles", () => {
	it("resolves the profile at session.start: the orchestrator's backend, model and thinking, unless the client chose", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-rpc-home-"));
		try {
			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "profiles.json"),
				JSON.stringify({
					kind: "atelier.agent_model_profiles",
					version: 1,
					active: "p",
					profiles: { p: { orchestrator: { model: "anthropic-api/claude-opus-5-5", thinking: "high" } } },
				}),
			);
			const input = new PassThrough();
			const messages: ServerMessage[] = [];
			const asked: { name: string; backend: FakeBackend }[] = [];
			const server = new RpcServer({
				input,
				write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
				createBackend: (name) => {
					const backend = new FakeBackend([]);
					asked.push({ name, backend });
					return backend;
				},
				tools: [],
				systemPromptAppend: "",
				home,
			});
			void server.run();
			const start = async (id: string, extra: object) => {
				input.write(`${JSON.stringify({ type: "command", id, command: "session.start", cwd, ...extra })}\n`);
				for (let i = 0; i < 200 && !messages.some((m) => m.type === "response" && m.id === id); i++)
					await new Promise((resolve) => setTimeout(resolve, 5));
			};
			await start("a", {});
			await start("b", { backend: "claude-code", model: "sonnet" });
			expect(asked.map((a) => a.name)).toEqual(["anthropic-api", "claude-code"]);
			expect(asked[0]?.backend.startOptions).toMatchObject({ model: "claude-opus-5-5", thinking: "high" });
			expect(asked[1]?.backend.startOptions).toMatchObject({ model: "sonnet", thinking: "high" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
