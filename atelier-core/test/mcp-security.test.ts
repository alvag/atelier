import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth-store.ts";
import { type HttpServerConfig, loadMcpConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { loginMcpServer, McpAuthStore, type McpOAuthProvider } from "../src/mcp/oauth.ts";
import { createMcpTools, mcpInstructionsNote } from "../src/mcp/tools.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

interface ResponseStub {
	writeHead(code: number, headers?: Record<string, string>): ResponseStub;
	end(): void;
}
const listeners = vi.hoisted(
	() =>
		[] as {
			closed: boolean;
			handler: (request: { url: string }, response: ResponseStub) => void;
		}[],
);
vi.mock("node:http", async (original) => {
	const actual = await original<typeof import("node:http")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		createServer(handler: (request: { url: string }, response: ResponseStub) => void) {
			const listener = Object.assign(new EventEmitter(), {
				handler,
				closed: false,
				listen(_port: number, _host: string, ready: () => void) {
					queueMicrotask(ready);
				},
				address() {
					return { port: 41234 };
				},
				closeAllConnections() {},
				close() {
					this.closed = true;
				},
			});
			listeners.push(listener);
			return listener;
		},
	};
});
let dir: string;
const secret = "sensitive-123456";
const server: HttpServerConfig = {
	name: "remote",
	transport: "http",
	url: "https://example.invalid/mcp",
	headers: {},
	enabled: true,
	timeoutMs: 100,
};
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "atelier-mcp-security-"));
	listeners.length = 0;
	vi.spyOn(Client.prototype, "close").mockResolvedValue();
	vi.spyOn(Client.prototype, "listTools").mockResolvedValue({
		tools: [{ name: secret, inputSchema: { type: "object" } }],
	});
	vi.spyOn(Client.prototype, "getInstructions").mockReturnValue(secret);
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});
it.each(["status", "instructions", "result"] as const)("redacts server-controlled %s", async (surface) => {
	vi.spyOn(Client.prototype, "connect").mockResolvedValue();
	vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ content: [{ type: "text", text: secret }] });
	const manager = new McpManager({ file: "mcp.json", servers: [server], problems: [], secrets: [secret] });
	manager.start();
	await manager.ready();
	try {
		const output =
			surface === "status"
				? JSON.stringify(manager.status())
				: surface === "instructions"
					? mcpInstructionsNote(manager, new Set())
					: (
							await (createMcpTools(manager)[1] as ToolDefinition).execute(
								{ server: "remote", tool: secret },
								{ cwd: dir },
							)
						).output;
		expect(output).not.toContain(secret);
	} finally {
		await manager.close();
	}
});
it("does not quote secret-bearing source excerpts for malformed JSON", async () => {
	const file = join(dir, "mcp.json");
	const source = '{"mcpServers":{"s":{"command":"x","env":{"TOKEN":"abc","X":x}}}}';
	await writeFile(file, source);
	const config = loadMcpConfig({ file, cwd: dir, env: {} });
	expect(config.problems).not.toHaveLength(0);
	expect(JSON.stringify(config.problems)).not.toContain("abc");
	expect(await readFile(file, "utf8")).toBe(source);
});
it("secures an existing credential file when reading it", async () => {
	const file = join(dir, "mcp-auth.json");
	const store = new McpAuthStore(file);
	store.update(server, () => ({ tokens: { access_token: secret, token_type: "Bearer" } }));
	await chmod(file, 0o644);
	expect(store.get(server)?.tokens?.access_token).toBe(secret);
	expect((await stat(file)).mode & 0o777).toBe(0o600);
});
it("closes the callback on abort while initial connection is pending", async () => {
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const stalled = new Promise<void>((_resolve, reject) => {
		release = () => reject(new Error("network stopped"));
	});
	vi.spyOn(Client.prototype, "connect").mockImplementationOnce(async () => {
		entered();
		await stalled;
	});
	vi.useFakeTimers();
	const controller = new AbortController();
	const result = loginMcpServer(server, new McpAuthStore(join(dir, "auth.json")), {
		openBrowser: () => {},
		signal: controller.signal,
		timeoutMs: 5,
	}).catch(() => {});
	await started;
	try {
		controller.abort();
		await vi.advanceTimersByTimeAsync(6);
		expect(listeners[0]?.closed).toBe(true);
	} finally {
		release();
		await result;
	}
});
it("does not resurrect credentials when an earlier login finishes after logout", async () => {
	let provider: McpOAuthProvider | undefined;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.spyOn(Client.prototype, "connect").mockImplementation(async (transport) => {
		const auth = (transport as unknown as { _authProvider?: McpOAuthProvider })._authProvider;
		if (auth && !provider) {
			provider = auth;
			auth.state();
			auth.saveCodeVerifier("verifier");
			entered();
			throw new UnauthorizedError();
		}
	});
	vi.spyOn(StreamableHTTPClientTransport.prototype, "finishAuth").mockImplementation(async function (
		this: StreamableHTTPClientTransport,
	) {
		(this as unknown as { _authProvider: McpOAuthProvider })._authProvider.saveTokens({
			access_token: secret,
			token_type: "Bearer",
		});
	});
	const store = new McpAuthStore(join(dir, "auth.json"));
	const manager = new McpManager(
		{ file: "mcp.json", servers: [server], problems: [], secrets: [] },
		{ auth: store, openBrowser: () => {} },
	);
	const login = manager.login("remote");
	await started;
	try {
		await manager.logout("remote");
		expect(store.get(server)).toBeUndefined();
		const callback = listeners[0];
		if (callback === undefined || provider === undefined) throw new Error("the sign-in did not start");
		callback.handler(
			{ url: `/callback?code=code&state=${provider.expectedState}` },
			{
				writeHead() {
					return this;
				},
				end() {},
			},
		);
		await expect(login).rejects.toThrow("cancelled by a sign-out");
		expect(store.get(server)).toBeUndefined();
	} finally {
		await manager.close();
	}
});

it("saves nothing from the final check's refresh once the sign-in is aborted", async () => {
	const controller = new AbortController();
	let calls = 0;
	vi.spyOn(Client.prototype, "connect").mockImplementation(async (transport) => {
		const auth = (transport as unknown as { _authProvider?: McpOAuthProvider })._authProvider;
		calls++;
		if (calls === 1 && auth) {
			auth.state();
			auth.saveCodeVerifier("verifier");
			queueMicrotask(() =>
				listeners[0]?.handler(
					{ url: `/callback?code=code&state=${auth.expectedState}` },
					{
						writeHead() {
							return this;
						},
						end() {},
					},
				),
			);
			throw new UnauthorizedError();
		}
		// The final check: the sign-in is aborted while its refresh answers.
		controller.abort(new Error("stopped"));
		auth?.saveTokens({ access_token: secret, token_type: "Bearer" });
	});
	vi.spyOn(StreamableHTTPClientTransport.prototype, "finishAuth").mockResolvedValue();
	const store = new McpAuthStore(join(dir, "auth.json"));
	await loginMcpServer(server, store, { openBrowser: () => {}, signal: controller.signal }).catch(() => {});
	expect(calls).toBe(2);
	expect(store.get(server)?.tokens).toBeUndefined();
});

it("cuts the final check when the sign-in times out, and saves nothing from its refresh", async () => {
	let check: { provider?: McpOAuthProvider; signal?: AbortSignal } | undefined;
	let calls = 0;
	vi.spyOn(Client.prototype, "connect").mockImplementation(async (transport, options) => {
		const auth = (transport as unknown as { _authProvider?: McpOAuthProvider })._authProvider;
		calls++;
		if (calls === 1 && auth) {
			auth.state();
			auth.saveCodeVerifier("verifier");
			queueMicrotask(() =>
				listeners[0]?.handler(
					{ url: `/callback?code=code&state=${auth.expectedState}` },
					{
						writeHead() {
							return this;
						},
						end() {},
					},
				),
			);
			throw new UnauthorizedError();
		}
		// The final check: its refresh does not answer before the sign-in times out.
		check = {
			...(auth === undefined ? {} : { provider: auth }),
			...(options?.signal ? { signal: options.signal } : {}),
		};
		await new Promise(() => {});
	});
	vi.spyOn(StreamableHTTPClientTransport.prototype, "finishAuth").mockResolvedValue();
	const store = new McpAuthStore(join(dir, "auth.json"));
	await expect(loginMcpServer(server, store, { openBrowser: () => {}, timeoutMs: 50 })).rejects.toThrow("in 0 s");
	expect(check?.signal?.aborted).toBe(true);
	check?.provider?.saveTokens({ access_token: secret, token_type: "Bearer" });
	expect(store.get(server)?.tokens).toBeUndefined();
});

it("hides the providers' stored keys and ANTHROPIC_API_KEY in what the servers answer", async () => {
	const providers = new AuthStore(join(dir, "auth.json"));
	await providers.set("anthropic", { type: "api_key", key: "stored-provider-key-123" });
	const manager = new McpManager(
		{ file: join(dir, "mcp.json"), servers: [], problems: [], secrets: [] },
		{ providers, env: { ANTHROPIC_API_KEY: "env-provider-key-456", OPENCODE_API_KEY: "env-opencode-key-654" } },
	);
	expect(manager.hide("a stored-provider-key-123 and env-provider-key-456 or env-opencode-key-654")).toBe(
		"a *** and *** or ***",
	);
	const byDefault = new McpManager(
		{ file: join(dir, "mcp.json"), servers: [], problems: [], secrets: [] },
		{ env: {} },
	);
	expect(byDefault.hide("stored-provider-key-123")).toBe("***");
	await manager.close();
	await byDefault.close();
});

it("hides the stored OAuth tokens and ANTHROPIC_AUTH_TOKEN, trims stored keys, and skips blank or broken entries", async () => {
	const file = join(dir, "auth.json");
	const providers = new AuthStore(file);
	await providers.set("openai-codex", {
		type: "oauth",
		access: "access-token-123",
		refresh: "refresh-token-456",
		expires: 1,
	});
	await providers.set("anthropic", { type: "api_key", key: "  padded-provider-key-789  " });
	await providers.set("blank", { type: "api_key", key: "   " });
	const manager = new McpManager(
		{ file: join(dir, "mcp.json"), servers: [], problems: [], secrets: [] },
		{ providers, env: { ANTHROPIC_AUTH_TOKEN: "auth-token-env-321" } },
	);
	expect(manager.hide("access-token-123 refresh-token-456 padded-provider-key-789 auth-token-env-321 kept")).toBe(
		"*** *** *** *** kept",
	);
	await writeFile(file, "{not json");
	expect(manager.hide("access-token-123 kept")).toBe("access-token-123 kept");
	await rm(file);
	expect(manager.hide("plain text")).toBe("plain text");
	await manager.close();
});

it("reads the providers' keys from beside an absolute configuration only, never through a relative path", async () => {
	const folder = join(dir, "relative");
	await mkdir(folder, { mode: 0o755 });
	await chmod(folder, 0o755);
	await new AuthStore(join(folder, "auth.json")).set("anthropic", { type: "api_key", key: "relative-folder-key-1" });
	await chmod(folder, 0o755);
	const file = relative(process.cwd(), join(folder, "mcp.json"));
	const manager = new McpManager({ file, servers: [], problems: [], secrets: [] }, { env: {} });
	expect(manager.hide("relative-folder-key-1")).toBe("relative-folder-key-1");
	expect((await stat(folder)).mode & 0o777).toBe(0o755);
	await manager.close();
});
