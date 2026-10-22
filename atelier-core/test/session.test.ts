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
			{ ...finished, seq: 3, turnId: "id-1" },
		]);
		expect(second).toEqual([{ ...finished, seq: 1, turnId: "id-2" }]);
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
			finished,
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

		it("skips the question with autoApprove", async () => {
			const executed: string[] = [];
			const { session } = await start(turn, { tools: [shellTool(executed)], autoApprove: true });
			const events = await collect(session.send("x"));
			expect(executed).toEqual(["rm x"]);
			expect(events.some((e) => e.type === "approval_requested")).toBe(false);
		});
	});

	describe("turn_finished", () => {
		it("emits an error event and a final turn_finished when the backend throws", async () => {
			const { session } = await start([[{ event: { type: "text_delta", text: "a" } }, { throw: "network down" }]]);
			const events = await collect(session.send("x"));
			expect(events.map(({ seq: _seq, turnId: _turnId, ...body }) => body)).toEqual([
				{ type: "text_delta", text: "a" },
				{ type: "error", code: "backend_error", message: "network down", recoverable: false },
				{ type: "turn_finished", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
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

	it("refuses turns after close", async () => {
		const { backend, session } = await start([[{ event: finished }]]);
		await session.close();
		const events = await collect(session.send("x"));
		expect(backend.closed).toBe(true);
		expect(events[0]).toMatchObject({ type: "error", code: "session_closed" });
		expect(backend.prompts).toEqual([]);
	});
});
