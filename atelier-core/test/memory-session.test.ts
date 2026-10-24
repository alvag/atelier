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
import { MEMORY_RULES } from "../src/prompt.ts";
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

	it("says when a save went through with a warning, to the agent and in the call's summary, without saving again", async () => {
		const warned = new FakeMemory("proj");
		const save = warned.save.bind(warned);
		warned.save = async (entry) => ({ ...(await save(entry)), warning: "conflict detection did not finish" });
		const { backend, session: s, send } = await session([[call("memory", SAVE), { event: finished }]], {}, warned);
		const events = await send("go");
		await s.close();
		const expected = "Saved memory #1. Warning: conflict detection did not finish";
		expect(warned.saved).toHaveLength(1);
		expect(backend.toolResults).toEqual([{ ok: true, output: expected }]);
		expect(events.find((e) => e.type === "tool_call_finished")).toMatchObject({ ok: true, summary: expected });
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
		expect(findSecret("temporary aws ASIAABCDEFGHIJKLMNOP")).toBeDefined();
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

	it("keeps the user's messages out of the mirror, so a secret pasted there never reaches memory", async () => {
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
		await send("use sk-ant-api03-abcdefghijklmnopqrstuvwx for this");
		await s.close();
		expect(memory.saved).toHaveLength(1);
		expect(memory.saved[0]?.content).not.toContain("sk-ant");
		expect(memory.saved[0]?.content).toContain("Usuario: (message kept only in the feature document)");
	});

	it("says when the mirror was saved with a warning, and saves it once", async () => {
		const warned = new FakeMemory("proj");
		const save = warned.save.bind(warned);
		warned.save = async (entry) => ({ ...(await save(entry)), warning: "conflict detection did not finish" });
		const { session: s, send } = await session(
			[
				[
					call("feature", { ...START, tasks: [START.tasks[0]] }, "1"),
					call("feature", { action: "update_task", id: "T1", status: "done" }, "2"),
					{ event: finished },
				],
			],
			{ odd: true },
			warned,
		);
		const events = await send("track it");
		await s.close();
		expect(warned.saved).toHaveLength(1);
		expect(events.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_mirror_warning",
				message: "Feature slug was saved to memory with a warning: conflict detection did not finish",
				recoverable: true,
			}),
		]);
	});

	it("does not mirror a document whose own text holds something that looks like a secret, and says so", async () => {
		const {
			memory,
			session: s,
			send,
		} = await session(
			[
				[
					call(
						"feature",
						{ ...START, specs: ["Use sk-ant-api03-abcdefghijklmnopqrstuvwx"], tasks: [START.tasks[0]] },
						"1",
					),
					call("feature", { action: "update_task", id: "T1", status: "done" }, "2"),
					{ event: finished },
				],
			],
			{ odd: true },
		);
		const events = await send("track it");
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

	it("survives a connector that throws instead of rejecting", async () => {
		const { status } = await serve((() => {
			throw new MemoryUnavailableError("sync failure");
		}) as never);
		expect(status).toMatchObject({ available: false, reason: "sync failure" });
	});

	it("starts the session without memory when it cannot connect, and says why", async () => {
		const { backends, status } = await serve(async () => {
			throw new MemoryUnavailableError("Engram is not installed (no engram command).");
		});
		expect(backends[0]?.startOptions?.tools.map((t) => t.name)).not.toContain("memory");
		expect(status).toMatchObject({ available: false, reason: "Engram is not installed (no engram command)." });
	});
});

describe("independent U2 regressions (S4, S1)", () => {
	const start = {
		action: "start",
		name: "probe",
		title: "Probe",
		header: "",
		specs: ["S"],
		tasks: [{ title: "A", specs: ["S1"], route: "inline" }],
	};
	const done = { action: "update_task", id: "T1", status: "done" };
	const keys = [
		`sk-proj-${"A1b2c3".repeat(20)}`,
		`github_pat_${"A1b2c3".repeat(13)}_abcdef`,
		`sk-ant-api03-\n${"x".repeat(40)}`,
	];
	it.each(keys)("rejects credentials through every save field and mirror: %s", async (key) => {
		for (const field of ["title", "content", "topicKey"]) {
			const r = await session([[call("memory", { ...SAVE, [field]: key }), { event: finished }]]);
			await r.send("go");
			await r.session.close();
			expect(r.memory.saved).toEqual([]);
			expect(r.backend.toolResults[0]).toMatchObject({ ok: false });
			expect(r.backend.toolResults[0]?.output).not.toContain(key);
		}
		const r = await session(
			[[call("feature", { ...start, header: key }), call("feature", done), { event: finished }]],
			{ odd: true },
		);
		await r.send("go");
		await r.session.close();
		expect(r.memory.saved).toEqual([]);
	});
	it("rejects a key split between fields", async () => {
		const r = await session([
			[call("memory", { ...SAVE, title: "sk-ant-api03-", content: "x".repeat(40) }), { event: finished }],
		]);
		await r.send("go");
		await r.session.close();
		expect(r.memory.saved).toEqual([]);
	});
	it("does not automatically persist the user's raw prompt", async () => {
		const r = await session([[call("feature", start), call("feature", done), { event: finished }]], { odd: true });
		await r.send("PRIVATE_RAW_PROMPT");
		await r.session.close();
		expect(r.memory.saved[0]?.content).not.toContain("PRIVATE_RAW_PROMPT");
	});
	it("reports failed initial context as unavailable", async () => {
		const memory = new FakeMemory("proj");
		memory.context = async () => {
			throw new MemoryError("context dead");
		};
		const r = await session([[{ event: finished }]], {}, memory);
		const events = await r.send("go");
		await r.session.close();
		expect(events[0]).toMatchObject({
			type: "memory_status",
			available: false,
			reason: expect.stringContaining("context dead"),
		});
	});
	it("honors an explicit search limit", async () => {
		const memory = new FakeMemory("proj");
		for (let i = 0; i < 12; i++) await memory.save({ title: `A${i}`, type: "decision", content: "match" });
		const r = await session(
			[[call("memory", { action: "search", query: "match", limit: 1 }), { event: finished }]],
			{},
			memory,
		);
		await r.send("go");
		await r.session.close();
		expect(r.backend.toolResults[0]?.output.split("\n")).toHaveLength(1);
	});
	it("does not mirror a closed feature merely opened in a fresh session", async () => {
		const r = await session([[call("feature", start), call("feature", done), { event: finished }]], { odd: true });
		await r.send("go");
		await r.session.close();
		const next = await session([[call("feature", { action: "open", name: "probe" }), { event: finished }]], {
			odd: true,
		});
		await next.send("resume");
		await next.session.close();
		expect(next.memory.saved).toHaveLength(0);
	});
});

describe("memory rules in the prompt", () => {
	it("are appended only with memory, after the rest, and stay under 1 KB", async () => {
		const { backend, session: s } = await session([], { systemPromptAppend: "BASE" });
		await s.close();
		expect(backend.startOptions?.systemPromptAppend).toBe(`BASE\n\n${MEMORY_RULES}`);
		expect(Buffer.byteLength(MEMORY_RULES)).toBeLessThanOrEqual(1024);
		for (const word of ["search", "save", "secret", "topicKey"]) expect(MEMORY_RULES).toContain(word);

		const plain = new FakeBackend([]);
		await (await Session.start({ backend: plain, cwd, tools, systemPromptAppend: "BASE" })).close();
		expect(plain.startOptions?.systemPromptAppend).toBe("BASE");
	});
});
