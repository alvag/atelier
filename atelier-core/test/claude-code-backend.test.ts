import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	ClaudeCodeBackend,
	createToolBridge,
	type QueryFunction,
	type SdkQuery,
} from "../src/backends/claude-code/backend.ts";
import { Channel } from "../src/channel.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	defineTool,
	FakeBackend,
	FakeMemory,
	Session,
	type ToolCall,
} from "../src/index.ts";

function msg(value: Record<string, unknown>): SDKMessage {
	return { uuid: "u", session_id: "s", ...value } as unknown as SDKMessage;
}

const SUBSCRIPTION = { subscriptionType: "max", apiProvider: "firstParty", tokenSource: "claude.ai" };

const init = msg({
	type: "system",
	subtype: "init",
	apiKeySource: "none",
	model: "claude-opus-5-5",
	mcp_servers: [{ name: "atelier", status: "connected" }],
});
const text = (t: string) =>
	msg({
		type: "stream_event",
		parent_tool_use_id: null,
		event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
	});
const result = (totalCost: number) =>
	msg({
		type: "result",
		subtype: "success",
		is_error: false,
		stop_reason: "end_turn",
		total_cost_usd: totalCost,
		result: "",
		usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 },
	});

/** In a scripted reply: Claude Code runs its Stop hooks, with the effort it applied to the turn. */
interface StopHook {
	stopEffort: string | undefined;
}
const stop = (level?: string): StopHook => ({ stopEffort: level });

/** Fake SDK query: emits `boot` at start, then plays one scripted reply per user message. */
function fakeQuery(
	boot: SDKMessage[],
	replies: (SDKMessage | Error | StopHook)[][],
	account: Record<string, unknown> = SUBSCRIPTION,
) {
	const calls: { options: Options; prompts: string[]; interrupts: number; closed: boolean; hookOutputs: unknown[] } = {
		options: {},
		prompts: [],
		interrupts: 0,
		closed: false,
		hookOutputs: [],
	};
	const query: QueryFunction = ({ prompt, options }) => {
		calls.options = options;
		async function* run(): AsyncGenerator<SDKMessage, void> {
			yield* boot;
			for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
				calls.prompts.push(message.message.content as string);
				for (const item of replies.shift() ?? []) {
					if (item instanceof Error) throw item;
					if ("stopEffort" in item) {
						const input = {
							hook_event_name: "Stop",
							session_id: "s",
							stop_hook_active: false,
							...(item.stopEffort === undefined ? {} : { effort: { level: item.stopEffort } }),
						};
						for (const matcher of options.hooks?.Stop ?? [])
							for (const hook of matcher.hooks)
								calls.hookOutputs.push(await hook(input as never, undefined, { signal: new AbortController().signal }));
						continue;
					}
					yield item;
				}
			}
		}
		const generator = run();
		return Object.assign(generator, {
			async interrupt() {
				calls.interrupts++;
			},
			async accountInfo() {
				return account;
			},
			close() {
				calls.closed = true;
			},
		}) as SdkQuery;
	};
	return { query, calls };
}

/** SDK query whose output the test pushes by hand. */
function controlledQuery() {
	const output = new Channel<SDKMessage>();
	const close = vi.fn(() => output.close());
	const query: QueryFunction = () => ({
		[Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
		interrupt: async () => {},
		close,
	});
	return { output, close, query };
}

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: Record<string, unknown>[] = [];
	for await (const { seq: _seq, turnId: _turnId, ...body } of events) out.push(body);
	return out;
}

async function collectBodies(events: AsyncIterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const out: AtelierEventBody[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const echo = defineTool({
	name: "echo",
	description: "Echo",
	inputShape: { text: z.string() },
	execute: async ({ text }) => ({ ok: true, output: text, summary: text, truncated: false }),
});

const plainStart = {
	cwd: "/w",
	systemPromptAppend: "",
	tools: [],
	executeTool: async () => ({ ok: true, output: "" }),
};

describe("ClaudeCodeBackend options", () => {
	it("runs only Atelier tools, isolated from the user's Claude Code configuration", async () => {
		const { query, calls } = fakeQuery([], []);
		const backend = new ClaudeCodeBackend({ query, env: { PATH: "/bin", HOME: "/home/me" } });
		const session = await backend.start({
			cwd: "/work",
			systemPromptAppend: "Be brief.",
			tools: [echo],
			executeTool: async () => ({ ok: true, output: "" }),
		});

		const o = calls.options;
		expect(o.cwd).toBe("/work");
		expect(o.model).toBe("opus");
		expect(o.tools).toEqual([]);
		expect(o.settingSources).toEqual([]);
		expect(o.skills).toEqual([]);
		expect(o.strictMcpConfig).toBe(true);
		expect(o.settings).toEqual({ includeGitInstructions: false, autoMemoryEnabled: false });
		expect(o.permissionMode).toBe("bypassPermissions");
		expect(o.allowDangerouslySkipPermissions).toBe(true);
		expect(o.includePartialMessages).toBe(true);
		expect(o.persistSession).toBe(false);
		expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Be brief." });
		expect(Object.keys(o.mcpServers ?? {})).toEqual(["atelier"]);
		expect(o.mcpServers?.atelier).toMatchObject({ type: "sdk", name: "atelier" });
		expect(o.env).toMatchObject({ PATH: "/bin", HOME: "/home/me", ENABLE_CLAUDEAI_MCP_SERVERS: "0" });
		await session.close();
	});

	it("uses the requested model", async () => {
		const { query, calls } = fakeQuery([], []);
		const backend = new ClaudeCodeBackend({ query, env: {} });
		await backend.start({
			cwd: "/w",
			model: "sonnet",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		expect(calls.options.model).toBe("sonnet");
		expect(calls.options).not.toHaveProperty("maxTurns");
	});

	it("passes the requested effort to Claude Code, and none when not asked", async () => {
		const start = { cwd: "/w", systemPromptAppend: "", tools: [], executeTool: async () => ({ ok: true, output: "" }) };
		const asked = fakeQuery([init], [[result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query: asked.query, env: {} }).start({ ...start, thinking: "xhigh" });
		expect(asked.calls.options.effort).toBe("xhigh");
		const [started] = await collectBodies(session.send("hi"));
		expect(started).toMatchObject({ type: "session_started", model: "claude-opus-5-5", effort: "xhigh" });

		const plain = fakeQuery([], []);
		await new ClaudeCodeBackend({ query: plain.query, env: {} }).start(start);
		expect(plain.calls.options).not.toHaveProperty("effort");
	});

	it("does not pass an effort the model does not support, and marks it unsupported", async () => {
		const { query, calls } = fakeQuery([{ ...init, model: "claude-sonnet-4-6" } as SDKMessage], [[result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			model: "claude-sonnet-4-6",
			thinking: "xhigh",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		expect(calls.options).not.toHaveProperty("effort");
		const [started] = await collectBodies(session.send("hi"));
		expect(started).toMatchObject({ type: "session_started", model: "claude-sonnet-4-6", effort: "unsupported" });
	});

	it("passes minimal as effort low", async () => {
		const { query, calls } = fakeQuery([init], [[result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start({ ...plainStart, thinking: "minimal" });
		expect(calls.options.effort).toBe("low");
		const [started] = await collectBodies(session.send("hi"));
		expect(started).toMatchObject({ type: "session_started", effort: "low" });
	});

	it.each(["claude-haiku-5-5", "claude-opus-5"])(
		"turns thinking off on %s with disabled and says off",
		async (model) => {
			const { query, calls } = fakeQuery([{ ...init, model } as SDKMessage], [[result(0.01)]]);
			const session = await new ClaudeCodeBackend({ query, env: {} }).start({ ...plainStart, model, thinking: "off" });
			expect(calls.options.thinking).toEqual({ type: "disabled" });
			expect(calls.options).not.toHaveProperty("effort");
			const [started] = await collectBodies(session.send("hi"));
			expect(started).toMatchObject({ type: "session_started", model, effort: "off" });
		},
	);

	it.each(["claude-sonnet-5-5", "claude-opus-5-5"])(
		"does not turn thinking off on %s, which the Agent SDK cannot do there, and marks it unsupported",
		async (model) => {
			const { query, calls } = fakeQuery([{ ...init, model } as SDKMessage], [[result(0.01)]]);
			const session = await new ClaudeCodeBackend({ query, env: {} }).start({ ...plainStart, model, thinking: "off" });
			expect(calls.options).not.toHaveProperty("thinking");
			expect(calls.options).not.toHaveProperty("effort");
			const [started] = await collectBodies(session.send("hi"));
			expect(started).toMatchObject({ type: "session_started", model, effort: "unsupported" });
		},
	);

	it("passes no thinking and says no effort when no level was asked", async () => {
		const { query, calls } = fakeQuery([init], [[result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start(plainStart);
		expect(calls.options).not.toHaveProperty("thinking");
		const [started] = await collectBodies(session.send("hi"));
		expect(started).not.toHaveProperty("effort");
	});

	it("caps a turn's model requests with maxTurns when asked", async () => {
		const { query, calls } = fakeQuery([], []);
		await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
			maxRequestsPerTurn: 30,
		});
		expect(calls.options.maxTurns).toBe(30);
	});

	it("drops ANTHROPIC_API_KEY so the subscription is used, unless asked to keep it", async () => {
		const env = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-secret" };
		const start = { cwd: "/w", systemPromptAppend: "", tools: [], executeTool: async () => ({ ok: true, output: "" }) };

		const dropped = fakeQuery([], []);
		await new ClaudeCodeBackend({ query: dropped.query, env }).start(start);
		expect(dropped.calls.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(env.ANTHROPIC_API_KEY).toBe("sk-secret");

		const kept = fakeQuery([], []);
		await new ClaudeCodeBackend({ query: kept.query, env, keepApiKey: true }).start(start);
		expect(kept.calls.options.env).toHaveProperty("ANTHROPIC_API_KEY", "sk-secret");
	});
});

describe("ClaudeCodeBackend turns", () => {
	it("streams a turn, including the session_started that arrived before it", async () => {
		const { query, calls } = fakeQuery([init], [[text("Hi "), text("there"), result(0.03)]]);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		const events = await collect(session.send("hello"));

		expect(calls.prompts).toEqual(["hello"]);
		expect(events).toEqual([
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-opus-5-5",
				authSource: "subscription",
				permissionMode: "normal",
			},
			{ type: "text_delta", text: "Hi " },
			{ type: "text_delta", text: "there" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 10, output: 2, cacheRead: 7, cacheWrite: 1 },
				costUsd: 0.03,
				phases: {
					main: {
						usage: { input: 10, output: 2, cacheRead: 7, cacheWrite: 1 },
						costUsd: 0.03,
						agents: [{ role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5" }],
					},
				},
				durationMs: expect.any(Number),
			},
		]);
	});

	it("names in the main phase the effort Claude Code applied, from its Stop hook, when no level was asked", async () => {
		const { query, calls } = fakeQuery(
			[init],
			[
				[text("a"), stop("high"), result(0.03)],
				[stop("max"), result(0.05)],
			],
		);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		const first = await collect(session.send("one"));
		const second = await collect(session.send("two"));

		expect(first.map((event) => event.type)).toEqual(["session_started", "text_delta", "turn_finished"]);
		expect(first[0]).not.toHaveProperty("effort");
		const orchestrator = { role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5" };
		expect(first.at(-1)?.phases).toMatchObject({ main: { agents: [{ ...orchestrator, effectiveEffort: "high" }] } });
		expect(second.at(-1)?.phases).toMatchObject({ main: { agents: [{ ...orchestrator, effectiveEffort: "max" }] } });
		// The hook only reads.
		expect(calls.hookOutputs).toEqual([{}, {}]);
	});

	it("says no effective effort when Claude Code reports none or one it does not know", async () => {
		const { query } = fakeQuery(
			[init],
			[
				[stop(), result(0.01)],
				[stop("turbo"), result(0.02)],
			],
		);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		for (const prompt of ["one", "two"]) {
			const finished = (await collect(session.send(prompt))).at(-1);
			expect(finished?.phases).toEqual({
				main: expect.objectContaining({
					agents: [{ role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5" }],
				}),
			});
		}
	});

	it("does not read the applied effort when Atelier asked a level", async () => {
		const { query, calls } = fakeQuery([init], [[stop("high"), result(0.03)]]);
		const session = await Session.start({
			backend: new ClaudeCodeBackend({ query, env: {} }),
			cwd: "/w",
			tools: [],
			thinking: "medium",
		});
		const finished = (await collect(session.send("one"))).at(-1);

		expect(calls.options.hooks?.Stop).toBeUndefined();
		expect(finished?.phases).toEqual({
			main: expect.objectContaining({
				agents: [{ role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }],
			}),
		});
	});

	it("reuses one SDK query across turns and reports per-turn cost", async () => {
		const { query, calls } = fakeQuery([init], [[result(0.03)], [text("again"), result(0.05)]]);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		await collect(session.send("one"));
		const second = await collect(session.send("two"));

		expect(calls.prompts).toEqual(["one", "two"]);
		expect(second.at(-1)).toMatchObject({ type: "turn_finished" });
		expect(second.at(-1)?.costUsd).toBeCloseTo(0.02);
	});

	it("reports a crash of Claude Code as an error and refuses later turns", async () => {
		const { query } = fakeQuery([init], [[text("a"), new Error("claude exited with code 1")]]);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		const first = await collect(session.send("x"));

		expect(first).toContainEqual({
			type: "error",
			code: "backend_crashed",
			message: "claude exited with code 1",
			recoverable: false,
		});
		expect(first.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });

		const second = await collect(session.send("y"));
		expect(second[0]).toMatchObject({ type: "error", code: "backend_error", message: "claude exited with code 1" });
	});

	it("leaves a finished turn untouched when Claude Code crashes after it, and reports the crash in the next turn", async () => {
		const { query } = fakeQuery([init], [[text("done"), result(0.03), new Error("claude exited with code 1")]]);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		const first = await collect(session.send("x"));

		expect(first.map((e) => e.type)).toEqual(["session_started", "text_delta", "turn_finished"]);
		expect(first.at(-1)).toMatchObject({ stopReason: "end_turn", costUsd: 0.03 });

		const second = await collect(session.send("y"));
		expect(second).toContainEqual({
			type: "error",
			code: "backend_crashed",
			message: "claude exited with code 1",
			recoverable: false,
		});
		expect(second.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });

		const third = await collect(session.send("z"));
		expect(third[0]).toMatchObject({ type: "error", code: "backend_error", message: "claude exited with code 1" });
	});

	it("reports Claude Code ending after a finished turn in the next turn, not in the finished one", async () => {
		const h = controlledQuery();
		const session = await Session.start({
			backend: new ClaudeCodeBackend({ query: h.query, env: {} }),
			cwd: "/w",
			tools: [],
		});
		const pending = collect(session.send("x"));
		h.output.push(result(0));
		h.output.close();
		const first = await pending;
		expect(first.map((e) => e.type)).toEqual(["turn_finished"]);
		expect(first[0]).toMatchObject({ stopReason: "end_turn" });

		const second = await collect(session.send("y"));
		expect(second).toContainEqual({
			type: "error",
			code: "backend_ended",
			message: "Claude Code ended the session.",
			recoverable: false,
		});
		expect(second.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
	});

	it("ignores an interrupt that arrives after the turn finished", async () => {
		vi.useFakeTimers();
		try {
			const h = controlledQuery();
			const backend = new ClaudeCodeBackend({ query: h.query, env: {}, interruptGraceMs: 5000 });
			const session = await backend.start({
				cwd: "/w",
				systemPromptAppend: "",
				tools: [],
				executeTool: async () => ({ ok: true, output: "" }),
			});
			const first: string[] = [];
			const pending = (async () => {
				for await (const event of session.send("x")) first.push(event.type);
			})();
			h.output.push(result(0));
			await pending;
			await session.interrupt();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.close).not.toHaveBeenCalled();
			expect(first).toEqual(["turn_finished"]);

			const second: string[] = [];
			const next = (async () => {
				for await (const event of session.send("y")) second.push(event.type);
			})();
			h.output.push(result(0));
			await next;
			expect(second).toEqual(["turn_finished"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["a Max subscription", SUBSCRIPTION, "none", "subscription"],
		["a third-party provider", { apiProvider: "bedrock" }, "none", "other"],
		["a login without a subscription", { apiProvider: "firstParty" }, "none", "other"],
		["an API key", {}, "ANTHROPIC_API_KEY", "api_key"],
	])("reports %s as authSource %s", async (_name, account, apiKeySource, authSource) => {
		const boot = [msg({ ...(init as unknown as Record<string, unknown>), apiKeySource })];
		const { query } = fakeQuery(boot, [[result(0)]], account);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		const events = await collect(session.send("x"));
		expect(events[0]).toMatchObject({ type: "session_started", authSource });
	});

	it("reports an error when Claude Code ends without finishing the turn", async () => {
		const h = controlledQuery();
		const session = await Session.start({
			backend: new ClaudeCodeBackend({ query: h.query, env: {} }),
			cwd: "/w",
			tools: [],
		});
		const pending = collect(session.send("x"));
		h.output.close();
		const events = await pending;
		expect(events).toContainEqual({
			type: "error",
			code: "backend_ended",
			message: "Claude Code ended the session.",
			recoverable: false,
		});
		expect(events.at(-1)).toMatchObject({ type: "turn_finished" });
	});

	it("closes the SDK query when an interrupt does not finish the turn in time", async () => {
		vi.useFakeTimers();
		try {
			const h = controlledQuery();
			const session = await Session.start({
				backend: new ClaudeCodeBackend({ query: h.query, env: {}, interruptGraceMs: 5000 }),
				cwd: "/w",
				tools: [],
			});
			const pending = collect(session.send("x"));
			await session.interrupt();
			await vi.advanceTimersByTimeAsync(4999);
			expect(h.close).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.close).toHaveBeenCalledTimes(1);
			const events = await pending;
			expect(events.at(-1)).toMatchObject({ type: "turn_finished" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not close the query when the interrupted turn finishes in time", async () => {
		vi.useFakeTimers();
		try {
			const h = controlledQuery();
			const session = await Session.start({
				backend: new ClaudeCodeBackend({ query: h.query, env: {}, interruptGraceMs: 5000 }),
				cwd: "/w",
				tools: [],
			});
			const pending = collect(session.send("x"));
			await session.interrupt();
			h.output.push(result(0));
			await pending;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.close).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("hands every raw SDK message to onSdkMessage, for recording fixtures", async () => {
		const recorded: SDKMessage[] = [];
		const { query } = fakeQuery([init], [[text("hi"), result(0)]]);
		const backend = new ClaudeCodeBackend({ query, env: {}, onSdkMessage: (m) => recorded.push(m) });
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		await collect(session.send("x"));
		expect(recorded.map((m) => m.type)).toEqual(["system", "stream_event", "result"]);
	});

	it("forwards interrupt and close to the SDK query", async () => {
		const { query, calls } = fakeQuery([], []);
		const backendSession = await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		await backendSession.interrupt();
		await backendSession.close();
		expect(calls.interrupts).toBe(1);
		expect(calls.closed).toBe(true);
	});
});

describe("ClaudeCodeBackend compaction", () => {
	const boundary = msg({
		type: "system",
		subtype: "compact_boundary",
		compact_metadata: { trigger: "manual", pre_tokens: 9000 },
	});

	it("forwards /compact with the instructions and gives the core's state once with the next prompt", async () => {
		const { query, calls } = fakeQuery([init], [[boundary, result(0.01)], [result(0.02)], [result(0.03)]]);
		const backend = new ClaudeCodeBackend({ query, env: {} });
		const session = await backend.start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
			compactionState: () => "<state>\nphase: implementing\n</state>",
		});
		if (!session.compact) throw new Error("The claude-code session cannot compact.");
		const events: string[] = [];
		for await (const event of session.compact("Keep the decisions")) events.push(event.type);
		for await (const _ of session.send("next")) void _;
		for await (const _ of session.send("after")) void _;
		expect(calls.prompts).toEqual([
			"/compact Keep the decisions",
			"<state>\nphase: implementing\n</state>\n\nnext",
			"after",
		]);
		expect(events).toEqual(["session_started", "compaction_started", "compaction_finished", "turn_finished"]);
	});

	it("hands Claude Code's summary to the core from its PostCompact hook, only when the core asks for it", async () => {
		const { query, calls } = fakeQuery([init], []);
		const summaries: string[] = [];
		await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
			compacted: (summary) => summaries.push(summary),
		});
		const [matcher] = calls.options.hooks?.PostCompact ?? [];
		const [hook] = matcher?.hooks ?? [];
		if (!hook) throw new Error("No PostCompact hook.");
		const input = { hook_event_name: "PostCompact", trigger: "auto", compact_summary: "## Goal\n- x" };
		expect(await hook(input as never, undefined, { signal: new AbortController().signal })).toEqual({});
		expect(summaries).toEqual(["## Goal\n- x"]);

		const without = fakeQuery([init], []);
		await new ClaudeCodeBackend({ query: without.query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		expect(without.calls.options.hooks?.PostCompact).toBeUndefined();
	});

	it("sends a bare /compact without instructions and no state when the core has none", async () => {
		const { query, calls } = fakeQuery([init], [[boundary, result(0.01)], [result(0.02)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		for await (const _ of session.compact?.() ?? []) void _;
		for await (const _ of session.send("next")) void _;
		expect(calls.prompts).toEqual(["/compact", "next"]);
	});
});

describe("createToolBridge", () => {
	function bridgeWith(results: { ok: boolean; output: string }[]) {
		const received: ToolCall[] = [];
		const bridge = createToolBridge([echo], async (call) => {
			received.push(call);
			return results.shift() ?? { ok: true, output: "" };
		});
		const handler = bridge.definitions[0]?.handler as (args: unknown, extra: unknown) => Promise<unknown>;
		return { bridge, handler, received };
	}

	it("routes a call to the core with the tool_use id announced by the assistant message", async () => {
		const { bridge, handler, received } = bridgeWith([{ ok: true, output: "hi" }]);
		bridge.observe(
			msg({
				type: "assistant",
				parent_tool_use_id: null,
				message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__atelier__echo", input: { text: "hi" } }] },
			}),
		);
		const response = await handler({ text: "hi" }, {});
		expect(received).toEqual([{ tool: "echo", input: { text: "hi" }, callId: "toolu_1" }]);
		expect(response).toEqual({ content: [{ type: "text", text: "hi" }] });
	});

	it("prefers the id in the MCP request metadata without consuming an unrelated announced id", async () => {
		const { bridge, handler, received } = bridgeWith([]);
		bridge.observe(
			msg({
				type: "assistant",
				parent_tool_use_id: null,
				message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__atelier__echo", input: {} }] },
			}),
		);
		await handler({ text: "a" }, { _meta: { "claudecode/toolUseId": "toolu_meta" } });
		await handler({ text: "b" }, {});
		expect(received.map((c) => c.callId)).toEqual(["toolu_meta", "toolu_1"]);
	});

	it("marks failed results as MCP errors", async () => {
		const { handler } = bridgeWith([{ ok: false, output: "denied" }]);
		expect(await handler({ text: "x" }, {})).toEqual({ content: [{ type: "text", text: "denied" }], isError: true });
	});

	it("announces the tool_use ids of a real recorded session in order", async () => {
		const { readFile } = await import("node:fs/promises");
		const text = await readFile(
			new URL("./fixtures/claude-code/recorded-opus-email-validation.jsonl", import.meta.url),
			"utf8",
		);
		const received: ToolCall[] = [];
		const names = ["read", "edit", "bash", "grep"];
		const tools = names.map((name) =>
			defineTool({
				name,
				description: name,
				inputShape: {},
				execute: async () => ({ ok: true, output: "", summary: "", truncated: false }),
			}),
		);
		const bridge = createToolBridge(tools, async (call) => {
			received.push(call);
			return { ok: true, output: "" };
		});
		const handlers = new Map(
			bridge.definitions.map((d) => [d.name, d.handler as (a: unknown, e: unknown) => Promise<unknown>]),
		);
		for (const line of text.trim().split("\n")) {
			const message = JSON.parse(line) as SDKMessage;
			bridge.observe(message);
			if (message.type !== "assistant") continue;
			for (const block of message.message.content)
				if (block.type === "tool_use") await handlers.get(block.name.replace("mcp__atelier__", ""))?.({}, {});
		}
		expect(received.map((c) => [c.tool, c.callId])).toEqual([
			["bash", "toolu_01En89Jc6N4oF17qvMEB5n84"],
			["bash", "toolu_01KKayNQQP2ZH9z8tDxUTTty"],
			["edit", "toolu_01ND4iZQof5peGbuURCivLQN"],
			["edit", "toolu_01YHUMT5pDixQ53jqEqkovrP"],
			["bash", "toolu_01CPZpDuBzNKYTYLtM6JJTy9"],
		]);
	});

	it("exposes each tool with its name, description and input shape", () => {
		const { bridge } = bridgeWith([]);
		expect(bridge.definitions.map((d) => [d.name, d.description, Object.keys(d.inputSchema)])).toEqual([
			["echo", "Echo", ["text"]],
		]);
	});
});

describe("ClaudeCodeBackend subagent compaction", () => {
	const auto = msg({
		type: "system",
		subtype: "compact_boundary",
		compact_metadata: { trigger: "auto", pre_tokens: 9000 },
	});
	const tooLong = msg({
		type: "result",
		subtype: "success",
		is_error: true,
		stop_reason: "end_turn",
		total_cost_usd: 0.01,
		result: "Prompt is too long",
		usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	});

	/** A parent with memory that delegates once to a worker whose Claude Code plays `reply`. */
	async function delegate(reply: SDKMessage[]) {
		const child = fakeQuery([init], [reply]);
		const parent = new FakeBackend([
			[
				{ toolCall: { tool: "task", input: { agent: "worker", prompt: "Refactor" }, callId: "c1" } },
				{
					event: {
						type: "turn_finished",
						stopReason: "end_turn",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				},
			],
		]);
		const memory = new FakeMemory("proj");
		const session = await Session.start({
			backend: parent,
			cwd: process.cwd(),
			tools: [],
			memory,
			subagents: {
				agents: [{ name: "worker", description: "w", tools: [], prompt: "p", models: {}, maxRequests: 10 }],
				createBackend: () => new ClaudeCodeBackend({ query: child.query, env: {} }),
			},
		});
		const events: AtelierEvent[] = [];
		for await (const event of session.send("go")) events.push(event);
		await session.close();
		return {
			child: events.filter((e) => e.parentCallId === "c1"),
			result: parent.toolResults[0],
			memory,
			calls: child.calls,
		};
	}

	it("shows Claude Code's own compaction of a child under the task call, and keeps its summary out of memory", async () => {
		const { child, result: outcome, memory, calls } = await delegate([auto, text("the report"), result(0.01)]);
		expect(child.filter((e) => e.type.startsWith("compaction")).map((e) => [e.type, e.agent])).toEqual([
			["compaction_started", "worker"],
			["compaction_finished", "worker"],
		]);
		expect(child.find((e) => e.type === "compaction_started")).toMatchObject({ reason: "threshold" });
		expect(outcome).toMatchObject({ ok: true, output: "the report" });
		// No PostCompact hook: Claude Code never hands the child's summary to the core.
		expect(calls.options.hooks?.PostCompact).toBeUndefined();
		expect(memory.saved).toEqual([]);
	});

	it("fails the task with Claude Code's error when the child's context overflows", async () => {
		const { result } = await delegate([tooLong]);
		expect(result).toMatchObject({
			ok: false,
			output: "The worker subagent failed (end_turn): result_error: Prompt is too long",
		});
	});
});
