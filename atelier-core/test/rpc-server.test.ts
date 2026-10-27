import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type AtelierEventBody,
	createBashTool,
	decodeServerMessage,
	defineTool,
	FakeBackend,
	type FakeStep,
	MissingApiKeyError,
	type PinPlaces,
	RpcServer,
	type ServerMessage,
	Session,
	VERSION,
} from "../src/index.ts";
import { ConfigureError } from "../src/session.ts";
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

/** Waits for what the test needs, never a fixed delay: a loaded machine answers a session.start slower. */
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

/** Resolves once the server has read the end of `input`, so it knows the client is gone. */
const inputEnded = async (input: PassThrough) => {
	if (!input.readableEnded) await new Promise((resolve) => input.once("end", resolve));
	// The server's read loop sees the end in the microtasks that follow the event.
	await new Promise((resolve) => setImmediate(resolve));
};

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-rpc-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** A server over in-memory streams; `backends` are handed out in session order. */
function harness(turnsPerSession: FakeStep[][][], tools = [shell]) {
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
		tools,
		systemPromptAppend: "",
		home: cwd,
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
		expect(h.messages[0]).toEqual({ type: "hello", protocol: 7, core: VERSION });
	});

	it("offers subagents in every session, on the session's own backend", async () => {
		const h = harness([]);
		await h.start();
		expect(h.backends[0]?.startOptions?.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(["task", "feature", "phase"]),
		);
	});

	it("lists the skills of the working directory in the system prompt and reports them", async () => {
		await mkdir(join(cwd, ".agents", "skills", "notes"), { recursive: true });
		await writeFile(
			join(cwd, ".agents", "skills", "notes", "SKILL.md"),
			"---\nname: notes\ndescription: Take notes.\n---\n",
		);
		const h = harness([[[{ event: finished }]]]);
		const sessionId = await h.start();
		h.send({ command: "session.send", sessionId, prompt: "hi" });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(h.backends[0]?.startOptions?.systemPromptAppend).toContain("<name>notes</name>");
		expect(h.events(sessionId)).toContainEqual(
			expect.objectContaining({ type: "skills_loaded", skills: [expect.objectContaining({ name: "notes" })] }),
		);
	});

	it("gives an auto session a classifier on the session's own backend", async () => {
		const verdict = JSON.stringify({ decision: "allow", reason: "it is what was asked" });
		const h = harness([
			[[{ toolCall: { tool: "shell", input: { command: "make" }, callId: "k1" } }, { event: finished }]],
			[[{ event: { type: "text_delta", text: verdict } }, { event: finished }]],
		]);
		const response = await h.responseTo(h.send({ command: "session.start", cwd, mode: "auto" }));
		const sessionId = (response as unknown as { result: { sessionId: string } }).result.sessionId;
		h.send({ command: "session.send", sessionId, prompt: "build it" });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		const events = h.events(sessionId);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "permission_classified", callId: "k1", decision: "allow" }),
		);
		expect(events.some((e) => e.type === "approval_requested")).toBe(false);
		expect(h.backends[1]?.prompts[0]).toContain("build it");
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
			{
				...finished,
				phases: { main: { usage: finished.usage } },
				durationMs: expect.any(Number),
				at: expect.any(String),
				seq: 3,
				turnId,
			},
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
			home: cwd,
		});
		void server.run();
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		await until(() => messages.some((m) => m.type === "response"));
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
			await until(() => messages.some((m) => m.type === "response"));
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

	describe("queued messages", () => {
		/** A first turn that runs until `release` is called, then the turns after it. */
		const held = (after: FakeStep[][]) => {
			const gate: { release?: () => void } = {};
			const first: FakeStep[] = [
				{ run: () => new Promise<void>((resolve) => (gate.release = resolve)) },
				{ event: finished },
			];
			return { gate, turns: [[first, ...after]] };
		};
		const resultOf = (response: ServerMessage) => (response as unknown as { result: Record<string, unknown> }).result;

		it("runs each follow-up as a turn of its own once the running one ends, starting with queued_message", async () => {
			const { gate, turns } = held([[{ event: finished }], [{ event: finished }]]);
			const h = harness(turns);
			const sessionId = await h.start();
			await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "one" }));
			await until(() => gate.release !== undefined);
			const two = resultOf(
				await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "follow_up", text: "two" })),
			);
			await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "follow_up", text: "three" }));
			expect(two.id).toEqual(expect.any(String));
			expect(two.turnId).toBeUndefined();
			await until(() => h.events(sessionId).some((e) => e.type === "queue_update" && e.messages.length === 2));
			gate.release?.();
			await until(() => h.events(sessionId).filter((e) => e.type === "turn_finished").length === 3);
			expect(h.backends[0]?.prompts).toEqual(["one", "two", "three"]);
			const events = h.events(sessionId);
			const firsts = events.filter((e) => e.seq === 1);
			expect(firsts.slice(1)).toEqual([
				expect.objectContaining({ type: "queued_message", id: two.id, kind: "follow_up", text: "two" }),
				expect.objectContaining({ type: "queued_message", kind: "follow_up", text: "three" }),
			]);
		});

		it("starts a turn at once for a message queued while nothing runs", async () => {
			const h = harness([[[{ event: finished }]]]);
			const sessionId = await h.start();
			const result = resultOf(
				await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "steer", text: "now" })),
			);
			expect(result).toEqual({ id: expect.any(String), turnId: expect.any(String) });
			await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
			expect(h.backends[0]?.prompts).toEqual(["now"]);
			expect(h.events(sessionId)[0]).toMatchObject({ type: "queued_message", turnId: result.turnId, text: "now" });
		});

		it("edits and takes back queued messages, and refuses one that is not queued", async () => {
			const { gate, turns } = held([]);
			const h = harness(turns);
			const sessionId = await h.start();
			await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "one" }));
			await until(() => gate.release !== undefined);
			const { id } = resultOf(
				await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "follow_up", text: "tow" })),
			);
			await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "steer", text: "x" }));
			const edited = await h.responseTo(
				h.send({ command: "session.queue_edit", sessionId, messageId: id, text: "two" }),
			);
			expect(edited).toMatchObject({ ok: true, result: {} });
			const missing = await h.responseTo(
				h.send({ command: "session.queue_edit", sessionId, messageId: "nope", text: "y" }),
			);
			expect(missing).toMatchObject({ ok: false, error: { code: "not_queued" } });
			const one = resultOf(await h.responseTo(h.send({ command: "session.unqueue", sessionId, messageId: id })));
			expect(one.messages).toEqual([{ id, kind: "follow_up", text: "two" }]);
			const rest = resultOf(await h.responseTo(h.send({ command: "session.unqueue", sessionId })));
			expect(rest.messages).toEqual([expect.objectContaining({ kind: "steer", text: "x" })]);
			gate.release?.();
			await until(() => h.events(sessionId).some((e) => e.type === "turn_finished"));
			expect(h.backends[0]?.prompts).toEqual(["one"]);
		});

		it.each([
			["interrupted", [{ waitForInterrupt: true }] as FakeStep[]],
			["ended with an error", [{ event: { ...finished, stopReason: "error" } }] as FakeStep[]],
			["whose backend threw", [{ throw: "boom" }] as FakeStep[]],
		])("runs nothing queued after a turn %s, and gives it back", async (_name, end) => {
			const gate: { release?: () => void } = {};
			const h = harness([
				[[{ run: () => new Promise<void>((resolve) => (gate.release = resolve)) }, ...end], [{ event: finished }]],
			]);
			const sessionId = await h.start();
			await h.responseTo(h.send({ command: "session.send", sessionId, prompt: "one" }));
			await until(() => gate.release !== undefined);
			await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "follow_up", text: "two" }));
			gate.release?.();
			if ("waitForInterrupt" in (end[0] ?? {})) await h.responseTo(h.send({ command: "session.interrupt", sessionId }));
			await until(() => h.events(sessionId).some((e) => e.type === "turn_finished"));
			// Room for a chained turn to start, if one wrongly did.
			await h.responseTo(h.send({ command: "session.mcp", sessionId }));
			expect(h.backends[0]?.prompts).toEqual(["one"]);
			const back = h.events(sessionId).findLast((e) => e.type === "queue_update");
			expect(back).toMatchObject({ messages: [], returned: [expect.objectContaining({ text: "two" })] });
			expect(h.events(sessionId).filter((e) => e.type === "turn_finished")).toHaveLength(1);
		});

		it("answers turn_ended when the session refuses a message because its turn is ending", async () => {
			const refuse = vi.spyOn(Session.prototype, "queue").mockImplementation(() => {
				throw new ConfigureError("turn_ended", "The turn was interrupted or failed; the message was not queued.");
			});
			try {
				const h = harness([]);
				const sessionId = await h.start();
				const answer = await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "steer", text: "x" }));
				expect(answer).toMatchObject({ ok: false, error: { code: "turn_ended" } });
			} finally {
				refuse.mockRestore();
			}
		});

		it("refuses an unknown kind and an empty text", async () => {
			const h = harness([]);
			const sessionId = await h.start();
			const kind = await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "later", text: "x" }));
			const empty = await h.responseTo(h.send({ command: "session.queue", sessionId, kind: "steer", text: "" }));
			expect(kind).toMatchObject({ ok: false, error: { code: "invalid_command" } });
			expect(empty).toMatchObject({ ok: false, error: { code: "invalid_command" } });
		});
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

		it("remembers an answer with remember, lists the rules and removes one", async () => {
			const gated = defineTool({
				name: "shell",
				description: "Runs a command",
				inputShape: { command: z.string() },
				gate: async ({ command }) => ({ approval: { command, remember: { rules: ["open"], always: true } } }),
				execute: async ({ command }) => ({ ok: true, output: `ran ${command}`, summary: command, truncated: false }),
			});
			const asking = [{ toolCall: { tool: "shell", input: { command: "open x" }, callId: "k1" } }, { event: finished }];
			const h = harness([[asking]], [gated]);
			const sessionId = await h.start();
			h.send({ command: "session.send", sessionId, prompt: "x" });
			const asked = await h.waitFor((m) => m.type === "event" && m.event.type === "approval_requested");
			expect(asked).toMatchObject({ event: { remember: { rules: ["open"], always: true } } });
			const bad = h.send({ command: "session.approve", sessionId, callId: "k1", approved: true, remember: "forever" });
			expect(await h.responseTo(bad)).toMatchObject({ ok: false, error: { code: "invalid_command" } });
			const id = h.send({ command: "session.approve", sessionId, callId: "k1", approved: true, remember: "always" });
			expect(await h.responseTo(id)).toMatchObject({ ok: true });
			await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
			expect(JSON.parse(await readFile(join(cwd, ".atelier", "permissions.json"), "utf8")).allow).toEqual([
				{ bash: "open" },
			]);

			const listed = await h.responseTo(h.send({ command: "session.permissions", sessionId }));
			expect(listed).toMatchObject({
				ok: true,
				result: { rules: [{ id: "always:bash:open", scope: "always", kind: "bash", value: "open" }] },
			});
			const removed = await h.responseTo(
				h.send({ command: "session.permissions_remove", sessionId, ruleId: "always:bash:open" }),
			);
			expect(removed).toMatchObject({ ok: true, result: { rules: [] } });
			const again = await h.responseTo(
				h.send({ command: "session.permissions_remove", sessionId, ruleId: "always:bash:open" }),
			);
			expect(again).toMatchObject({ ok: false, error: { code: "unknown_rule" } });
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
		let starting = false;
		const server = new RpcServer({
			input,
			write: () => {},
			createBackend: () => ({
				id: "slow",
				start: async (options) => {
					starting = true;
					await gate;
					return fake.start(options);
				},
			}),
			tools: [],
			systemPromptAppend: "",
			home: cwd,
		});
		const done = server.run();
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		await until(() => starting);
		input.end();
		await inputEnded(input);
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
		let failedWrites = 0;
		const server = new RpcServer({
			input,
			write: (line) => {
				const message = decodeServerMessage(line.trimEnd());
				if (message.type === "response" && message.ok && typeof message.result.sessionId === "string")
					sessionId = message.result.sessionId;
				if (message.type !== "event") return;
				failedWrites++;
				throw new Error("EPIPE");
			},
			createBackend: () => new FakeBackend([[{ event: { type: "text_delta", text: "x" } }, { event: finished }]]),
			tools: [],
			systemPromptAppend: "",
			home: cwd,
		});
		const done = server.run();
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		await until(() => sessionId !== "");
		input.write(`${JSON.stringify({ type: "command", id: "t", command: "session.send", sessionId, prompt: "x" })}\n`);
		await until(() => failedWrites > 0);
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

	it("takes the client's profile over the active one, lists the profiles, and refuses a choice it cannot read", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-rpc-home-"));
		try {
			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "profiles.json"),
				JSON.stringify({
					kind: "atelier.agent_model_profiles",
					version: 1,
					active: "p",
					profiles: {
						p: { orchestrator: { model: "anthropic-api/claude-opus-5-5" } },
						q: { orchestrator: { model: "claude-code/claude-sonnet-5-5", thinking: "low" } },
					},
				}),
			);
			const serve = (withHome: boolean) => {
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
					...(withHome ? { home } : {}),
				});
				void server.run();
				const command = async (id: string, body: object) => {
					input.write(`${JSON.stringify({ type: "command", id, ...body })}\n`);
					for (let i = 0; i < 200 && !messages.some((m) => m.type === "response" && m.id === id); i++)
						await new Promise((resolve) => setTimeout(resolve, 5));
					return messages.find((m) => m.type === "response" && m.id === id);
				};
				return { command, asked };
			};
			const h = serve(true);
			await h.command("a", { command: "session.start", cwd, profile: "q" });
			expect(h.asked.map((a) => a.name)).toEqual(["claude-code"]);
			expect(h.asked[0]?.backend.startOptions).toMatchObject({ model: "claude-sonnet-5-5", thinking: "low" });
			expect(await h.command("l", { command: "profiles.list", cwd })).toMatchObject({
				ok: true,
				result: { profiles: ["p", "q"], active: "p", effective: { name: "p", origin: "active" } },
			});
			const bare = serve(false);
			expect(await bare.command("b", { command: "session.start", cwd, profile: "q" })).toMatchObject({
				ok: false,
				error: { code: "profile_unavailable" },
			});
			expect(await bare.command("m", { command: "profiles.list", cwd })).toMatchObject({
				ok: true,
				result: { profiles: [] },
			});
			expect(bare.asked).toEqual([]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("answers other commands while profiles.list waits for git", async () => {
		let release: (places: PinPlaces) => void = () => {};
		const lookup = new Promise<PinPlaces>((resolve) => {
			release = resolve;
		});
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		const server = new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => new FakeBackend([]),
			tools: [],
			systemPromptAppend: "",
			home: cwd,
			pinPlaces: () => lookup,
		});
		void server.run();
		const answered = (id: string) => messages.some((m) => m.type === "response" && m.id === id);
		input.write(`${JSON.stringify({ type: "command", id: "slow", command: "profiles.list", cwd })}\n`);
		input.write(`${JSON.stringify({ type: "command", id: "fast", command: "profiles.list" })}\n`);
		await until(() => answered("fast"));
		expect(answered("slow")).toBe(false);
		release({});
		await until(() => answered("slow"));
	});

	it("names the orchestrator and backend when its API key is missing, and keeps the plain error without a profile", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-rpc-home-"));
		try {
			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "profiles.json"),
				JSON.stringify({
					kind: "atelier.agent_model_profiles",
					version: 1,
					active: "p",
					profiles: { p: { orchestrator: { model: "anthropic-api/claude-sonnet-5-5" } } },
				}),
			);
			const input = new PassThrough();
			const messages: ServerMessage[] = [];
			const server = new RpcServer({
				input,
				write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
				createBackend: () => {
					throw new MissingApiKeyError("No test key.");
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
				return messages.find((m) => m.type === "response" && m.id === id);
			};
			expect(await start("a", {})).toMatchObject({
				ok: false,
				error: {
					code: "missing_api_key",
					message: "orchestrator: anthropic-api has no API key (No test key.)",
				},
			});
			// An explicit backend is the client's choice, not the profile's: the plain error.
			expect(await start("b", { backend: "claude-code" })).toMatchObject({
				ok: false,
				error: { code: "missing_api_key", message: "No test key." },
			});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("RpcServer permission modes", () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "atelier-rpc-mode-home-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	const started: FakeStep = { event: { type: "session_started", backend: "fake", model: "m", authSource: "none" } };

	function serve() {
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		const server = new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => new FakeBackend([[started, { event: finished }]]),
			tools: [],
			systemPromptAppend: "",
			home,
		});
		const done = server.run();
		let next = 0;
		const ask = async (command: Record<string, unknown>) => {
			const id = `m${++next}`;
			input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
			for (let i = 0; i < 200; i++) {
				const found = messages.find((m) => m.type === "response" && m.id === id);
				if (found) return found as Extract<ServerMessage, { type: "response" }>;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`No response to ${id}`);
		};
		const eventsOf = (sessionId: string) =>
			messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
		/** Runs one turn and returns the modes its session_started events said. */
		const turnModes = async (sessionId: string) => {
			expect((await ask({ command: "session.send", sessionId, prompt: "hi" })).ok).toBe(true);
			for (let i = 0; i < 200 && !eventsOf(sessionId).some((e) => e.type === "turn_finished"); i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			return eventsOf(sessionId).flatMap((e) => (e.type === "session_started" ? [e.permissionMode] : []));
		};
		const open = async (extra: Record<string, unknown> = {}) => {
			const response = await ask({ command: "session.start", cwd, ...extra });
			return (response as unknown as { result: { sessionId: string } }).result.sessionId;
		};
		const errors = (sessionId: string) => eventsOf(sessionId).filter((e) => e.type === "error");
		const close = () => {
			input.end();
			return done;
		};
		return { ask, open, turnModes, errors, close };
	}

	const writeDefault = async (text: string) => {
		await mkdir(join(home, ".atelier"), { recursive: true });
		await writeFile(join(home, ".atelier", "permission-mode.json"), text);
	};

	it("starts a session in the mode the command asks for, over the default file", async () => {
		await writeDefault(JSON.stringify({ kind: "atelier.permission_mode", version: 1, default: "auto" }));
		const h = serve();
		const sessionId = await h.open({ mode: "yolo" });
		expect(await h.turnModes(sessionId)).toEqual(["yolo"]);
		await h.close();
	});

	it("reads the default from the server's home when the command gives no mode", async () => {
		await writeDefault(JSON.stringify({ kind: "atelier.permission_mode", version: 1, default: "auto" }));
		const h = serve();
		const sessionId = await h.open({ autoApprove: true });
		expect(await h.turnModes(sessionId)).toEqual(["auto"]);
		expect(h.errors(sessionId)).toEqual([]);
		await h.close();
	});

	it("starts in normal and warns once when the default file is invalid", async () => {
		await writeDefault("{nope");
		const h = serve();
		const sessionId = await h.open();
		expect(await h.turnModes(sessionId)).toEqual(["normal"]);
		expect(h.errors(sessionId)).toMatchObject([
			{
				code: "permission_mode_invalid",
				message: `${join(home, ".atelier", "permission-mode.json")}: not valid JSON; using normal`,
				recoverable: true,
			},
		]);
		await h.close();
	});

	it("does not warn about an invalid default file when the command gives the mode", async () => {
		await writeDefault("{nope");
		const h = serve();
		const sessionId = await h.open({ mode: "auto" });
		expect(await h.turnModes(sessionId)).toEqual(["auto"]);
		expect(h.errors(sessionId)).toEqual([]);
		await h.close();
	});

	it("session.set_mode answers the mode and the next turn runs in it", async () => {
		const h = serve();
		const sessionId = await h.open();
		const response = await h.ask({ command: "session.set_mode", sessionId, mode: "yolo" });
		expect(response).toMatchObject({ ok: true, result: { mode: "yolo" } });
		expect(await h.turnModes(sessionId)).toEqual(["yolo"]);
		await h.close();
	});

	it("session.set_mode on an unknown session is answered like the other session commands", async () => {
		const h = serve();
		expect(await h.ask({ command: "session.set_mode", sessionId: "nope", mode: "auto" })).toMatchObject({
			ok: false,
			error: { code: "unknown_session", message: "No session nope." },
		});
		await h.close();
	});
});
