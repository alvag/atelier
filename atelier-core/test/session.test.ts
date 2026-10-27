import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEvent,
	type AtelierEventBody,
	defineTool,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
	type ToolDefinition,
} from "../src/index.ts";

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };

function counter() {
	let n = 0;
	return () => `id-${++n}`;
}

async function collect(events: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

function echoTool(executed: string[]): ToolDefinition {
	return defineTool({
		name: "echo",
		description: "Echoes text",
		inputShape: { text: z.string() },
		execute: async ({ text }) => {
			executed.push(text);
			return { ok: true, output: `echo: ${text}`, summary: `echoed ${text}`, truncated: false };
		},
	});
}

function shellTool(executed: string[]): ToolDefinition {
	return defineTool({
		name: "shell",
		description: "Runs a command",
		inputShape: { command: z.string() },
		approvalCommand: ({ command }) => command,
		execute: async ({ command }) => {
			executed.push(command);
			return { ok: true, output: "done", summary: command, truncated: false };
		},
	});
}

async function start(turns: FakeStep[][], options: Partial<SessionOptions> = {}) {
	const backend = new FakeBackend(turns);
	const session = await Session.start({ backend, cwd: "/work", tools: [], createId: counter(), ...options });
	return { backend, session };
}

describe("Session", () => {
	it("passes cwd, model, tools and a byte-stable prompt append to the backend", async () => {
		const tools = [echoTool([])];
		const { backend } = await start([], { model: "opus", tools, systemPromptAppend: "be brief" });
		expect(backend.startOptions).toMatchObject({ cwd: "/work", model: "opus", tools, systemPromptAppend: "be brief" });
	});

	it("stamps events with an increasing seq and one turnId per turn", async () => {
		const { session } = await start([
			[{ event: { type: "text_delta", text: "a" } }, { event: { type: "text_delta", text: "b" } }, { event: finished }],
			[{ event: finished }],
		]);
		const first = await collect(session.send("one"));
		const second = await collect(session.send("two"));

		expect(first).toEqual([
			{ type: "text_delta", text: "a", seq: 1, turnId: "id-1" },
			{ type: "text_delta", text: "b", seq: 2, turnId: "id-1" },
			{
				...finished,
				phases: { main: { usage } },
				durationMs: expect.any(Number),
				at: expect.any(String),
				seq: 3,
				turnId: "id-1",
			},
		]);
		expect(second).toEqual([
			{
				...finished,
				phases: { main: { usage } },
				durationMs: expect.any(Number),
				at: expect.any(String),
				seq: 1,
				turnId: "id-2",
			},
		]);
	});

	it("produces only JSON-serializable events", async () => {
		const { session } = await start([[{ throw: "boom" }]]);
		const events = await collect(session.send("x"));
		expect(JSON.parse(JSON.stringify(events))).toEqual(events);
	});

	it("executes tool calls in the core and reports them as events", async () => {
		const executed: string[] = [];
		const { backend, session } = await start(
			[[{ toolCall: { tool: "echo", input: { text: "hi" }, callId: "c1" } }, { event: finished }]],
			{ tools: [echoTool(executed)] },
		);
		const events = await collect(session.send("x"));

		expect(executed).toEqual(["hi"]);
		expect(backend.toolResults).toEqual([{ ok: true, output: "echo: hi" }]);
		expect(events.map(({ seq: _seq, turnId: _turnId, ...body }) => body)).toEqual([
			{ type: "tool_call_started", callId: "c1", tool: "echo", input: { text: "hi" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "echoed hi", truncated: false },
			{ ...finished, phases: { main: { usage } }, durationMs: expect.any(Number), at: expect.any(String) },
		]);
	});

	it("generates a callId when the backend does not provide one", async () => {
		const { session } = await start([[{ toolCall: { tool: "echo", input: { text: "hi" } } }, { event: finished }]], {
			tools: [echoTool([])],
		});
		const events = await collect(session.send("x"));
		expect(events[0]).toMatchObject({ type: "tool_call_started", callId: "id-2" });
		expect(events[1]).toMatchObject({ type: "tool_call_finished", callId: "id-2" });
	});

	it("rejects unknown tools and invalid input without executing anything", async () => {
		const executed: string[] = [];
		const { backend, session } = await start(
			[
				[
					{ toolCall: { tool: "nope", input: {}, callId: "c1" } },
					{ toolCall: { tool: "echo", input: { text: 42 }, callId: "c2" } },
					{ event: finished },
				],
			],
			{ tools: [echoTool(executed)] },
		);
		const events = await collect(session.send("x"));

		expect(executed).toEqual([]);
		expect(backend.toolResults[0]).toEqual({ ok: false, output: "Unknown tool: nope" });
		expect(backend.toolResults[1]?.ok).toBe(false);
		expect(backend.toolResults[1]?.output).toMatch(/^Invalid input: /);
		expect(events.filter((e) => e.type === "tool_call_finished").map((e) => e.ok)).toEqual([false, false]);
	});

	it("turns a throwing tool into a failed result instead of breaking the turn", async () => {
		const broken = defineTool({
			name: "broken",
			description: "Always throws",
			inputShape: {},
			execute: async () => {
				throw new Error("disk full");
			},
		});
		const { backend, session } = await start([[{ toolCall: { tool: "broken", input: {} } }, { event: finished }]], {
			tools: [broken],
		});
		const events = await collect(session.send("x"));
		expect(backend.toolResults).toEqual([{ ok: false, output: "Tool failed: disk full" }]);
		expect(events.at(-1)).toMatchObject(finished);
	});

	describe("approval", () => {
		const turn: FakeStep[][] = [[{ toolCall: { tool: "shell", input: { command: "rm x" }, callId: "c1" } }]];

		it("asks before running and runs when approved", async () => {
			const executed: string[] = [];
			const requests: unknown[] = [];
			const { session } = await start(turn, {
				tools: [shellTool(executed)],
				approve: async (request) => {
					requests.push(request);
					return true;
				},
			});
			const events = await collect(session.send("x"));

			expect(requests).toEqual([{ callId: "c1", command: "rm x" }]);
			expect(executed).toEqual(["rm x"]);
			expect(events.map((e) => e.type)).toEqual([
				"tool_call_started",
				"approval_requested",
				"tool_call_finished",
				"turn_finished",
			]);
			expect(events[1]).toMatchObject({ callId: "c1", command: "rm x" });
		});

		it("calls approve only after the consumer took every event emitted before the question", async () => {
			const log: string[] = [];
			const { session } = await start(turn, {
				tools: [shellTool([])],
				approve: async () => {
					log.push("approve");
					return true;
				},
			});
			for await (const event of session.send("x")) {
				log.push(event.type);
				// A slow consumer: the producer is ahead of it while it waits.
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(log).toEqual([
				"tool_call_started",
				"approval_requested",
				"approve",
				"tool_call_finished",
				"turn_finished",
			]);
		});

		it("ends the turn when the client stops reading before the question", async () => {
			const approvals: unknown[] = [];
			const { session } = await start(turn, {
				tools: [shellTool([])],
				approve: async (request) => {
					approvals.push(request);
					return true;
				},
			});
			for await (const _event of session.send("x")) break;
			expect(approvals).toEqual([]);
			expect(session.busy).toBe(false);
		});

		it("finishes an interrupted turn whose question is waiting for the consumer", async () => {
			const approvals: unknown[] = [];
			const { session } = await start(turn, {
				tools: [shellTool([])],
				approve: async (request) => {
					approvals.push(request);
					return true;
				},
			});
			const events: AtelierEvent[] = [];
			for await (const event of session.send("x")) {
				events.push(event);
				if (event.type === "tool_call_started") await session.interrupt();
			}
			expect(approvals).toEqual([]);
			expect(events.at(-1)).toMatchObject({ type: "turn_finished" });
			expect(session.busy).toBe(false);
		});

		it("does not run a denied command and tells the model", async () => {
			const executed: string[] = [];
			const { backend, session } = await start(turn, { tools: [shellTool(executed)], approve: async () => false });
			await collect(session.send("x"));
			expect(executed).toEqual([]);
			expect(backend.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
		});

		it("denies by default when nobody can approve", async () => {
			const executed: string[] = [];
			const { session } = await start(turn, { tools: [shellTool(executed)] });
			await collect(session.send("x"));
			expect(executed).toEqual([]);
		});

		it("asks in auto too", async () => {
			const executed: string[] = [];
			const requests: unknown[] = [];
			const { session } = await start(turn, {
				tools: [shellTool(executed)],
				permissionMode: "auto",
				approve: async (request) => {
					requests.push(request);
					return true;
				},
			});
			await collect(session.send("x"));
			expect(requests).toEqual([{ callId: "c1", command: "rm x" }]);
			expect(executed).toEqual(["rm x"]);
		});

		it("skips the question in yolo", async () => {
			const executed: string[] = [];
			const { session } = await start(turn, { tools: [shellTool(executed)], permissionMode: "yolo" });
			const events = await collect(session.send("x"));
			expect(executed).toEqual(["rm x"]);
			expect(events.some((e) => e.type === "approval_requested")).toBe(false);
		});
	});

	describe("permission mode", () => {
		const started: FakeStep = {
			event: { type: "session_started", backend: "fake", model: "m", authSource: "none" },
		};

		it.each([
			["normal by default", {}, "normal"],
			["normal", { permissionMode: "normal" }, "normal"],
			["auto", { permissionMode: "auto" }, "auto"],
			["yolo", { permissionMode: "yolo" }, "yolo"],
		] as const)("session_started says %s", async (_name, options, mode) => {
			const { session } = await start([[started, { event: finished }]], options);
			const events = await collect(session.send("x"));
			expect(events.find((e) => e.type === "session_started")).toMatchObject({ permissionMode: mode });
		});
	});

	describe("turn_finished", () => {
		it("emits an error event and a final turn_finished when the backend throws", async () => {
			const { session } = await start([[{ event: { type: "text_delta", text: "a" } }, { throw: "network down" }]]);
			const events = await collect(session.send("x"));
			expect(events.map(({ seq: _seq, turnId: _turnId, ...body }) => body)).toEqual([
				{ type: "text_delta", text: "a" },
				{ type: "error", code: "backend_error", message: "network down", recoverable: false },
				{
					type: "turn_finished",
					stopReason: "error",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					phases: { main: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
					durationMs: expect.any(Number),
					at: expect.any(String),
				},
			]);
		});

		it("synthesizes turn_finished when the backend ends without one", async () => {
			const { session } = await start([[{ event: { type: "text_delta", text: "a" } }]]);
			const events = await collect(session.send("x"));
			expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "incomplete" });
		});

		it("keeps exactly one turn_finished, always last", async () => {
			const { session } = await start([
				[
					{ event: finished },
					{ event: { type: "text_delta", text: "late" } },
					{ event: { ...finished, stopReason: "dup" } },
				],
			]);
			const events = await collect(session.send("x"));
			expect(events.filter((e) => e.type === "turn_finished")).toHaveLength(1);
			expect(events.at(-1)).toMatchObject(finished);
			expect(events.map((e) => e.seq)).toEqual([1, 2]);
		});

		it("reports the turn's wall time in durationMs, tool time included", async () => {
			const slow = defineTool({
				name: "slow",
				description: "Waits a bit",
				inputShape: {},
				execute: async () => {
					await new Promise((resolve) => setTimeout(resolve, 30));
					return { ok: true, output: "", summary: "waited", truncated: false };
				},
			});
			const { session } = await start([[{ toolCall: { tool: "slow", input: {} } }, { event: finished }]], {
				tools: [slow],
			});
			const events = await collect(session.send("x"));
			const last = events.at(-1);
			const durationMs = last?.type === "turn_finished" ? last.durationMs : undefined;
			expect(Number.isInteger(durationMs)).toBe(true);
			expect(durationMs).toBeGreaterThanOrEqual(25);
		});

		it("says when the turn ended in at, as an ISO time", async () => {
			const { session } = await start([[{ event: finished }]]);
			const before = Date.now();
			const events = await collect(session.send("x"));
			const last = events.at(-1);
			const at = last?.type === "turn_finished" ? last.at : undefined;
			expect(at).toBe(new Date(Date.parse(at ?? "")).toISOString());
			expect(Date.parse(at ?? "")).toBeGreaterThanOrEqual(before);
			expect(Date.parse(at ?? "")).toBeLessThanOrEqual(Date.now());
		});
	});

	it("interrupts the running turn", async () => {
		const { backend, session } = await start([
			[{ event: { type: "text_delta", text: "a" } }, { waitForInterrupt: true }],
		]);
		const events: AtelierEvent[] = [];
		for await (const event of session.send("x")) {
			events.push(event);
			if (event.type === "text_delta") await session.interrupt();
		}
		expect(backend.interrupts).toBe(1);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "interrupted" });
		expect(session.busy).toBe(false);
	});

	it("aborts a running tool when the turn is interrupted", async () => {
		let aborted = false;
		const slow = defineTool({
			name: "slow",
			description: "Waits for abort",
			inputShape: {},
			execute: (_input, { signal }) =>
				new Promise((resolve) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
						resolve({ ok: false, output: "aborted", summary: "aborted", truncated: false });
					});
				}),
		});
		const { backend, session } = await start([[{ toolCall: { tool: "slow", input: {}, callId: "c1" } }]], {
			tools: [slow],
		});
		const events: AtelierEvent[] = [];
		for await (const event of session.send("x")) {
			events.push(event);
			if (event.type === "tool_call_started") await session.interrupt();
		}
		expect(aborted).toBe(true);
		expect(backend.toolResults).toEqual([{ ok: false, output: "aborted" }]);
		expect(events.at(-1)?.type).toBe("turn_finished");
	});

	it("interrupts the backend when the client stops reading", async () => {
		const { backend, session } = await start([
			[{ event: { type: "text_delta", text: "a" } }, { waitForInterrupt: true }],
		]);
		for await (const _event of session.send("x")) break;
		expect(backend.interrupts).toBe(1);
		expect(session.busy).toBe(false);
	});

	it("rejects a second turn while one is running", async () => {
		const { backend, session } = await start([[{ waitForInterrupt: true }]]);
		const first = session.send("one");
		const pending = first.next();
		await Promise.resolve();
		const second = await collect(session.send("two"));

		expect(second.map((e) => e.type)).toEqual(["error", "turn_finished"]);
		expect(second[0]).toMatchObject({ code: "busy", recoverable: true });
		expect(backend.prompts).toEqual(["one"]);

		await session.interrupt();
		await pending;
		await collect(first);
	});

	it("makes every close call wait for the backend to finish closing", async () => {
		let finishClose: () => void = () => {};
		const backend = {
			id: "slow-close",
			start: async () => ({
				async *send() {},
				interrupt: async () => {},
				close: () =>
					new Promise<void>((resolve) => {
						finishClose = resolve;
					}),
			}),
		};
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		let secondDone = false;
		void session.close();
		const second = session.close().then(() => {
			secondDone = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(secondDone).toBe(false);
		finishClose();
		await second;
		expect(secondDone).toBe(true);
	});

	it("gives tools a scratch directory and deletes it on close", async () => {
		const seen: (string | undefined)[] = [];
		const probe = defineTool({
			name: "probe",
			description: "Records the scratch directory",
			inputShape: {},
			execute: async (_input, { scratchDir }) => {
				seen.push(scratchDir);
				return { ok: true, output: "", summary: "", truncated: false };
			},
		});
		const { session } = await start([[{ toolCall: { tool: "probe", input: {} } }, { event: finished }]], {
			tools: [probe],
		});
		await collect(session.send("x"));
		const dir = seen[0] as string;
		expect((await stat(dir)).isDirectory()).toBe(true);
		await session.close();
		await expect(stat(dir)).rejects.toThrow();
	});

	it("refuses turns after close", async () => {
		const { backend, session } = await start([[{ event: finished }]]);
		await session.close();
		const events = await collect(session.send("x"));
		expect(backend.closed).toBe(true);
		expect(events[0]).toMatchObject({ type: "error", code: "session_closed" });
		expect(backend.prompts).toEqual([]);
	});
});
