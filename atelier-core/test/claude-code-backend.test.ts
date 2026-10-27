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

/** In a scripted reply: Claude Code runs its PostCompact hooks with this summary. */
interface PostCompactHook {
	postCompact: string;
}

/** Fake SDK query: emits `boot` at start, then plays one scripted reply per user message. */
function fakeQuery(
	boot: SDKMessage[],
	replies: (SDKMessage | Error | StopHook | PostCompactHook)[][],
	account: Record<string, unknown> = SUBSCRIPTION,
) {
	const calls: {
		options: Options;
		prompts: string[];
		/** The prompts and the control calls (`setModel:x`, `flags:{...}`), in the order the query got them. */
		order: string[];
		interrupts: number;
		closed: boolean;
		hookOutputs: unknown[];
	} = {
		options: {},
		prompts: [],
		order: [],
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
				calls.order.push(`prompt:${message.message.content as string}`);
				for (const item of replies.shift() ?? []) {
					if (item instanceof Error) throw item;
					if ("postCompact" in item) {
						const input = { hook_event_name: "PostCompact", trigger: "manual", compact_summary: item.postCompact };
						for (const matcher of options.hooks?.PostCompact ?? [])
							for (const hook of matcher.hooks)
								await hook(input as never, undefined, { signal: new AbortController().signal });
						continue;
					}
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
			async setModel(model?: string) {
				calls.order.push(`setModel:${model}`);
			},
			async applyFlagSettings(settings: unknown) {
				calls.order.push(`flags:${JSON.stringify(settings)}`);
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
		expect(o.settings).toEqual({
			includeGitInstructions: false,
			autoMemoryEnabled: false,
			showThinkingSummaries: true,
		});
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
			// Thinking stays on there, so its summary is still asked for.
			expect(calls.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(calls.options).not.toHaveProperty("effort");
			const [started] = await collectBodies(session.send("hi"));
			expect(started).toMatchObject({ type: "session_started", model, effort: "unsupported" });
		},
	);

	it("passes no effort and says none when no level was asked", async () => {
		const { query, calls } = fakeQuery([init], [[result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start(plainStart);
		expect(calls.options).not.toHaveProperty("effort");
		const [started] = await collectBodies(session.send("hi"));
		expect(started).not.toHaveProperty("effort");
	});

	it.each([undefined, "claude-sonnet-5-5", "opus"])(
		"asks %s for adaptive thinking summarized, which the API omits by default",
		async (model) => {
			const { query, calls } = fakeQuery([], []);
			await new ClaudeCodeBackend({ query, env: {} }).start({ ...plainStart, ...(model ? { model } : {}) });
			expect(calls.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(calls.options.settings).toMatchObject({ showThinkingSummaries: true });
		},
	);

	it("asks no thinking of a model where adaptive would turn it on or be refused", async () => {
		const { query, calls } = fakeQuery([], []);
		await new ClaudeCodeBackend({ query, env: {} }).start({ ...plainStart, model: "claude-opus-4-6" });
		expect(calls.options).not.toHaveProperty("thinking");
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

describe("ClaudeCodeBackend configure", () => {
	const start = (query: QueryFunction, extra: Partial<Parameters<ClaudeCodeBackend["start"]>[0]> = {}) =>
		new ClaudeCodeBackend({ query, env: {} }).start({ ...plainStart, ...extra });

	it("sets the model and the effort in the open query before the next prompt", async () => {
		const { query, calls } = fakeQuery([init], [[result(0.01)], [result(0.02)]]);
		const session = await start(query, { thinking: "low" });
		await collectBodies(session.send("one"));
		await session.configure?.({ model: "sonnet", thinking: "xhigh" });
		await collectBodies(session.send("two"));
		expect(calls.order).toEqual(["prompt:one", "setModel:sonnet", 'flags:{"effortLevel":"xhigh"}', "prompt:two"]);
	});

	it("sends only what changed", async () => {
		const { query, calls } = fakeQuery([init], []);
		const session = await start(query, { model: "opus", thinking: "low" });
		await session.configure?.({ model: "haiku" });
		await session.configure?.({ thinking: "max" });
		expect(calls.order).toEqual(["setModel:haiku", 'flags:{"effortLevel":"max"}']);
	});

	it("sends minimal as low, like at start", async () => {
		const { query, calls } = fakeQuery([init], []);
		const session = await start(query);
		await session.configure?.({ thinking: "minimal" });
		expect(calls.order).toEqual(['flags:{"effortLevel":"low"}']);
	});

	it("clears the effort when the model does not take the level, and says it unsupported", async () => {
		const { query, calls } = fakeQuery([init], [[result(0.01)]]);
		const session = await start(query, { model: "opus", thinking: "xhigh" });
		await session.configure?.({ model: "claude-sonnet-4-6" });
		expect(calls.order).toEqual(["setModel:claude-sonnet-4-6", 'flags:{"effortLevel":null}']);
	});

	it("refuses to turn thinking off in an open query, where Claude Code has no way to do it", async () => {
		const { query, calls } = fakeQuery([init], []);
		const session = await start(query, { model: "claude-haiku-5-5" });
		await expect(session.configure?.({ thinking: "off" })).rejects.toThrow(
			"claude-code cannot turn thinking off in an open session.",
		);
		expect(calls.order).toEqual([]);
	});

	it("reports a query that rejects the change", async () => {
		const { query } = fakeQuery([init], []);
		const failing: QueryFunction = (params) =>
			Object.assign(query(params), {
				async setModel() {
					throw new Error("unknown model");
				},
			}) as SdkQuery;
		const session = await start(failing);
		await expect(session.configure?.({ model: "nope" })).rejects.toThrow("unknown model");
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
				at: expect.any(String),
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

	it("does not carry the effort of a turn into the next one when Claude Code crashed between them", async () => {
		const { query } = fakeQuery(
			[init],
			[[text("a"), stop("high"), result(0.03), new Error("claude exited with code 1")]],
		);
		const session = await Session.start({ backend: new ClaudeCodeBackend({ query, env: {} }), cwd: "/w", tools: [] });
		const first = await collect(session.send("one"));
		const second = await collect(session.send("two"));

		expect(first.at(-1)?.phases).toMatchObject({ main: { agents: [{ effectiveEffort: "high" }] } });
		expect(second.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
		const ended = second.at(-1) as { phases?: { main?: { agents?: object[] } } } | undefined;
		for (const agent of ended?.phases?.main?.agents ?? []) expect(agent).not.toHaveProperty("effectiveEffort");
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

	it("hands Claude Code's summary to the core from its PostCompact hook when the core asks for it", async () => {
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
		// The hook is there for `summarize` too; without a callback it has nobody to tell.
		const [quiet] = without.calls.options.hooks?.PostCompact?.[0]?.hooks ?? [];
		if (!quiet) throw new Error("No PostCompact hook.");
		expect(await quiet(input as never, undefined, { signal: new AbortController().signal })).toEqual({});
	});

	it("summarizes through /compact and keeps the summary for the caller, not for the core's callback", async () => {
		const reply: (SDKMessage | PostCompactHook)[] = [boundary, { postCompact: "## Goal\n- carried" }, result(0.01)];
		const { query, calls } = fakeQuery([init], [[result(0.005)], reply]);
		const summaries: string[] = [];
		const session = await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
			compacted: (summary) => summaries.push(summary),
		});
		for await (const _ of session.send("work")) void _;
		const summary = await session.summarize?.();
		expect(summary).toEqual({
			text: "## Goal\n- carried",
			usage: { input: 10, output: 2, cacheRead: 7, cacheWrite: 1 },
			costUsd: 0.005,
		});
		expect(calls.prompts).toEqual(["work", "/compact"]);
		expect(summaries).toEqual([]);
	});

	it("fails to summarize when Claude Code reports no summary", async () => {
		const { query } = fakeQuery([init], [[result(0.005)], [boundary, result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start({
			cwd: "/w",
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		for await (const _ of session.send("work")) void _;
		await expect(session.summarize?.()).rejects.toThrow("Claude Code did not report a summary of the conversation.");
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
	function bridgeWith(results: { ok: boolean; output: string; steering?: string }[]) {
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

	it("gives what the user steered as a text block of its own after the tool's output", async () => {
		const { handler } = bridgeWith([{ ok: true, output: "hi", steering: "use tabs" }]);
		expect(await handler({ text: "x" }, {})).toEqual({
			content: [
				{ type: "text", text: "hi" },
				{ type: "text", text: "use tabs" },
			],
		});
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
		// The hook is there for `summarize`, but the child has no callback: its summary goes nowhere.
		const [hook] = calls.options.hooks?.PostCompact?.[0]?.hooks ?? [];
		const input = { hook_event_name: "PostCompact", trigger: "auto", compact_summary: "## Goal\n- child" };
		await hook?.(input as never, undefined, { signal: new AbortController().signal });
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

describe("ClaudeCodeBackend saved sessions", () => {
	const saved = { cwd: "/w", systemPromptAppend: "", tools: [], executeTool: async () => ({ ok: true, output: "" }) };

	it("keeps its session on disk only when the session is saved", async () => {
		const plain = fakeQuery([], []);
		await new ClaudeCodeBackend({ query: plain.query, env: {} }).start(saved);
		expect(plain.calls.options.persistSession).toBe(false);
		expect(plain.calls.options).not.toHaveProperty("resume");

		const kept = fakeQuery([], []);
		await new ClaudeCodeBackend({ query: kept.query, env: {} }).start({ ...saved, persist: true });
		expect(kept.calls.options.persistSession).toBe(true);
		expect(kept.calls.options).not.toHaveProperty("resume");
	});

	it("reports the session id its messages name as the state to resume", async () => {
		const { query } = fakeQuery([init], [[text("hi"), result(0.01)]]);
		const session = await new ClaudeCodeBackend({ query, env: {} }).start({ ...saved, persist: true });
		expect(session.resumeState?.()).toBeUndefined();
		for await (const _ of session.send("go")) {
		}
		expect(session.resumeState?.()).toEqual({ sessionId: "s" });
		await session.close();
	});

	it("resumes the saved Claude Code session, which it first checks Claude Code still has", async () => {
		const { query, calls } = fakeQuery([], []);
		const looked: unknown[] = [];
		const backend = new ClaudeCodeBackend({
			query,
			env: {},
			sessionExists: async (id, cwd) => {
				looked.push([id, cwd]);
				return true;
			},
		});
		const session = await backend.start({ ...saved, persist: true, resume: { sessionId: "cc-7" } });
		expect(looked).toEqual([["cc-7", "/w"]]);
		expect(calls.options.resume).toBe("cc-7");
		expect(calls.options.persistSession).toBe(true);
		// Until Claude Code names a session, the one resumed is the state.
		expect(session.resumeState?.()).toEqual({ sessionId: "cc-7" });
		await session.close();
	});

	it("fails to start, without opening a query, when Claude Code has lost the session", async () => {
		const { query, calls } = fakeQuery([], []);
		const backend = new ClaudeCodeBackend({ query, env: {}, sessionExists: async () => false });
		await expect(backend.start({ ...saved, resume: { sessionId: "gone" } })).rejects.toThrow(
			"Claude Code has no session gone for /w",
		);
		expect(calls.options).toEqual({});
		const failing = new ClaudeCodeBackend({
			query,
			env: {},
			sessionExists: async () => {
				throw new Error("disk");
			},
		});
		await expect(failing.start({ ...saved, resume: { sessionId: "gone" } })).rejects.toThrow("has no session gone");
	});

	it("does not take the state of another backend", async () => {
		const { query } = fakeQuery([], []);
		const backend = new ClaudeCodeBackend({ query, env: {}, sessionExists: async () => true });
		await expect(backend.start({ ...saved, resume: { messages: [] } })).rejects.toThrow("not a Claude Code session");
	});
});
