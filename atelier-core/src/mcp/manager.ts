import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeError, type McpServerStatus } from "../events.ts";
import { VERSION } from "../version.ts";
import { type McpConfig, type McpServerConfig, redact } from "./config.ts";
import { ProcessGroupTransport } from "./stdio.ts";

/** A server as clients see it: never a value of its configuration, and every secret hidden. */
export type { McpServerStatus };
export type McpServerState = McpServerStatus["state"];

interface Server {
	config: McpServerConfig;
	state: McpServerState;
	tools: Tool[];
	instructions?: string;
	error?: string;
	stderr?: string;
	client?: Client | undefined;
	/** The connection under way; it never rejects. */
	connecting?: Promise<void>;
}

/**
 * The session's MCP servers: connects the enabled ones in the background, keeps their state and tools, calls them,
 * and closes them. A dropped or failed server reconnects on its next call.
 */
export class McpManager {
	/** The configuration file the servers come from. */
	readonly file: string;
	readonly #servers = new Map<string, Server>();
	readonly #invalid: McpServerStatus[];
	readonly #fileProblems: string[];
	readonly #secrets: readonly string[];
	#closed = false;

	constructor(config: McpConfig) {
		this.file = config.file;
		this.#secrets = config.secrets;
		for (const server of config.servers)
			this.#servers.set(server.name, { config: server, state: server.enabled ? "connecting" : "disabled", tools: [] });
		this.#invalid = config.problems.flatMap(({ name, message }) =>
			name === undefined ? [] : [{ name, state: "invalid" as const, tools: [], error: this.#hide(message) }],
		);
		this.#fileProblems = config.problems.flatMap(({ name, message }) =>
			name === undefined ? [this.#hide(message)] : [],
		);
	}

	/** Starts connecting every enabled server; returns at once. */
	start(): void {
		for (const server of this.#servers.values()) if (server.state === "connecting") this.#connect(server);
	}

	/** Resolves when the server, or every server, is no longer connecting. */
	async ready(name?: string): Promise<void> {
		const servers = name === undefined ? [...this.#servers.values()] : [this.#servers.get(name)];
		await Promise.all(servers.map((server) => server?.connecting));
	}

	status(): McpServerStatus[] {
		const listed = [...this.#servers.values()].map(({ config, state, tools, error, stderr }) => ({
			name: config.name,
			transport: config.transport,
			state,
			tools: state === "connected" ? tools.map((tool) => tool.name) : [],
			...(config.description === undefined ? {} : { description: config.description }),
			...(error === undefined ? {} : { error: this.#hide(error) }),
			...(stderr === undefined ? {} : { stderr: this.#hide(stderr) }),
		}));
		return [...listed, ...this.#invalid];
	}

	/** What is wrong with the file itself, not with one entry. */
	problems(): string[] {
		return [...this.#fileProblems];
	}

	/** The server's tools while it is connected. */
	tools(name: string): Tool[] {
		const server = this.#servers.get(name);
		return server?.state === "connected" ? server.tools : [];
	}

	instructions(name: string): string | undefined {
		return this.#servers.get(name)?.instructions;
	}

	/** Calls a tool; a failed server is reconnected first. Rejects with the secrets hidden. */
	async call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		const server = this.#servers.get(name);
		if (server === undefined) throw new Error(`No MCP server named "${name}"`);
		if (server.state === "disabled") throw new Error(`The MCP server "${name}" is disabled`);
		if (server.state === "failed") this.#connect(server);
		await server.connecting;
		if (server.state !== "connected" || server.client === undefined)
			throw new Error(`The MCP server "${name}" is not connected: ${this.#hide(server.error ?? "unknown error")}`);
		try {
			const result = await server.client.callTool({ name: tool, arguments: args }, undefined, {
				timeout: server.config.timeoutMs,
				resetTimeoutOnProgress: true,
				...(signal === undefined ? {} : { signal }),
			});
			return result as CallToolResult;
		} catch (error) {
			throw new Error(this.#hide(describeError(error)));
		}
	}

	/** Closes every server and stops their processes; later calls are refused. */
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all(
			[...this.#servers.values()].map(async (server) => {
				await server.connecting;
				const client = server.client;
				server.client = undefined;
				await client?.close().catch(() => {});
			}),
		);
	}

	#connect(server: Server): void {
		server.state = "connecting";
		delete server.error;
		delete server.stderr;
		server.connecting = this.#open(server).finally(() => {
			delete server.connecting;
		});
	}

	async #open(server: Server): Promise<void> {
		const { config } = server;
		const client = new Client({ name: "atelier", version: VERSION });
		const transport = createTransport(config);
		try {
			await client.connect(transport, { timeout: config.timeoutMs });
			server.tools = await listTools(client, config.timeoutMs);
			const instructions = client.getInstructions()?.trim();
			if (instructions) server.instructions = instructions;
		} catch (error) {
			await client.close().catch(() => {});
			this.#failed(server, describeError(error), transport);
			return;
		}
		if (this.#closed) {
			await client.close().catch(() => {});
			return;
		}
		server.client = client;
		server.state = "connected";
		client.onclose = () => {
			if (server.client !== client) return;
			server.client = undefined;
			this.#failed(server, "the connection closed", transport);
		};
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			server.tools = await listTools(client, config.timeoutMs).catch(() => server.tools);
		});
	}

	#failed(server: Server, error: string, transport: Transport): void {
		server.state = "failed";
		server.error = error;
		const stderr = transport instanceof ProcessGroupTransport ? transport.stderr.trim() : "";
		if (stderr !== "") server.stderr = stderr;
	}

	#hide(text: string): string {
		return redact(text, this.#secrets);
	}
}

function createTransport(config: McpServerConfig): Transport {
	if (config.transport === "stdio") return new ProcessGroupTransport(config);
	// The cast is for exactOptionalPropertyTypes, which the SDK's own types do not follow (`sessionId`).
	return new StreamableHTTPClientTransport(new URL(config.url), {
		requestInit: { headers: config.headers },
	}) as Transport;
}

async function listTools(client: Client, timeout: number): Promise<Tool[]> {
	const tools: Tool[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout });
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return tools;
}
