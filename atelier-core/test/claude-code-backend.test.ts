import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	ClaudeCodeBackend,
	createToolBridge,
	type QueryFunction,
	type SdkQuery,
} from "../src/backends/claude-code/backend.ts";
import { type AtelierEvent, defineTool, Session, type ToolCall } from "../src/index.ts";

function msg(value: Record<string, unknown>): SDKMessage {
	return { uuid: "u", session_id: "s", ...value } as unknown as SDKMessage;
}

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

/** Fake SDK query: emits `boot` at start, then plays one scripted reply per user message. */
function fakeQuery(boot: SDKMessage[], replies: (SDKMessage | Error)[][]) {
	const calls: { options: Options; prompts: string[]; interrupts: number; closed: boolean } = {
		options: {},
		prompts: [],
		interrupts: 0,
		closed: false,
	};
	const query: QueryFunction = ({ prompt, options }) => {
		calls.options = options;
		async function* run(): AsyncGenerator<SDKMessage, void> {
			yield* boot;
			for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
				calls.prompts.push(message.message.content as string);
				for (const item of replies.shift() ?? []) {
					if (item instanceof Error) throw item;
					yield item;
				}
			}
		}
		const generator = run();
		return Object.assign(generator, {
			async interrupt() {
				calls.interrupts++;
			},
			close() {
				calls.closed = true;
			},
		}) as SdkQuery;
	};
	return { query, calls };
}

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: Record<string, unknown>[] = [];
	for await (const { seq: _seq, turnId: _turnId, ...body } of events) out.push(body);
	return out;
}

const echo = defineTool({
	name: "echo",
	description: "Echo",
	inputShape: { text: z.string() },
	execute: async ({ text }) => ({ ok: true, output: text, summary: text, truncated: false }),
});

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
		expect(o.settings).toEqual({ includeGitInstructions: false });
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
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
			{ type: "text_delta", text: "Hi " },
			{ type: "text_delta", text: "there" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 10, output: 2, cacheRead: 7, cacheWrite: 1 },
				costUsd: 0.03,
			},
		]);
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

	it("prefers the id in the MCP request metadata", async () => {
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
		expect(received.map((c) => c.callId)).toEqual(["toolu_meta", undefined]);
	});

	it("marks failed results as MCP errors", async () => {
		const { handler } = bridgeWith([{ ok: false, output: "denied" }]);
		expect(await handler({ text: "x" }, {})).toEqual({ content: [{ type: "text", text: "denied" }], isError: true });
	});

	it("exposes each tool with its name, description and input shape", () => {
		const { bridge } = bridgeWith([]);
		expect(bridge.definitions.map((d) => [d.name, d.description, Object.keys(d.inputSchema)])).toEqual([
			["echo", "Echo", ["text"]],
		]);
	});
});
