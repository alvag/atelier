import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEvent,
	type AtelierEventBody,
	decodeServerMessage,
	FakeBackend,
	FakeMemory,
	type FakeStep,
	MemoryError,
	RpcServer,
	type ServerMessage,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { MemoryUnavailableError } from "../src/memory/port.ts";
import { findSecret } from "../src/memory/tool.ts";
import { defineTool } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const call = (tool: string, input: Record<string, unknown>, callId = `c-${tool}`): FakeStep => ({
	toolCall: { tool, input: input as never, callId },
});
const tools = ["read", "edit", "bash", "grep"].map((name) =>
	defineTool({
		name,
		description: name,
		inputShape: { path: z.string().optional() },
		execute: async () => ({ ok: true, output: `${name} ran`, summary: name, truncated: false }),
	}),
);

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-memory-session-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

async function session(turns: FakeStep[][], extra: Partial<SessionOptions> = {}, memory = new FakeMemory("proj")) {
	const backend = new FakeBackend(turns);
	const s = await Session.start({ backend, cwd, tools, memory, ...extra });
	const send = async (prompt: string) => {
		const events: AtelierEvent[] = [];
		for await (const event of s.send(prompt)) events.push(event);
		return events;
	};
	return { backend, memory, session: s, send };
}

const SAVE = { action: "save", title: "Use MCP", type: "decision", content: "**What**: MCP over stdio" };

describe("memory tool", () => {
	it("is offered only with memory, and never to subagents", async () => {
		const none = new FakeBackend([]);
		await (await Session.start({ backend: none, cwd, tools })).close();
		expect(none.startOptions?.tools.map((t) => t.name)).not.toContain("memory");

		const child = new FakeBackend([[{ event: { type: "text_delta", text: "r" } }, { event: finished }]]);
		const {
			backend,
			session: s,
			send,
		} = await session([[call("task", { agent: "w", prompt: "x" }), { event: finished }]], {
			subagents: {
				agents: [{ name: "w", description: "w", tools: ["read", "memory"], prompt: "p", models: {}, maxRequests: 5 }],
				createBackend: () => child,
			},
		});
		await send("go");
		await s.close();
		expect(backend.startOptions?.tools.map((t) => t.name)).toContain("memory");
		expect(child.startOptions?.tools.map((t) => t.name)).toEqual(["read"]);
	});

	it("saves, searches and gets", async () => {
		const {
			backend,
			memory,
			session: s,
			send,
		} = await session([
			[
				call("memory", { ...SAVE, topicKey: "atelier/transport" }, "s"),
				call("memory", { action: "search", query: "MCP" }, "q"),
				call("memory", { action: "get", id: 1 }, "g"),
				{ event: finished },
			],
		]);
		await send("go");
		await s.close();
		expect(memory.entries).toEqual([
			{ id: 1, title: "Use MCP", type: "decision", content: "**What**: MCP over stdio", topicKey: "atelier/transport" },
		]);
		expect(backend.toolResults.map((r) => r.ok)).toEqual([true, true, true]);
		expect(backend.toolResults[0]?.output).toBe("Saved memory #1.");
		expect(backend.toolResults[1]?.output).toBe("#1 [decision] Use MCP — **What**: MCP over stdio");
		expect(backend.toolResults[2]?.output).toBe(
			"#1 [decision] Use MCP\nTopic: atelier/transport\n\n**What**: MCP over stdio",
		);
	});

	it.each([
		["an Anthropic key in the content", { content: "key sk-ant-api03-abcdefghijklmnopqrstuvwx" }],
		["a GitHub token in the title", { title: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
		["a private key block", { content: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" }],
	])("refuses to save %s and stores nothing", async (_name, override) => {
		const {
			backend,
			memory,
			session: s,
			send,
		} = await session([[call("memory", { ...SAVE, ...override }), { event: finished }]]);
		await send("go");
		await s.close();
		expect(memory.entries).toEqual([]);
		expect(backend.toolResults[0]?.ok).toBe(false);
		expect(backend.toolResults[0]?.output).toMatch(/secret/);
		expect(backend.toolResults[0]?.output).not.toMatch(/sk-ant|ghp_|BEGIN/);
	});

	it("reports a missing entry and memory failures as tool errors, without ending the turn", async () => {
		const failing = new FakeMemory("proj");
		failing.search = async () => {
			throw new MemoryError("Engram mem_search: boom");
		};
		const {
			backend,
			session: s,
			send,
		} = await session(
			[
				[
					call("memory", { action: "get", id: 9 }, "g"),
					call("memory", { action: "search", query: "x" }, "q"),
					{ event: finished },
				],
			],
			{},
			failing,
		);
		const events = await send("go");
		await s.close();
		expect(backend.toolResults).toEqual([
			{ ok: false, output: "No memory #9." },
			{ ok: false, output: "Memory failed: Engram mem_search: boom" },
		]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	});
});

describe("findSecret", () => {
	it("finds key-shaped text and nothing in ordinary prose", () => {
		expect(findSecret("aws AKIAABCDEFGHIJKLMNOP")).toBeDefined();
		expect(findSecret("slack xoxb-1234567890-abcdefghij")).toBeDefined();
		expect(findSecret("We chose MCP; see sk-ant docs and the github token setting.")).toBeUndefined();
	});
});

describe("memory in the session", () => {
	it("announces the memory and adds a compact context to the first prompt only, never to the system prompt", async () => {
		const memory = new FakeMemory("proj");
		await memory.save({ title: "Earlier decision", type: "decision", content: "x" });
		const {
			backend,
			session: s,
			send,
		} = await session([[{ event: finished }], [{ event: finished }]], { odd: true }, memory);
		const first = await send("hola");
		await send("segundo");
		await s.close();
		expect(first[0]).toMatchObject({ type: "memory_status", available: true, project: "proj" });
		expect(backend.prompts[0]).toBe("<memory>\n- [decision] Earlier decision\n</memory>\n\nhola");
		expect(backend.prompts[1]).toBe("segundo");
		expect(backend.startOptions?.systemPromptAppend).not.toContain("Earlier decision");
	});

	it("bounds the context to 2 KB", async () => {
		const memory = new FakeMemory("proj");
		for (let i = 0; i < 200; i++)
			await memory.save({ title: `Decision ${i} ${"x".repeat(30)}`, type: "decision", content: "x" });
		const { backend, session: s, send } = await session([[{ event: finished }]], {}, memory);
		await send("hola");
		await s.close();
		const block = (backend.prompts[0] as string).split("\n</memory>")[0] as string;
		expect(Buffer.byteLength(block)).toBeLessThanOrEqual(2048 + "<memory>\n".length);
	});

	it("says when there is no memory and why, and works without it", async () => {
		const backend = new FakeBackend([[{ event: { type: "text_delta", text: "ok" } }, { event: finished }]]);
		const s = await Session.start({
			backend,
			cwd,
			tools,
			memoryUnavailable: "Engram is not installed (no engram command).",
		});
		const events: AtelierEvent[] = [];
		for await (const event of s.send("hola")) events.push(event);
		await s.close();
		expect(events[0]).toMatchObject({
			type: "memory_status",
			available: false,
			reason: "Engram is not installed (no engram command).",
		});
		expect(backend.prompts).toEqual(["hola"]);
		expect(backend.startOptions?.tools.map((t) => t.name)).not.toContain("memory");
	});

	it("closes the memory with the session", async () => {
		const { memory, session: s } = await session([]);
		await s.close();
		expect(memory.closed).toBe(true);
	});
});

describe("feature mirror", () => {
	const START = {
		action: "start",
		name: "slug",
		title: "Slug",
		header: "",
		specs: ["S"],
		tasks: [
			{ title: "A", specs: ["S1"], route: "inline" },
			{ title: "B", specs: ["S1"], route: "inline" },
		],
	};

	it("saves the feature document once, when its last task closes", async () => {
		const {
			memory,
			session: s,
			send,
		} = await session(
			[
				[
					call("feature", START, "1"),
					call("feature", { action: "update_task", id: "T1", status: "done" }, "2"),
					call("feature", { action: "update_task", id: "T2", status: "dropped" }, "3"),
					call("feature", { action: "log", text: "after" }, "4"),
					{ event: finished },
				],
			],
			{ odd: true },
		);
		await send("track slug");
		await s.close();
		expect(memory.saved).toHaveLength(1);
		expect(memory.saved[0]).toMatchObject({
			title: "Feature slug: Slug",
			type: "architecture",
			topicKey: "odd/slug/tasks",
		});
		expect(memory.saved[0]?.content).toContain("| T2 | S1 | inline | B | dropped |");
	});

	it("does not mirror a document holding something that looks like a secret, and says so", async () => {
		const {
			memory,
			session: s,
			send,
		} = await session(
			[
				[
					call("feature", { ...START, tasks: [START.tasks[0]] }, "1"),
					call("feature", { action: "update_task", id: "T1", status: "done" }, "2"),
					{ event: finished },
				],
			],
			{ odd: true },
		);
		const events = await send("use sk-ant-api03-abcdefghijklmnopqrstuvwx for this");
		await s.close();
		expect(memory.saved).toEqual([]);
		expect(events.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({ code: "memory_mirror_skipped", recoverable: true }),
		]);
	});
});

describe("RpcServer memory", () => {
	async function serve(connectMemory: (cwd: string) => Promise<FakeMemory>) {
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		const backends: FakeBackend[] = [];
		void new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => {
				const backend = new FakeBackend([[{ event: finished }]]);
				backends.push(backend);
				return backend;
			},
			tools,
			systemPromptAppend: "",
			connectMemory,
		}).run();
		const waitFor = async (predicate: (m: ServerMessage) => boolean) => {
			for (let i = 0; i < 200; i++) {
				const found = messages.find(predicate);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`Timed out: ${JSON.stringify(messages)}`);
		};
		input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd })}\n`);
		const started = (await waitFor((m) => m.type === "response" && m.id === "s")) as unknown as {
			result: { sessionId: string };
		};
		input.write(
			`${JSON.stringify({ type: "command", id: "t", command: "session.send", sessionId: started.result.sessionId, prompt: "hi" })}\n`,
		);
		const status = await waitFor((m) => m.type === "event" && m.event.type === "memory_status");
		input.end();
		return { backends, status: (status as { event: AtelierEvent }).event };
	}

	it("connects memory for the session's folder and offers the tool", async () => {
		const folders: string[] = [];
		const { backends, status } = await serve(async (folder) => {
			folders.push(folder);
			return new FakeMemory("proj");
		});
		expect(folders).toEqual([cwd]);
		expect(backends[0]?.startOptions?.tools.map((t) => t.name)).toContain("memory");
		expect(status).toMatchObject({ available: true, project: "proj" });
	});

	it("starts the session without memory when it cannot connect, and says why", async () => {
		const { backends, status } = await serve(async () => {
			throw new MemoryUnavailableError("Engram is not installed (no engram command).");
		});
		expect(backends[0]?.startOptions?.tools.map((t) => t.name)).not.toContain("memory");
		expect(status).toMatchObject({ available: false, reason: "Engram is not installed (no engram command)." });
	});
});
