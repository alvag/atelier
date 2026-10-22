import {
	createSdkMcpServer,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
	query as sdkQuery,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, BackendSession, BackendStartOptions, ToolExecutor } from "../../backend.ts";
import { Channel } from "../../channel.ts";
import { type AtelierEventBody, describeError, errorEvent, type JsonValue } from "../../events.ts";
import type { ToolDefinition } from "../../tools/types.ts";
import { BACKEND_ID, type MapContext, MCP_SERVER_NAME, mapSdkMessage } from "./map.ts";

export const DEFAULT_MODEL = "opus";
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** The part of the SDK's Query the backend uses. */
export interface SdkQuery extends AsyncIterable<SDKMessage> {
	interrupt(): Promise<unknown>;
	close(): void;
}

export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SdkQuery;

export interface ClaudeCodeBackendOptions {
	/** Injected in tests; defaults to the SDK's `query`. */
	query?: QueryFunction;
	/** Environment for the Claude Code process; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Keep ANTHROPIC_API_KEY. By default it is removed so the subscription is used instead of billing the API. */
	keepApiKey?: boolean;
	pathToClaudeCodeExecutable?: string;
}

/**
 * Exposes Atelier tools to Claude Code as an in-process MCP server. Handlers
 * only route to the core; ids come from the request metadata when present,
 * otherwise from the tool_use blocks announced by the assistant message.
 */
export function createToolBridge(tools: readonly ToolDefinition[], executeTool: ToolExecutor) {
	const announced = new Map<string, string[]>();

	const takeId = (toolName: string, extra: unknown): string | undefined => {
		const queue = announced.get(toolName) ?? [];
		const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
		if (typeof meta === "string") {
			const index = queue.indexOf(meta);
			queue.splice(index === -1 ? 0 : index, 1);
			return meta;
		}
		return queue.shift();
	};

	const definitions = tools.map((definition) =>
		tool(definition.name, definition.description, definition.inputShape, async (args, extra) => {
			const callId = takeId(definition.name, extra);
			const result = await executeTool({
				tool: definition.name,
				input: args as JsonValue,
				...(callId === undefined ? {} : { callId }),
			});
			return {
				content: [{ type: "text" as const, text: result.output }],
				...(result.ok ? {} : { isError: true }),
			};
		}),
	);

	return {
		definitions,
		/** Records tool_use ids from top-level assistant messages, in order. */
		observe(message: SDKMessage): void {
			if (message.type !== "assistant" || message.parent_tool_use_id !== null) return;
			for (const block of message.message?.content ?? []) {
				if (block.type !== "tool_use" || !block.name.startsWith(TOOL_PREFIX)) continue;
				const name = block.name.slice(TOOL_PREFIX.length);
				announced.set(name, [...(announced.get(name) ?? []), block.id]);
			}
		},
	};
}

function childEnv(options: ClaudeCodeBackendOptions): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...(options.env ?? process.env) };
	if (!options.keepApiKey) delete env.ANTHROPIC_API_KEY;
	env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
	env.CLAUDE_AGENT_SDK_CLIENT_APP = "atelier/0.0.0";
	return env;
}

/** Runs turns through Claude Code with the Agent SDK, using the user's Claude login. */
export class ClaudeCodeBackend implements AgentBackend {
	readonly id = BACKEND_ID;
	readonly #options: ClaudeCodeBackendOptions;

	constructor(options: ClaudeCodeBackendOptions = {}) {
		this.#options = options;
	}

	async start(start: BackendStartOptions): Promise<BackendSession> {
		const bridge = createToolBridge(start.tools, start.executeTool);
		const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "0.0.0", tools: bridge.definitions });
		const input = new Channel<SDKUserMessage>();
		const run = this.#options.query ?? (sdkQuery as QueryFunction);
		const query = run({
			prompt: input,
			options: {
				cwd: start.cwd,
				model: start.model ?? DEFAULT_MODEL,
				tools: [],
				mcpServers: { [MCP_SERVER_NAME]: server },
				strictMcpConfig: true,
				settingSources: [],
				skills: [],
				settings: { includeGitInstructions: false },
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				systemPrompt: { type: "preset", preset: "claude_code", append: start.systemPromptAppend },
				includePartialMessages: true,
				persistSession: false,
				env: childEnv(this.#options),
				...(this.#options.pathToClaudeCodeExecutable === undefined
					? {}
					: { pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable }),
			},
		});
		return new ClaudeCodeSession(query, input, bridge.observe);
	}
}

class ClaudeCodeSession implements BackendSession {
	readonly #query: SdkQuery;
	readonly #input: Channel<SDKUserMessage>;
	readonly #context: MapContext = { previousCostUsd: 0 };
	/** Events that arrive between turns (for example system/init) wait for the next turn. */
	#early: AtelierEventBody[] = [];
	#turn: Channel<AtelierEventBody> | undefined;
	#failure: string | undefined;

	constructor(query: SdkQuery, input: Channel<SDKUserMessage>, observe: (message: SDKMessage) => void) {
		this.#query = query;
		this.#input = input;
		void this.#read(observe);
	}

	async #read(observe: (message: SDKMessage) => void): Promise<void> {
		try {
			for await (const message of this.#query) {
				observe(message);
				this.#deliver(mapSdkMessage(message, this.#context));
				if (message.type === "result") {
					this.#context.previousCostUsd = message.total_cost_usd;
					this.#endTurn();
				}
			}
			this.#failure ??= "Claude Code ended the session.";
		} catch (error) {
			this.#failure = describeError(error);
			this.#deliver([errorEvent("backend_crashed", this.#failure)]);
		} finally {
			this.#endTurn();
		}
	}

	#deliver(events: AtelierEventBody[]): void {
		for (const event of events) {
			if (this.#turn) this.#turn.push(event);
			else this.#early.push(event);
		}
	}

	#endTurn(): void {
		this.#turn?.close();
		this.#turn = undefined;
	}

	async *send(prompt: string): AsyncIterable<AtelierEventBody> {
		if (this.#failure !== undefined) throw new Error(this.#failure);
		const turn = new Channel<AtelierEventBody>();
		for (const event of this.#early) turn.push(event);
		this.#early = [];
		this.#turn = turn;
		this.#input.push({
			type: "user",
			message: { role: "user", content: prompt },
			parent_tool_use_id: null,
		} as SDKUserMessage);
		yield* turn;
	}

	async interrupt(): Promise<void> {
		await this.#query.interrupt().catch(() => {});
	}

	async close(): Promise<void> {
		this.#input.close();
		this.#query.close();
	}
}
