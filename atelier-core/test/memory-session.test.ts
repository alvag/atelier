import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentBackend, BackendStartOptions } from "../src/backend.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	decodeServerMessage,
	FakeBackend,
	FakeMemory,
	type FakeStep,
	MemoryError,
	MemoryUncertainError,
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

/**
 * npm and Stripe live keys, whole, split across words before another word, or followed by more of a word. Built at
 * run time, so no literal in the repository looks like a real key to secret scanners.
 */
const NPM_BODY = "abcdefghijklmnopqrstuvwxyz0123456789";
const SHAPED_KEYS = [
	`${"npm"}_${NPM_BODY}`,
	`${"npm"}_abcd\n${NPM_BODY.slice(4)} and more words`,
	`${"npm"}_${NPM_BODY}_suffix`,
	`${"npm"}_${NPM_BODY}XYZ`,
	`${"sk"}_${"live"}_${NPM_BODY}`,
	`${"rk"}_${"live"}_abcd ${NPM_BODY.slice(4)} and more words`,
];

describe("compaction summary", () => {
	const SUMMARY = "## Goal\n- refactor the parser";
	const today = () => {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	};

	/**
	 * A backend that reports `summaries` through the core's callback as it compacts, mid-turn or on /compact. Turns
	 * after the first only answer; like Claude Code's, each prompt records the core's state that would go with it.
	 */
	function summarizing(summaries: string[], compactEvery = true) {
		let options: BackendStartOptions | undefined;
		const prompts: string[] = [];
		const states: (string | undefined)[] = [];
		const compaction = async function* (reason: "threshold" | "manual"): AsyncGenerator<AtelierEventBody> {
			yield { type: "compaction_started", reason, tokens: 900 };
			options?.compacted?.(summaries.shift() ?? SUMMARY);
			yield { type: "compaction_finished", ok: true, reason, tokensBefore: 900, tokensAfter: 100, kept: 2, usage };
		};
		const backend: AgentBackend & {
			options: () => BackendStartOptions | undefined;
			prompts: string[];
			states: (string | undefined)[];
		} = {
			id: "fake",
			options: () => options,
			prompts,
			states,
			start: async (start) => {
				options = start;
				return {
					async *send(prompt) {
						prompts.push(prompt);
						states.push(options?.compactionState?.());
						if (compactEvery || prompts.length === 1) yield* compaction("threshold");
						yield finished;
					},
					async *compact() {
						yield* compaction("manual");
						yield finished;
					},
					interrupt: async () => {},
					close: async () => {},
				};
			},
		};
		return backend;
	}

	async function run(events: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
		const out: AtelierEvent[] = [];
		for await (const event of events) out.push(event);
		return out;
	}

	it("saves each compaction's summary under one key per session, so the next one updates it", async () => {
		const memory = new FakeMemory("proj");
		const s = await Session.start({ backend: summarizing([SUMMARY, "## Goal\n- later"]), cwd, tools, memory });
		const first = await run(s.send("go"));
		const second = await run(s.compact());
		await s.close();
		expect(memory.saved).toEqual([
			{
				type: "session_summary",
				title: `Session summary: proj, ${today()}`,
				content: SUMMARY,
				topicKey: expect.any(String),
			},
			expect.objectContaining({ type: "session_summary", content: "## Goal\n- later" }),
		]);
		expect(memory.saved[0]?.topicKey).toMatch(/^session\/.+\/summary$/);
		expect(memory.saved[1]?.topicKey).toBe(memory.saved[0]?.topicKey);
		expect(memory.entries).toHaveLength(1);
		for (const events of [first, second]) {
			expect(events.filter((e) => e.type === "error")).toEqual([]);
			expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
		}

		const other = await Session.start({ backend: summarizing([SUMMARY]), cwd, tools, memory });
		await run(other.compact());
		await other.close();
		expect(memory.saved[2]?.topicKey).not.toBe(memory.saved[0]?.topicKey);
	});

	it("does not save a summary that holds something that looks like a credential, and says so", async () => {
		const memory = new FakeMemory("proj");
		const backend = summarizing([`${SUMMARY}\nkey sk-ant-api03-abcdefghijklmnopqrstuvwx`]);
		const s = await Session.start({ backend, cwd, tools, memory });
		const events = await run(s.compact());
		await s.close();
		expect(memory.saved).toEqual([]);
		expect(events.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_summary_skipped",
				message: "The compaction summary was not saved to memory: it contains what looks like an Anthropic API key.",
				recoverable: true,
			}),
		]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	});

	it.each(SHAPED_KEYS)("does not save a summary with an npm or Stripe live key: %s", async (key) => {
		const memory = new FakeMemory("proj");
		const s = await Session.start({ backend: summarizing([`${SUMMARY}\n${key}`]), cwd, tools, memory });
		const events = await run(s.compact());
		await s.close();
		expect(memory.saved).toEqual([]);
		expect(events.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({ code: "memory_summary_skipped", recoverable: true }),
		]);
	});

	it("warns once when memory fails or saves with a warning, without retrying, and the turn goes on", async () => {
		const failing = new FakeMemory("proj");
		let attempts = 0;
		failing.save = async () => {
			attempts++;
			throw new MemoryError("Engram mem_save failed: closed");
		};
		const s = await Session.start({ backend: summarizing([]), cwd, tools, memory: failing });
		const events = await run(s.send("go"));
		await s.close();
		expect(attempts).toBe(1);
		expect(events.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_summary_failed",
				message: "The compaction summary was not saved to memory: Engram mem_save failed: closed",
				recoverable: true,
			}),
		]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });

		const warned = new FakeMemory("proj");
		const save = warned.save.bind(warned);
		warned.save = async (entry) => ({ ...(await save(entry)), warning: "conflict detection did not finish" });
		const w = await Session.start({ backend: summarizing([]), cwd, tools, memory: warned });
		const warnedEvents = await run(w.compact());
		await w.close();
		expect(warned.saved).toHaveLength(1);
		expect(warnedEvents.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_summary_warning",
				message: "The compaction summary was saved to memory with a warning: conflict detection did not finish",
				recoverable: true,
			}),
		]);
	});

	describe("recovery", () => {
		const SAVED = "The compaction summary is already in memory; do not save it again.";

		async function afterCompaction(memory: FakeMemory, summary = SUMMARY) {
			const backend = summarizing([summary], false);
			const s = await Session.start({ backend, cwd, tools, memory });
			const compacted = await run(s.send("go"));
			const next = await run(s.send("next"));
			const later = await run(s.send("later"));
			await s.close();
			return { backend, compacted, next, later };
		}

		it("gives the next prompt the recent memory and says the summary is saved, once", async () => {
			const memory = new FakeMemory("proj");
			const { backend, compacted } = await afterCompaction(memory);
			expect(compacted.filter((e) => e.type === "error")).toEqual([]);
			expect(backend.prompts[1]).toBe(
				[
					"<memory-recovery>",
					"The conversation was compacted. Recent memory of project proj:",
					`- [session_summary] Session summary: proj, ${today()}`,
					SAVED,
					"</memory-recovery>",
					"",
					"next",
				].join("\n"),
			);
			expect(backend.prompts[2]).toBe("later");
		});

		it("keeps the memory out of the state that goes with the same prompt", async () => {
			const memory = new FakeMemory("proj");
			await memory.save({ title: "Old decision", type: "decision", content: "x" });
			const { backend } = await afterCompaction(memory);
			expect(backend.states[0]).toContain("memory:\n- [decision] Old decision");
			expect(backend.states[1]).toBeUndefined();
			expect(backend.prompts[1]).toContain("- [decision] Old decision\n- [session_summary]");
			// Once said, the state carries the fresh memory again.
			expect(backend.states[2]).toContain("- [session_summary]");
		});

		it("tells the agent what to do when the save failed, may have happened or was skipped", async () => {
			const failed = new FakeMemory("proj");
			failed.save = async () => {
				throw new MemoryError("Engram mem_save: refused");
			};
			const f = await afterCompaction(failed);
			const key = /session\/[^ ]+\/summary/.exec(f.backend.prompts[1] ?? "")?.[0];
			expect(key).toMatch(/^session\/.+\/summary$/);
			expect(f.backend.prompts[1]).toBe(
				`<memory-recovery>\nThe conversation was compacted.\nThe compaction summary was not saved to memory. Save its key points once with the memory tool, under topicKey ${key}.\n</memory-recovery>\n\nnext`,
			);

			const uncertain = new FakeMemory("proj");
			uncertain.save = async () => {
				throw new MemoryUncertainError("Engram mem_save failed: timed out");
			};
			const u = await afterCompaction(uncertain);
			expect(u.backend.prompts[1]).toContain(
				"It is unclear whether the compaction summary was saved to memory. Do not save it again blindly: search memory for it first and save it once only if it is absent.",
			);
			expect(u.compacted.filter((e) => e.type === "error")).toEqual([
				expect.objectContaining({ code: "memory_summary_failed", recoverable: true }),
			]);

			const skipped = new FakeMemory("proj");
			const s = await afterCompaction(skipped, `${SUMMARY}\nkey sk-ant-api03-abcdefghijklmnopqrstuvwx`);
			expect(s.backend.prompts[1]).toContain(
				"The compaction summary was not saved to memory because it contains what looks like a credential; do not save it.",
			);
		});

		it("sends the memory from start when a compaction before the first prompt could not fetch it again", async () => {
			let options: BackendStartOptions | undefined;
			const prompts: string[] = [];
			const states: (string | undefined)[] = [];
			const backend: AgentBackend = {
				id: "fake",
				start: async (start) => {
					options = start;
					return {
						async *send(prompt) {
							prompts.push(prompt);
							states.push(options?.compactionState?.());
							yield finished;
						},
						async *compact() {
							options?.compacted?.(SUMMARY);
							yield finished;
						},
						interrupt: async () => {},
						close: async () => {},
					};
				},
			};
			const memory = new FakeMemory("proj");
			await memory.save({ title: "Old decision", type: "decision", content: "x" });
			const s = await Session.start({ backend, cwd, tools, memory });
			memory.context = async () => {
				throw new MemoryError("Engram mem_context failed: closed");
			};
			await run(s.compact());
			await run(s.send("first"));
			await s.close();
			expect(prompts[0]).toBe(
				`<memory-recovery>\nThe conversation was compacted.\n${SAVED}\n</memory-recovery>\n\n<memory>\n- [decision] Old decision\n</memory>\n\nfirst`,
			);
			expect(states[0]).toContain("memory:\n- [decision] Old decision");
		});

		it("keeps the notice for the next prompt when the backend answers only with an error", async () => {
			let options: BackendStartOptions | undefined;
			const prompts: string[] = [];
			const backend: AgentBackend = {
				id: "fake",
				start: async (start) => {
					options = start;
					return {
						async *send(prompt) {
							prompts.push(prompt);
							if (prompts.length === 1) {
								yield { type: "error", code: "backend_ended", message: "gone", recoverable: false };
								yield { type: "turn_finished", stopReason: "error", usage };
							} else yield finished;
						},
						async *compact() {
							options?.compacted?.(SUMMARY);
							yield finished;
						},
						interrupt: async () => {},
						close: async () => {},
					};
				},
			};
			const s = await Session.start({ backend, cwd, tools, memory: new FakeMemory("proj") });
			await run(s.compact());
			await run(s.send("refused"));
			await run(s.send("taken"));
			await run(s.send("later"));
			await s.close();
			expect(prompts[0]).toContain("<memory-recovery>");
			expect(prompts[1]).toMatch(/^<memory-recovery>[\s\S]*\n\ntaken$/);
			expect(prompts[2]).toBe("later");
		});

		it("still says what to do when the recent memory does not come, and warns", async () => {
			const memory = new FakeMemory("proj");
			const backend = summarizing([SUMMARY], false);
			const s = await Session.start({ backend, cwd, tools, memory });
			memory.context = async () => {
				throw new MemoryError("Engram mem_context failed: closed");
			};
			const compacted = await run(s.send("go"));
			const next = await run(s.send("next"));
			await s.close();
			expect(compacted.filter((e) => e.type === "error")).toEqual([
				expect.objectContaining({
					code: "memory_recovery_failed",
					message: "Recent memory could not be fetched after the compaction: Engram mem_context failed: closed",
					recoverable: true,
				}),
			]);
			expect(compacted.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
			expect(next.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
			expect(backend.prompts[1]).toBe(
				`<memory-recovery>\nThe conversation was compacted.\n${SAVED}\n</memory-recovery>\n\nnext`,
			);
		});
	});

	it("is not asked for without memory, nor by subagents", async () => {
		const none = summarizing([]);
		const s = await Session.start({ backend: none, cwd, tools });
		const events = await run(s.compact());
		await s.close();
		expect(none.options()?.compacted).toBeUndefined();
		expect(events.filter((e) => e.type === "error")).toEqual([]);

		const child = new FakeBackend([[{ event: { type: "text_delta", text: "r" } }, { event: finished }]]);
		const {
			backend,
			session: parent,
			send,
		} = await session([[call("task", { agent: "w", prompt: "x" }), { event: finished }]], {
			subagents: {
				agents: [{ name: "w", description: "w", tools: ["read"], prompt: "p", models: {}, maxRequests: 5 }],
				createBackend: () => child,
			},
		});
		await send("go");
		await parent.close();
		expect(backend.startOptions?.compacted).toBeTypeOf("function");
		expect(child.startOptions?.compacted).toBeUndefined();
	});
});

describe("memory session", () => {
	it("registers the session in its folder at start and ends it once on close", async () => {
		const memory = new FakeMemory("proj");
		const backend = new FakeBackend([]);
		const s = await Session.start({ backend, cwd, tools, memory });
		expect(memory.began).toEqual([{ id: expect.stringMatching(/^atelier-/), directory: cwd }]);
		expect(memory.ended).toBe(0);
		await s.close();
		await s.close();
		expect(memory.ended).toBe(1);
		expect(memory.closed).toBe(true);
	});

	it("goes on without a registered session when memory refuses it, and says so in the first turn", async () => {
		const memory = new FakeMemory("proj");
		memory.begin = async () => {
			throw new MemoryError("Engram mem_session_start failed: closed");
		};
		memory.end = async () => {
			throw new MemoryError("Engram mem_session_end failed: closed");
		};
		const { session: s, send } = await session([[{ event: finished }], [{ event: finished }]], {}, memory);
		const first = await send("one");
		const second = await send("two");
		await s.close();
		expect(first.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_session_failed",
				message:
					"Memory did not register this session; it is saved without one: Engram mem_session_start failed: closed",
				recoverable: true,
			}),
		]);
		expect(first).toContainEqual(expect.objectContaining({ type: "memory_status", available: true }));
		expect(second.filter((e) => e.type === "error")).toEqual([]);
		expect(memory.prompts).toEqual(["one", "two"]);
		expect(memory.closed).toBe(true);
	});
});

describe("user prompts", () => {
	it("saves each prompt and each steer that enters, with credentials masked and cut to 2000 characters", async () => {
		let steer = () => {};
		const steering = defineTool({
			name: "read",
			description: "read",
			inputShape: {},
			execute: async () => {
				steer();
				return { ok: true, output: "ran", summary: "read", truncated: false };
			},
		});
		const {
			memory,
			session: s,
			send,
		} = await session([[call("read", {}), { event: finished }], [{ event: finished }], [{ event: finished }]], {
			tools: [steering],
		});
		steer = () => void s.queue("steer", "use the other file");
		await send("fix it with sk-ant-api03-abcdefghijklmnopqrstuvwx please");
		steer = () => {};
		await send("x".repeat(2500));
		const events: AtelierEvent[] = [];
		for await (const event of s.compact("keep the parser")) events.push(event);
		await s.close();
		expect(memory.prompts).toEqual(["fix it with [REDACTED] please", "use the other file", "x".repeat(2000)]);
	});

	it("masks a pasted private key whole, its body and END line included, and to the end when it has no END", async () => {
		const { memory, session: s, send } = await session([[{ event: finished }], [{ event: finished }]]);
		const body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";
		await send(`here is my key:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nwhy fails?`);
		await send(`cut short:\n-----BEGIN PRIVATE KEY-----\n${body}\n${body}`);
		await s.close();
		expect(memory.prompts).toEqual(["here is my key:\n[REDACTED]\nwhy fails?", "cut short:\n[REDACTED]"]);
	});

	it("masks only the value of credentials told by where they stand, and leaves prose alone", async () => {
		const prompts = [
			"curl -H 'Authorization: Basic dXNlcjpodW50ZXIy' https://api.test",
			"curl -H 'authorization: bearer abcdefgh12345678' x",
			"config: { api_key: \"sk live 1234\", client_secret: 's3cr3t value' }",
			"GITHUB_TOKEN: ghx-short\nexport PGPASSWD=hunter2",
			"clone https://ana:hunter2@git.example.com/repo.git",
			"the token expires; rotate the password weekly; Basic idea",
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"curl -H 'Authorization: [REDACTED]' https://api.test",
			"curl -H 'authorization: [REDACTED]' x",
			"config: { api_key: [REDACTED], client_secret: [REDACTED] }",
			"GITHUB_TOKEN: [REDACTED]\nexport PGPASSWD=[REDACTED]",
			"clone https://ana:[REDACTED]@git.example.com/repo.git",
			"the token expires; rotate the password weekly; Basic idea",
		]);
	});

	it("masks a long unspaced blob in linear time, and still masks the secret at its end", async () => {
		const runs = [
			"a-",
			"a.",
			"a_",
			"a+",
			"x://",
			"curl -u a:b ",
			"curl -ua:'",
			'wget --password "',
			'k_secret="\\',
			"k_secret='",
		];
		const blobs = runs.map((run) => `${run.repeat(30_000)} DB_PASSWORD=hunter2`);
		const { memory, session: s, send } = await session(blobs.map(() => [{ event: finished }]));
		// The process's CPU time, not the wall clock: a loaded machine stretches the latter, not the work done.
		const started = process.cpuUsage();
		for (const blob of blobs) await send(blob);
		const { user, system } = process.cpuUsage(started);
		await s.close();
		expect((user + system) / 1000).toBeLessThan(1000);
		expect(memory.prompts).toHaveLength(runs.length);
		for (const kept of memory.prompts) expect(kept).not.toContain("hunter2");
	});

	it("masks a quoted value assigned to a secret's name across lines, past escaped quotes, or to the line's end when unclosed", async () => {
		const prompts = [
			'SECRET_KEY: "multi\nline"\nnext: 1',
			"db_password = 'a\nb' rest",
			'API_TOKEN="pa\\"ss" x',
			'TOKEN: "abc def\nnext',
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"SECRET_KEY: [REDACTED]\nnext: 1",
			"db_password = [REDACTED] rest",
			"API_TOKEN=[REDACTED] x",
			"TOKEN: [REDACTED]\nnext",
		]);
	});

	it("masks a URL password up to the authority's last '@', with '@' or '/' inside it", async () => {
		const prompts = [
			"git clone https://ana:p@ss@host.example/x.git",
			"psql postgres://ana:a/b@db.local:5432/app now",
			"see https://ana:pw@host.example/@scope/pkg",
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"git clone https://ana:[REDACTED]@host.example/x.git",
			"psql postgres://ana:[REDACTED]@db.local:5432/app now",
			"see https://ana:[REDACTED]@host.example/@scope/pkg",
		]);
	});

	it("masks an Authorization or Proxy-Authorization value whole, whatever its scheme", async () => {
		const prompts = [
			"Authorization: Negotiate YIIabcdefghijk lmnop",
			"Authorization: AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc123\nnext line",
			"Proxy-Authorization: NTLM TlRMTVNTUAAB",
			'{"Authorization": "Negotiate YIIabc def", "x": 1}',
			'{"Authorization": null, "x": 1}',
			'{"authorization":-1.5e3} {"Proxy-Authorization": true ,"y": ["z"]}',
			"{Authorization: false}",
			'{"Authorization": nullish token, "x": 1}',
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"Authorization: [REDACTED]",
			"Authorization: [REDACTED]\nnext line",
			"Proxy-Authorization: [REDACTED]",
			'{"Authorization": "[REDACTED]", "x": 1}',
			'{"Authorization": [REDACTED], "x": 1}',
			'{"authorization":[REDACTED]} {"Proxy-Authorization": [REDACTED] ,"y": ["z"]}',
			"{Authorization: [REDACTED]}",
			'{"Authorization": [REDACTED]',
		]);
	});

	it("masks npm and Stripe live keys and the password of curl -u", async () => {
		// Built at run time, so no literal in the repository looks like a real key to secret scanners.
		const live = (kind: string) => `${kind}_${"live"}_51Habcdefghijklmnopqrstuv`;
		const prompts = [
			`npm config set //registry/:_authToken ${"npm"}_abcdefghijklmnopqrstuvwxyz0123456789 now`,
			`tokens ${"npm"}_abcdefghijklmnopqrstuvwxyz0123456789XYZ_suffix end`,
			`stripe ${live("sk")} and ${live("rk")}`,
			"curl -u ana:hunter2 https://api.test",
			"curl --user=ana:hunter2 x; curl --user 'ana:p w' y",
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"npm config set //registry/:_authToken [REDACTED] now",
			"tokens [REDACTED]_suffix end",
			"stripe [REDACTED] and [REDACTED]",
			"curl -u ana:[REDACTED] https://api.test",
			"curl --user=ana:[REDACTED] x; curl --user 'ana:[REDACTED]' y",
		]);
	});

	it("masks the password of curl -u and -U and of wget's --password in every quoting, and no other command's -u", async () => {
		const prompts = [
			"curl -u admin:'S3cr3t!' https://api.test",
			'curl -u ana:"p w" x',
			'curl -u "ana:pa\\"ss" x',
			"curl -s -uana:pw x && curl -k --user 'ana:p w' y",
			"curl -X POST \\\n  -U proxy:pw --proxy-user=p:q https://api.test",
			"/usr/bin/curl -u ana: x; curl -u ana x",
			"wget --user=ana --password 'p w' x; wget --http-password=pw y",
			"docker run -u 1000:1000 img; docker run --user node:node img | curl -s x",
			"sudo -u ana:pw ls; then curl the API with -u ana:pw",
			"curl -u ana:pa&ss https://x; curl -u ana:pa;ss y; curl -u ana:pa|ss z",
			"curl -u ana:pa(ss) x && curl --user=ana:pw&x",
			"curl -u ana:pass\\\nword x; wget --password pa&ss y; curl -u a:b; curl -u c:d",
			"I tried curl but it doesn't authenticate.\ncurl -u admin:S3cret https://api",
			"curl doesn't work, I use curl -u ana:hunter2 https://x, it's odd",
			'sh -c "curl -u a:b x"; curl -u c:d y "z"; curl -H \'X: a;b\' -u e:f',
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"curl -u admin:[REDACTED] https://api.test",
			"curl -u ana:[REDACTED] x",
			'curl -u "ana:[REDACTED]" x',
			"curl -s -uana:[REDACTED] x && curl -k --user 'ana:[REDACTED]' y",
			"curl -X POST \\\n  -U proxy:[REDACTED] --proxy-user=p:[REDACTED] https://api.test",
			"/usr/bin/curl -u ana: x; curl -u ana x",
			"wget --user=ana --password [REDACTED] x; wget --http-password=[REDACTED] y",
			"docker run -u 1000:1000 img; docker run --user node:node img | curl -s x",
			"sudo -u ana:pw ls; then curl the API with -u ana:[REDACTED]",
			"curl -u ana:[REDACTED] https://x; curl -u ana:[REDACTED] y; curl -u ana:[REDACTED] z",
			"curl -u ana:[REDACTED] x && curl --user=ana:[REDACTED]",
			"curl -u ana:[REDACTED] x; wget --password [REDACTED] y; curl -u a:[REDACTED] curl -u c:[REDACTED]",
			"I tried curl but it doesn't authenticate.\ncurl -u admin:[REDACTED] https://api",
			"curl doesn't work, I use curl -u ana:[REDACTED] https://x, it's odd",
			'sh -c "curl -u a:[REDACTED] x"; curl -u c:[REDACTED] y "z"; curl -H \'X: a;b\' -u e:[REDACTED]',
		]);
	});

	it("masks an unquoted Authorization value to the end of the line, quotes inside it included", async () => {
		const prompts = [
			'Authorization: Digest username="x", realm="r", response="abcdef123456"\nnext',
			"Authorization: Foo it's secretvalue123",
			'curl -H \'Authorization: Digest username="x", response="abc"\' https://api.test',
			'curl -H "Authorization: Digest username=\\"x\\", response=\\"abc\\"" https://api.test',
			"curl -H 'Proxy-Authorization: NTLM TlRMTVNT' https://api.test",
			"X-Authorization: abc123secret",
			"curl -H 'X-Forwarded-Authorization: Basic dXNlcjpwYXNz' https://api.test",
			'headers:\n  "Authorization": Basic dXNlcjpwYXNz\n  x: 1',
			"{'Authorization': Basic dXNlcjpwYXNz}",
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([
			"Authorization: [REDACTED]\nnext",
			"Authorization: [REDACTED]",
			"curl -H 'Authorization: [REDACTED]' https://api.test",
			'curl -H "Authorization: [REDACTED]" https://api.test',
			"curl -H 'Proxy-Authorization: [REDACTED]' https://api.test",
			"X-Authorization: [REDACTED]",
			"curl -H 'X-Forwarded-Authorization: [REDACTED]' https://api.test",
			'headers:\n  "Authorization": [REDACTED]\n  x: 1',
			"{'Authorization': [REDACTED]",
		]);
	});

	it("keeps a prompt out when a known key is split across words, also after a name or header the masks know", async () => {
		const prompts = [
			"GITHUB_TOKEN=ghp_abcd\nefghijklmnopqrstuvwxyz0123456789",
			"Authorization: Bearer sk-ant-api03-abcd\nefghijklmnopqrstuvwx",
		];
		const { memory, session: s, send } = await session(prompts.map(() => [{ event: finished }]));
		for (const prompt of prompts) await send(prompt);
		await s.close();
		expect(memory.prompts).toEqual([]);
	});

	it("masks the whole prompt before cutting it, and never cuts inside a mask", async () => {
		const { memory, session: s, send } = await session([[{ event: finished }]]);
		await send(`${"x".repeat(1995)} sk-ant-api03-abcdefghijklmnopqrstuvwx and more`);
		await s.close();
		expect(memory.prompts).toEqual([`${"x".repeat(1995)} `]);
	});

	it("says in the first turn what memory warned about at start", async () => {
		const memory = new FakeMemory("proj");
		memory.warnings.push('settings.json: "memory.prompts" must be true or false; your prompts are not saved to memory');
		const { session: s, send } = await session([[{ event: finished }], [{ event: finished }]], {}, memory);
		const first = await send("one");
		const second = await send("two");
		await s.close();
		expect(first.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_settings_invalid",
				message: 'settings.json: "memory.prompts" must be true or false; your prompts are not saved to memory',
				recoverable: true,
			}),
		]);
		expect(second.filter((e) => e.type === "error")).toEqual([]);
	});

	it("warns once when saving prompts fails, and the turns go on", async () => {
		const memory = new FakeMemory("proj");
		let attempts = 0;
		memory.savePrompt = async () => {
			attempts++;
			throw new MemoryError("Engram mem_save_prompt failed: closed");
		};
		const { session: s, send } = await session([[{ event: finished }], [{ event: finished }]], {}, memory);
		const first = await send("one");
		const second = await send("two");
		await s.close();
		expect(attempts).toBe(2);
		expect(first.filter((e) => e.type === "error")).toEqual([
			expect.objectContaining({
				code: "memory_prompt_failed",
				message: "Your prompts are not being saved to memory: Engram mem_save_prompt failed: closed",
				recoverable: true,
			}),
		]);
		expect(second.filter((e) => e.type === "error")).toEqual([]);
		for (const events of [first, second])
			expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	});

	it("does not save a subagent's prompt", async () => {
		const child = new FakeBackend([[{ event: { type: "text_delta", text: "r" } }, { event: finished }]]);
		const {
			memory,
			session: s,
			send,
		} = await session([[call("task", { agent: "w", prompt: "child task" }), { event: finished }]], {
			subagents: {
				agents: [{ name: "w", description: "w", tools: ["read"], prompt: "p", models: {}, maxRequests: 5 }],
				createBackend: () => child,
			},
		});
		await send("delegate");
		await s.close();
		expect(memory.prompts).toEqual(["delegate"]);
	});
});

describe("RpcServer memory", () => {
	async function serve(connectMemory: (cwd: string) => Promise<FakeMemory>) {
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		const backends: FakeBackend[] = [];
		const running = new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => {
				const backend = new FakeBackend([[{ event: finished }]]);
				backends.push(backend);
				return backend;
			},
			tools,
			systemPromptAppend: "",
			home: cwd,
			connectMemory,
		}).run();
		const waitFor = async (predicate: (m: ServerMessage) => boolean) => {
			for (let i = 0; i < 800; i++) {
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
		// The server records the session under cwd until it closes it: the test's cleanup must not race with it.
		input.end();
		await running;
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
		...SHAPED_KEYS,
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

describe("memory tool text", () => {
	it("tells the agent to save selectively, one memory per topic", async () => {
		const { backend, session: s } = await session([]);
		await s.close();
		const tool = backend.startOptions?.tools.find((t) => t.name === "memory");
		expect(tool?.description).toBe(
			[
				"Long-term memory of project proj, shared across sessions.",
				"search (query): find earlier decisions, fixes and discoveries. get (id): read one in full.",
				"save (title, type, content, topicKey?): keep verified knowledge worth knowing next time, one memory per topic, as **What** / **Why** / **Where** / **Learned**. The same topicKey replaces that memory, so keep its still-valid facts. Never save secrets.",
			].join("\n"),
		);
		expect((tool?.inputShape.topicKey as z.ZodType | undefined)?.description).toBe(
			"save: stable key for one topic, like project/topic; reuse it to update that topic",
		);
	});
});

describe("memory rules in the prompt", () => {
	it("are appended only with memory, after the rest, and stay under 1 KB", async () => {
		const { backend, session: s } = await session([], { systemPromptAppend: "BASE" });
		await s.close();
		expect(backend.startOptions?.systemPromptAppend).toBe(`BASE\n\n${MEMORY_RULES}`);
		expect(MEMORY_RULES).toBe(
			[
				"You have long-term memory of this project (the memory tool), shared across sessions.",
				"- Before work that may build on earlier sessions, search memory; recent memory also comes with the first message.",
				"- Save only verified knowledge worth keeping: a decision the user confirmed, a bug fixed with its cause, a non-obvious discovery, a user preference. One memory per topic, not per event; no routine progress or guesses. Use **What** / **Why** / **Where** / **Learned**.",
				"- Before saving, search the topic; if a memory covers it, get it and save under its topicKey with its still-valid facts, or save nothing. If search fails, save nothing.",
				"- Never save secrets. Finished feature documents are saved for you.",
			].join("\n"),
		);
		// At most about 200 bytes over the 507 it had before Engram's selective guidance.
		expect(Buffer.byteLength(MEMORY_RULES)).toBeLessThanOrEqual(707);

		const plain = new FakeBackend([]);
		await (await Session.start({ backend: plain, cwd, tools, systemPromptAppend: "BASE" })).close();
		expect(plain.startOptions?.systemPromptAppend).toBe("BASE");
	});
});

describe("independent recovery/privacy regressions", () => {
	it.each([
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
		"DB_PASSWORD=correct-horse-battery-staple",
		"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	])("does not persist credentials in a human prompt: %s (S2)", async (secret) => {
		const r = await session([[{ event: finished }]]);
		try {
			await r.send(secret);
			expect(r.memory.prompts.join("\n")).not.toContain(secret.split(/[ =]/).at(-1));
		} finally {
			await r.session.close();
		}
	});

	it("checks split credentials before truncation (S2)", async () => {
		const r = await session([[{ event: finished }]]);
		try {
			await r.send(`${" ".repeat(1977)}sk-ant-api03-abcd efghijklmnopqrstuvwx`);
			expect(r.memory.prompts).toEqual([]);
		} finally {
			await r.session.close();
		}
	});

	it.each([false, true])("retains undelivered recovery and avoids duplicate context: %s (S1)", async (fail) => {
		let options: BackendStartOptions;
		let reject = false;
		const prompts: string[] = [];
		const backend: AgentBackend = {
			id: "fake",
			start: async (start) => {
				options = start;
				return {
					async *send(prompt) {
						if (reject) {
							reject = false;
							throw new Error("offline before accepting prompt");
						}
						prompts.push(prompt);
						yield finished;
					},
					async *compact() {
						options.compacted?.("## Goal\n- parse");
						yield finished;
					},
					interrupt: async () => {},
					close: async () => {},
				};
			},
		};
		const memory = new FakeMemory("proj");
		const s = await Session.start({ backend, cwd, tools, memory });
		const drain = async (events: AsyncIterable<AtelierEvent>) => {
			for await (const _ of events) void _;
		};
		try {
			if (fail) await drain(s.send("initial"));
			await drain(s.compact());
			if (fail) {
				reject = true;
				await drain(s.send("failed attempt"));
			}
			await drain(s.send("continue"));
			const accepted = prompts.at(-1) ?? "";
			expect(accepted).toContain("<memory-recovery>");
			expect(accepted).not.toContain("<memory>");
			await drain(s.send("later"));
			expect(prompts.at(-1)).toBe("later");
		} finally {
			await s.close();
		}
	});
});

it.each(["Authorization", "Proxy-Authorization", "X-Forwarded-Authorization"])(
	"masks a quoted-name %s header whose unquoted value contains quotes",
	async (name) => {
		const r = await session([[{ event: finished }]]);
		try {
			await r.send(`headers:\n  "${name}": Digest username="u", response="PRIVATEPAYLOAD"`);
			expect(r.memory.prompts).toEqual([`headers:\n  "${name}": [REDACTED]`]);
		} finally {
			await r.session.close();
		}
	},
);
