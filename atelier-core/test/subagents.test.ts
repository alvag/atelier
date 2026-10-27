import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentBackend } from "../src/backend.ts";
import {
	type ApprovalRequest,
	type AtelierEvent,
	type AtelierEventBody,
	createBashTool,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { BUILTIN_AGENTS, REPORT_LIMIT, type SubagentDefinition, TASK_TOOL } from "../src/subagents/definitions.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import { defineTool, type ToolDefinition } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });

const tool = (name: string): ToolDefinition =>
	defineTool({
		name,
		description: name,
		inputShape: { path: z.string().optional() },
		...(name === "bash" ? { approvalCommand: () => "rm -rf build" } : {}),
		execute: async () => ({ ok: true, output: `${name} ran`, summary: name, truncated: false }),
	});
const tools = ["read", "edit", "bash", "grep"].map(tool);

const explorer: SubagentDefinition = {
	name: "explorer",
	description: "Reads code",
	tools: ["read", "grep"],
	prompt: "EXPLORER PROMPT",
	models: { fake: "cheap-model" },
	maxRequests: 30,
};
const worker: SubagentDefinition = {
	name: "worker",
	description: "Changes code",
	tools: ["read", "edit", "grep", "bash"],
	prompt: "WORKER PROMPT",
	models: {},
	maxRequests: 50,
};

/** A parent whose first turn calls task, and child backends that play `childTurns`. */
async function run(childTurns: FakeStep[][], input: unknown = { agent: "explorer", prompt: "Find the slug code." }) {
	const parent = new FakeBackend([
		[{ toolCall: { tool: "task", input: input as never, callId: "c1" } }, { event: finished }],
	]);
	const children: FakeBackend[] = [];
	const options: SessionOptions = {
		backend: parent,
		cwd: process.cwd(),
		model: "parent-model",
		tools,
		subagents: {
			agents: [explorer, worker],
			createBackend: () => {
				const child = new FakeBackend([childTurns[children.length] ?? []]);
				children.push(child);
				return child;
			},
		},
	};
	const session = await Session.start(options);
	try {
		for await (const _ of session.send("go")) {
		}
	} finally {
		await session.close();
	}
	return { parent, children, result: parent.toolResults[0] };
}

describe("task", () => {
	it("is offered to the parent only when subagents are configured, listing the agents", async () => {
		const plain = new FakeBackend([]);
		await (await Session.start({ backend: plain, cwd: process.cwd(), tools })).close();
		expect(plain.startOptions?.tools.map((t) => t.name)).toEqual(["read", "edit", "bash", "grep"]);

		const { parent } = await run([[text("ok"), { event: finished }]]);
		const names = parent.startOptions?.tools.map((t) => t.name);
		expect(names).toEqual(["read", "edit", "bash", "grep", TASK_TOOL]);
		const task = parent.startOptions?.tools.find((t) => t.name === TASK_TOOL);
		expect(task?.description).toContain("explorer: Reads code");
		expect(task?.description).toContain("worker: Changes code");
	});

	it("starts the child with only the task prompt, its definition's prompt, model and tools, and no task", async () => {
		const { children } = await run([[text("Report."), { event: finished }]]);
		const child = children[0] as FakeBackend;
		expect(child.prompts).toEqual(["Find the slug code."]);
		expect(child.startOptions?.systemPromptAppend).toBe("EXPLORER PROMPT");
		expect(child.startOptions?.model).toBe("cheap-model");
		expect(child.startOptions?.maxRequestsPerTurn).toBe(30);
		expect(child.startOptions?.tools.map((t) => t.name)).toEqual(["read", "grep"]);
		expect(child.closed).toBe(true);
	});

	it("uses the parent's model when the definition has none for this backend", async () => {
		const { children } = await run([[text("Done."), { event: finished }]], { agent: "worker", prompt: "Change it." });
		expect(children[0]?.startOptions?.model).toBe("parent-model");
		expect(children[0]?.startOptions?.tools.map((t) => t.name)).toEqual(["read", "edit", "grep", "bash"]);
	});

	it("returns the child's last text, after its last tool call, as the report", async () => {
		const { result } = await run([
			[
				text("Let me look."),
				{ toolCall: { tool: "read", input: { path: "a" } } },
				text("The slug code "),
				text("is in src/slug.js:2."),
				{ event: finished },
			],
		]);
		expect(result).toEqual({ ok: true, output: "The slug code is in src/slug.js:2." });
	});

	it("bounds the report in code and marks the cut", async () => {
		const { result } = await run([[text("x".repeat(REPORT_LIMIT + 500)), { event: finished }]]);
		expect(REPORT_LIMIT).toBe(8000);
		expect(result).toEqual({
			ok: true,
			output: `${"x".repeat(REPORT_LIMIT)}\n[report truncated at 8000 characters]`,
		});
	});

	it("fails when the child produced no report", async () => {
		const { result } = await run([[{ toolCall: { tool: "read", input: {} } }, { event: finished }]]);
		expect(result).toEqual({ ok: false, output: "The explorer subagent returned no report." });
	});

	it("fails with the child's error when its turn fails", async () => {
		const { result } = await run([
			[
				text("partial"),
				{ event: { type: "error", code: "overloaded", message: "Overloaded", recoverable: true } },
				{ event: { type: "turn_finished", stopReason: "error", usage } },
			],
		]);
		expect(result).toEqual({ ok: false, output: "The explorer subagent failed (error): overloaded: Overloaded" });
	});

	it("fails when the child cannot start", async () => {
		const parent = new FakeBackend([
			[{ toolCall: { tool: "task", input: { agent: "explorer", prompt: "x" } } }, { event: finished }],
		]);
		const broken: AgentBackend = {
			id: "fake",
			start: async () => {
				throw new Error("no API key");
			},
		};
		const session = await Session.start({
			backend: parent,
			cwd: process.cwd(),
			tools,
			subagents: { agents: [explorer], createBackend: () => broken },
		});
		for await (const _ of session.send("go")) {
		}
		await session.close();
		expect(parent.toolResults[0]).toEqual({ ok: false, output: "The explorer subagent could not start: no API key" });
	});

	it("never gives a child the task tool, even if its definition lists it", async () => {
		const parent = new FakeBackend([
			[{ toolCall: { tool: "task", input: { agent: "nested", prompt: "x" } } }, { event: finished }],
		]);
		const child = new FakeBackend([[text("ok"), { event: finished }]]);
		const nested: SubagentDefinition = { ...explorer, name: "nested", tools: ["read", TASK_TOOL] };
		const session = await Session.start({
			backend: parent,
			cwd: process.cwd(),
			tools,
			subagents: { agents: [nested], createBackend: () => child },
		});
		for await (const _ of session.send("go")) {
		}
		await session.close();
		expect(child.startOptions?.tools.map((t) => t.name)).toEqual(["read"]);
	});

	it("rejects an unknown agent as invalid input without starting anything", async () => {
		const { children, result } = await run([], { agent: "hacker", prompt: "x" });
		expect(children).toEqual([]);
		expect(result?.ok).toBe(false);
		expect(result?.output).toMatch(/^Invalid input/);
	});
});

describe("builtin agents", () => {
	it("are explorer (read-only) and worker, both on the parent's model", () => {
		expect(BUILTIN_AGENTS.map((a) => [a.name, a.tools, a.maxRequests])).toEqual([
			["explorer", ["read", "grep", "web_fetch"], 30],
			["worker", ["read", "edit", "write", "grep", "bash", "web_fetch"], 50],
		]);
		expect(BUILTIN_AGENTS[0]?.models).toEqual({});
		expect(BUILTIN_AGENTS[1]?.models).toEqual({});
		for (const agent of BUILTIN_AGENTS) expect(agent.prompt).toContain("path:line");
	});
});

/** A parent session whose first turn calls task once; child backends play `childTurns`. */
async function start(childTurns: FakeStep[][], extra: Partial<SessionOptions> = {}, agent = "worker") {
	const parentUsage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 };
	const parent = new FakeBackend([
		[
			{ toolCall: { tool: "task", input: { agent, prompt: "Do it." }, callId: "c1" } },
			{ event: { type: "turn_finished", stopReason: "end_turn", usage: parentUsage } },
		],
	]);
	const children: FakeBackend[] = [];
	const session = await Session.start({
		backend: parent,
		cwd: process.cwd(),
		tools,
		createId: (() => {
			let n = 0;
			return () => `id-${++n}`;
		})(),
		subagents: {
			agents: [explorer, worker],
			createBackend: () => {
				const child = new FakeBackend([childTurns[children.length] ?? []]);
				children.push(child);
				return child;
			},
		},
		...extra,
	});
	return { session, parent, children, parentUsage };
}

async function collectTurn(session: Session, onEvent?: (event: AtelierEvent) => Promise<void> | void) {
	const events: AtelierEvent[] = [];
	for await (const event of session.send("go", "t1")) {
		events.push(event);
		await onEvent?.(event);
	}
	return events;
}

describe("subagent events and control", () => {
	it("forwards the child's events into the parent's turn, tagged with the task call and the agent", async () => {
		const childUsage = { input: 50, output: 9, cacheRead: 0, cacheWrite: 0 };
		const { session, parentUsage } = await start([
			[
				{ event: { type: "session_started", backend: "fake", model: "m", authSource: "api_key" } },
				{ toolCall: { tool: "read", input: { path: "a" }, callId: "r1" } },
				text("Report."),
				{ event: { type: "turn_finished", stopReason: "end_turn", usage: childUsage } },
			],
		]);
		const events = await collectTurn(session);
		await session.close();
		expect(events.map((e) => [e.seq, e.turnId, e.type, e.parentCallId, e.agent])).toEqual([
			[1, "t1", "tool_call_started", undefined, undefined],
			[2, "t1", "session_started", "c1", "worker"],
			[3, "t1", "tool_call_started", "c1", "worker"],
			[4, "t1", "tool_call_finished", "c1", "worker"],
			[5, "t1", "text_delta", "c1", "worker"],
			[6, "t1", "turn_finished", "c1", "worker"],
			[7, "t1", "tool_call_finished", undefined, undefined],
			[8, "t1", "turn_finished", undefined, undefined],
		]);
		expect(events[5]).toMatchObject({ usage: childUsage });
		// The parent's own turn_finished counts only the parent.
		expect(events[7]).toMatchObject({ usage: parentUsage });
	});

	it("asks the parent's approver for the child's commands and tags the request", async () => {
		const asked: string[] = [];
		const { session } = await start(
			[[{ toolCall: { tool: "bash", input: {}, callId: "b1" } }, text("Done."), { event: finished }]],
			{
				approve: async ({ callId, command }) => {
					asked.push(`${callId} ${command}`);
					return true;
				},
			},
		);
		const events = await collectTurn(session);
		await session.close();
		expect(asked).toEqual(["b1 rm -rf build"]);
		expect(events.find((e) => e.type === "approval_requested")).toMatchObject({
			callId: "b1",
			command: "rm -rf build",
			parentCallId: "c1",
			agent: "worker",
		});
	});

	it("does not pass the mode to the child: it runs in normal", async () => {
		const asked: string[] = [];
		const { session } = await start(
			[[{ toolCall: { tool: "bash", input: {}, callId: "b1" } }, text("Done."), { event: finished }]],
			{
				permissionMode: "yolo",
				approve: async ({ callId }) => {
					asked.push(callId);
					return false;
				},
			},
		);
		const events = await collectTurn(session);
		await session.close();
		expect(asked).toEqual(["b1"]);
		expect(events.find((e) => e.type === "approval_requested")).toMatchObject({ callId: "b1", agent: "worker" });
	});

	it("asks for a worker's recursive removal even when the parent is in yolo, naming the rule", async () => {
		const asked: ApprovalRequest[] = [];
		const manager: SandboxManagerLike = {
			isSupportedPlatform: () => true,
			checkDependencies: () => ({ errors: [], warnings: [] }),
			initialize: async () => {},
			wrapWithSandbox: async (command) => command,
			cleanupAfterCommand: () => {},
			reset: async () => {},
		};
		const bash = createBashTool({ sandbox: new Sandbox({ platform: "darwin", manager }) });
		const { session } = await start(
			[
				[
					{ toolCall: { tool: "bash", input: { command: "rm -r build" }, callId: "b1" } },
					text("Done."),
					{ event: finished },
				],
			],
			{
				permissionMode: "yolo",
				tools: [...tools.filter((item) => item.name !== "bash"), bash],
				approve: async (request) => {
					asked.push(request);
					return false;
				},
			},
		);
		const events = await collectTurn(session);
		await session.close();
		expect(asked).toEqual([{ callId: "b1", command: "rm -r build", confirm: "recursive removal" }]);
		expect(events.find((e) => e.type === "approval_requested")).toMatchObject({
			callId: "b1",
			confirm: "recursive removal",
			agent: "worker",
		});
	});

	it("interrupts the child when the parent's turn is interrupted", async () => {
		const { session, children, parent } = await start([[text("Working"), { waitForInterrupt: true }]]);
		const events = await collectTurn(session, async (event) => {
			if (event.type === "text_delta" && event.parentCallId === "c1") await session.interrupt();
		});
		await session.close();
		expect(children[0]?.interrupts).toBe(1);
		expect(parent.toolResults[0]).toEqual({
			ok: false,
			output: "The worker subagent failed (interrupted): no details",
		});
		expect(events.map((e) => [e.type, e.parentCallId])).toEqual([
			["tool_call_started", undefined],
			["text_delta", "c1"],
			["turn_finished", "c1"],
			["tool_call_finished", undefined],
			["turn_finished", undefined],
		]);
		expect(events[2]).toMatchObject({ stopReason: "interrupted" });
	});

	it("closes a running child when the parent session closes", async () => {
		const { session, children } = await start([[text("Working"), { hang: true }]]);
		const turn = collectTurn(session, async (event) => {
			if (event.type === "text_delta" && event.parentCallId === "c1") await session.close();
		});
		await turn;
		expect(children[0]?.closed).toBe(true);
	});
});
