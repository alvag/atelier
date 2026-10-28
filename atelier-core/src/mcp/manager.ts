import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AuthStore } from "../auth-store.ts";
import { describeError, type McpServerStatus } from "../events.ts";
import { VERSION } from "../version.ts";
import { type HttpServerConfig, type McpConfig, type McpServerConfig, redact } from "./config.ts";
import {
	httpTransport,
	loginMcpServer,
	logoutMcpServer,
	type McpAuthStore,
	McpOAuthProvider,
	openInBrowser,
	usesOAuth,
} from "./oauth.ts";
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
	readonly #auth: McpAuthStore | undefined;
	readonly #providers: AuthStore | undefined;
	/** The providers' secrets as last read, kept while `auth.json` is the same file with the same size and time. */
	#providerSecrets: { stamp: string; secrets: string[] } | undefined;
	readonly #env: Record<string, string | undefined>;
	readonly #openBrowser: (url: URL) => void | Promise<void>;
	/** Aborted on close: a sign-in waiting for the browser stops. */
	readonly #closing = new AbortController();
	/** The sign-ins under way, by server: a sign-out cancels its server's. */
	readonly #logins = new Map<string, AbortController>();
	#closed = false;

	/** `auth` holds the OAuth credentials of HTTP servers; without it no server signs in. `openBrowser` opens a sign-in page. */
	constructor(
		config: McpConfig,
		options: {
			auth?: McpAuthStore;
			openBrowser?: (url: URL) => void | Promise<void>;
			/**
			 * The providers' keys `atelier login` stored; by default `auth.json` next to the configuration file when its
			 * path is absolute, and none otherwise (a relative path would name the working directory).
			 */
			providers?: AuthStore;
			/** Where ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are read from, to hide them too; this process's by default. */
			env?: Record<string, string | undefined>;
		} = {},
	) {
		this.#auth = options.auth;
		this.#providers =
			options.providers ??
			(isAbsolute(config.file) ? new AuthStore(join(dirname(config.file), "auth.json")) : undefined);
		this.#env = options.env ?? process.env;
		this.#openBrowser = options.openBrowser ?? openInBrowser;
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
			tools: state === "connected" ? tools.map((tool) => this.hide(tool.name)) : [],
			...(config.description === undefined ? {} : { description: config.description }),
			...(error === undefined ? {} : { error: this.#hide(error) }),
			...(stderr === undefined ? {} : { stderr: this.#hide(stderr) }),
		}));
		return [...listed, ...this.#invalid];
	}

	/** What is wrong with the configuration file itself, not with one entry, and with the permissions of `mcp-auth.json`. */
	problems(): string[] {
		// Reading the sign-ins checks their file's permissions.
		this.#auth?.secrets();
		const auth = this.#auth?.problem();
		return [...this.#fileProblems, ...(auth === undefined ? [] : [this.#hide(auth)])];
	}

	/** The server's tools while it is connected. */
	tools(name: string): Tool[] {
		const server = this.#servers.get(name);
		return server?.state === "connected" ? server.tools : [];
	}

	/** The server's instructions, with the secrets hidden: the server writes them. */
	instructions(name: string): string | undefined {
		const instructions = this.#servers.get(name)?.instructions;
		return instructions === undefined ? undefined : this.hide(instructions);
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

	/** Signs an HTTP server in with OAuth through the browser, then connects it again. Rejects with the secrets hidden. */
	async login(name: string): Promise<void> {
		const server = this.#oauthServer(name);
		const cancel = new AbortController();
		this.#logins.get(name)?.abort(new Error("another sign-in to this server started"));
		this.#logins.set(name, cancel);
		try {
			await server.connecting;
			await loginMcpServer(server.config as HttpServerConfig, this.#auth as McpAuthStore, {
				openBrowser: this.#openBrowser,
				signal: AbortSignal.any([this.#closing.signal, cancel.signal]),
			});
		} catch (error) {
			throw new Error(this.#hide(describeError(error)));
		} finally {
			if (this.#logins.get(name) === cancel) this.#logins.delete(name);
		}
		if (cancel.signal.aborted) return;
		await this.#reconnect(server);
	}

	/** Deletes an HTTP server's OAuth credentials, then connects it again, now without them. */
	async logout(name: string): Promise<void> {
		const server = this.#oauthServer(name);
		// A sign-in under way would save its tokens when the browser comes back: it stops first.
		this.#logins.get(name)?.abort(new Error("the sign-in was cancelled by a sign-out"));
		this.#logins.delete(name);
		await server.connecting;
		logoutMcpServer(server.config as HttpServerConfig, this.#auth as McpAuthStore);
		await this.#reconnect(server);
	}

	#oauthServer(name: string): Server {
		const server = this.#servers.get(name);
		if (server === undefined) throw new Error(`No MCP server named "${name}"`);
		if (this.#auth === undefined || server.config.transport !== "http" || !usesOAuth(server.config))
			throw new Error(
				`The MCP server "${name}" does not sign in: only HTTP servers without an Authorization header do`,
			);
		if (server.state === "disabled") throw new Error(`The MCP server "${name}" is disabled`);
		return server;
	}

	async #reconnect(server: Server): Promise<void> {
		if (this.#closed) return;
		const client = server.client;
		server.client = undefined;
		await client?.close().catch(() => {});
		this.#connect(server);
		await server.connecting;
	}

	/** Closes every server and stops their processes; later calls are refused. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#closing.abort(new Error("the sign-in stopped: the MCP servers closed"));
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
		const transport = this.#transport(config);
		try {
			await client.connect(transport, { timeout: config.timeoutMs });
			server.tools = await listTools(client, config.timeoutMs);
			const instructions = client.getInstructions()?.trim();
			if (instructions) server.instructions = instructions;
		} catch (error) {
			await client.close().catch(() => {});
			if (needsSignIn(config, error)) {
				server.state = "needs_auth";
				server.error = `sign-in required: run atelier mcp login ${config.name}`;
			} else this.#failed(server, describeError(error), transport);
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

	/** A stdio server's process, or an HTTP server's transport: with OAuth once it has signed in. */
	#transport(config: McpServerConfig): Transport {
		if (config.transport === "stdio") return new ProcessGroupTransport(config);
		const signedIn = this.#auth !== undefined && usesOAuth(config) && this.#auth.get(config)?.tokens !== undefined;
		return httpTransport(config, signedIn && this.#auth ? new McpOAuthProvider(config, this.#auth) : undefined);
	}

	/**
	 * The text with every secret of the configuration, of the OAuth sign-ins and of the providers' credentials (the keys
	 * of `auth.json` and ANTHROPIC_API_KEY) replaced by `***`: a server's own file tool must not hand them to the agent.
	 */
	hide(text: string): string {
		return this.#hide(text);
	}

	#hide(text: string): string {
		const fromEnv = ENV_CREDENTIALS.flatMap((name) => this.#env[name]?.trim() || []);
		return redact(text, [...this.#secrets, ...(this.#auth?.secrets() ?? []), ...this.#storedSecrets(), ...fromEnv]);
	}

	/** The keys of `auth.json`, read again only when the file changed (another inode, size or time), not at every answer. */
	#storedSecrets(): string[] {
		if (this.#providers === undefined) return [];
		let stamp = "none";
		try {
			const stats = lstatSync(this.#providers.file);
			stamp = `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
		} catch {
			// No file: no keys, unless one appears.
		}
		if (this.#providerSecrets?.stamp !== stamp)
			this.#providerSecrets = { stamp, secrets: stamp === "none" ? [] : this.#providers.secrets() };
		return this.#providerSecrets.secrets;
	}
}

/** The environment's Anthropic credentials, which every stdio server inherits: hidden in what servers answer. */
const ENV_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** The server wants a sign-in: its tokens are gone or refused, or it answers 401 and has no Authorization header of its own. */
function needsSignIn(config: McpServerConfig, error: unknown): boolean {
	if (config.transport !== "http" || !usesOAuth(config)) return false;
	return error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401);
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
