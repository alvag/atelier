import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpServerConfig } from "../src/mcp/config.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { loginMcpServer, logoutMcpServer, McpAuthStore, McpOAuthProvider, mcpAuthFile } from "../src/mcp/oauth.ts";

let home: string;
let base: string;
let http: Server;
/** What the fake servers saw and what they hand out. */
let fake: {
	access: string;
	refresh: string;
	registered: number;
	refreshed: number;
	tokenRequests: URLSearchParams[];
	authorizationEndpoint?: string;
	redirectUrl?: string;
};

const body = (request: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let text = "";
		request.on("data", (chunk) => {
			text += chunk;
		});
		request.on("end", () => resolve(text));
	});

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-mcp-oauth-")));
	await mkdir(join(home, ".atelier"), { recursive: true });
	fake = { access: "access-token-1", refresh: "refresh-token-1", registered: 0, refreshed: 0, tokenRequests: [] };
	http = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", base);
		const json = (value: unknown, status = 200) =>
			response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
			return json({ resource: `${base}/mcp`, authorization_servers: [base] });
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return json({
				issuer: base,
				authorization_endpoint: fake.authorizationEndpoint ?? `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
			});
		if (url.pathname === "/register") {
			fake.registered++;
			const metadata = JSON.parse(await body(request));
			fake.redirectUrl = metadata.redirect_uris[0];
			return json({ ...metadata, client_id: `client-${fake.registered}` }, 201);
		}
		if (url.pathname === "/authorize") {
			const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", "the-code");
			redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
			return response.writeHead(302, { location: redirect.href }).end();
		}
		if (url.pathname === "/token") {
			const params = new URLSearchParams(await body(request));
			fake.tokenRequests.push(params);
			if (params.get("grant_type") === "refresh_token") {
				if (params.get("refresh_token") !== fake.refresh) return json({ error: "invalid_grant" }, 400);
				fake.refreshed++;
				fake.access = `access-token-${fake.refreshed + 1}`;
			} else if (params.get("code") !== "the-code") return json({ error: "invalid_grant" }, 400);
			return json({ access_token: fake.access, refresh_token: fake.refresh, token_type: "Bearer", expires_in: 3600 });
		}
		if (url.pathname === "/mcp") {
			if (request.headers.authorization !== `Bearer ${fake.access}`)
				return response
					.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
					})
					.end(`unauthorized ${request.headers.authorization ?? ""}`);
			const server = new McpServer({ name: "remote", version: "1.0.0" });
			server.registerTool("whoami", { description: "Who am I" }, async () => ({
				content: [{ type: "text", text: "you" }],
			}));
			// Stateless; the cast is for exactOptionalPropertyTypes, which the SDK's types do not follow.
			const transport = new StreamableHTTPServerTransport(
				{} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
			);
			await server.connect(transport as Parameters<typeof server.connect>[0]);
			return transport.handleRequest(request, response);
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
	http.closeAllConnections();
	await new Promise((resolve) => http.close(resolve));
	await rm(home, { recursive: true, force: true });
});

const remote = (extra: Partial<HttpServerConfig> = {}): HttpServerConfig => ({
	name: "remote",
	transport: "http",
	enabled: true,
	timeoutMs: 10_000,
	url: `${base}/mcp`,
	headers: {},
	...extra,
});

/** A browser that follows the authorization page's redirect to the callback, as the user's would. */
async function browser(url: URL): Promise<void> {
	const page = await fetch(url, { redirect: "manual" });
	const location = page.headers.get("location");
	if (location !== null) await fetch(location);
}

async function connected(server: HttpServerConfig, store: McpAuthStore): Promise<McpManager> {
	const manager = new McpManager({ file: "mcp.json", servers: [server], problems: [], secrets: [] }, { auth: store });
	manager.start();
	await manager.ready();
	return manager;
}

describe("MCP OAuth browser URLs", () => {
	it.each([
		"http://example.invalid/authorize",
		"https://example.invalid/authorize",
		"HTTP://example.invalid/authorize",
		"HTTPS://example.invalid/authorize",
	])("opens %s through the provider", async (page) => {
		const openBrowser = vi.fn();
		const provider = new McpOAuthProvider(remote(), new McpAuthStore(mcpAuthFile(home)), {
			onRedirect: openBrowser,
		});
		const url = new URL(page);
		await provider.redirectToAuthorization(url);
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith(url);
	});

	it.each(["file:///tmp/authorize", "javascript:alert(1)", "atelier-test://authorize", "FILE:///tmp/authorize"])(
		"refuses %s before calling the browser",
		async (page) => {
			const openBrowser = vi.fn();
			const provider = new McpOAuthProvider(remote(), new McpAuthStore(mcpAuthFile(home)), {
				onRedirect: openBrowser,
			});
			const url = new URL(page);
			await expect(provider.redirectToAuthorization(url)).rejects.toThrow(
				`Refused to open OAuth URL for MCP server "remote": ${url.href}; only http: and https: URLs are allowed`,
			);
			expect(openBrowser).not.toHaveBeenCalled();
		},
	);

	it("fails the manager's login without opening a file URL, exchanging tokens, or reconnecting", async () => {
		fake.authorizationEndpoint = "file:///tmp/authorize";
		const store = new McpAuthStore(mcpAuthFile(home));
		const openBrowser = vi.fn(() => {
			throw new Error("unsafe browser callback invoked");
		});
		const manager = new McpManager(
			{ file: "mcp.json", servers: [remote()], problems: [], secrets: [] },
			{ auth: store, openBrowser },
		);
		manager.start();
		await manager.ready();
		try {
			expect(manager.status()[0]?.state).toBe("needs_auth");
			await expect(manager.login("remote")).rejects.toThrow(
				/^Refused to open OAuth URL for MCP server "remote": file:\/\/\/tmp\/authorize\?.*; only http: and https: URLs are allowed$/,
			);
			expect(openBrowser).not.toHaveBeenCalled();
			expect(fake.tokenRequests).toEqual([]);
			expect(store.get(remote())?.tokens).toBeUndefined();
			expect(manager.status()[0]?.state).toBe("needs_auth");
			// Registration exposes the actual callback URI; rejection must close that listener.
			expect(fake.redirectUrl).toBeDefined();
			await expect(fetch(fake.redirectUrl as string)).rejects.toThrow();
		} finally {
			await manager.close();
		}
	});

	it("keeps a session needing sign-in after a refused refresh, but rejects a file URL on explicit login", async () => {
		const store = new McpAuthStore(mcpAuthFile(home));
		await loginMcpServer(remote(), store, { openBrowser: browser });
		fake.access = "access-rotated";
		fake.refresh = "refresh-rotated";
		fake.authorizationEndpoint = "file:///tmp/authorize";
		fake.tokenRequests = [];
		const openBrowser = vi.fn(() => {
			throw new Error("unsafe browser callback invoked");
		});
		const manager = new McpManager(
			{ file: "mcp.json", servers: [remote()], problems: [], secrets: [] },
			{ auth: store, openBrowser },
		);
		manager.start();
		await manager.ready();
		try {
			expect(fake.tokenRequests.map((params) => params.get("grant_type"))).toEqual(["refresh_token"]);
			expect(manager.status()[0]).toMatchObject({
				state: "needs_auth",
				error: "sign-in required: run atelier mcp login remote",
			});
			expect(openBrowser).not.toHaveBeenCalled();
			await expect(manager.login("remote")).rejects.toThrow(
				/^Refused to open OAuth URL for MCP server "remote": file:\/\/\/tmp\/authorize\?.*; only http: and https: URLs are allowed$/,
			);
			expect(openBrowser).not.toHaveBeenCalled();
			expect(fake.tokenRequests.map((params) => params.get("grant_type"))).toEqual(["refresh_token"]);
			expect(manager.status()[0]?.state).toBe("needs_auth");
		} finally {
			await manager.close();
		}
	});

	it.each([
		["not a URL", "Invalid URL"],
		["javascript:alert(1)", "URL cannot use javascript:, data:, or vbscript: scheme"],
	])("preserves the SDK's metadata rejection for %s", async (page, diagnostic) => {
		fake.authorizationEndpoint = page;
		const store = new McpAuthStore(mcpAuthFile(home));
		const openBrowser = vi.fn();
		await expect(loginMcpServer(remote(), store, { openBrowser })).rejects.toThrow(diagnostic);
		expect(openBrowser).not.toHaveBeenCalled();
		expect(fake.tokenRequests).toEqual([]);
		expect(store.get(remote())?.tokens).toBeUndefined();
	});
});

describe("MCP OAuth", () => {
	it("marks a server that asks for sign-in, and says how to sign in", async () => {
		const manager = await connected(remote(), new McpAuthStore(mcpAuthFile(home)));
		expect(manager.status()[0]).toMatchObject({
			state: "needs_auth",
			error: "sign-in required: run atelier mcp login remote",
		});
		await manager.close();
	});

	it("signs in through the browser, keeps the tokens in a 0600 file, and connects with them", async () => {
		const store = new McpAuthStore(mcpAuthFile(home));
		const opened: URL[] = [];
		await loginMcpServer(remote(), store, {
			openBrowser: async (url) => {
				opened.push(url);
				await browser(url);
			},
		});
		expect(opened[0]?.pathname).toBe("/authorize");
		expect(fake.registered).toBe(1);
		expect((await stat(mcpAuthFile(home))).mode & 0o777).toBe(0o600);
		expect(await readFile(mcpAuthFile(home), "utf8")).toContain("access-token-1");
		const manager = await connected(remote(), new McpAuthStore(mcpAuthFile(home)));
		expect(manager.status()[0]).toMatchObject({ state: "connected", tools: ["whoami"] });
		await manager.close();
	});

	it("refreshes an access token the server no longer takes", async () => {
		const store = new McpAuthStore(mcpAuthFile(home));
		await loginMcpServer(remote(), store, { openBrowser: browser });
		fake.access = "access-token-rotated";
		const manager = await connected(remote(), new McpAuthStore(mcpAuthFile(home)));
		expect(fake.refreshed).toBe(1);
		expect(manager.status()[0]?.state).toBe("connected");
		expect(await readFile(mcpAuthFile(home), "utf8")).toContain(fake.access);
		await manager.close();
	});

	it("never shows the tokens, in errors either", async () => {
		const store = new McpAuthStore(mcpAuthFile(home));
		await loginMcpServer(remote(), store, { openBrowser: browser });
		// The server now refuses every token and the refresh: the error quotes the bearer token.
		fake.access = "something-else";
		fake.refresh = "refresh-gone";
		const manager = await connected(remote(), new McpAuthStore(mcpAuthFile(home)));
		const shown = JSON.stringify(manager.status());
		expect(shown).not.toContain("access-token-1");
		expect(shown).not.toContain("refresh-token-1");
		expect(manager.status()[0]?.state).toBe("needs_auth");
		await manager.close();
	});

	it("uses a configured client and hides its secret, literal in the file", async () => {
		await import("node:fs/promises").then(({ writeFile }) =>
			writeFile(
				join(home, ".atelier", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						remote: { url: `${base}/mcp`, oauth: { clientId: "my-client", clientSecret: "literal-client-secret" } },
					},
				}),
			),
		);
		const config = loadMcpConfig({ home, cwd: home, env: {} });
		const server = config.servers[0] as HttpServerConfig;
		expect(server.oauth).toEqual({ clientId: "my-client", clientSecret: "literal-client-secret" });
		expect(config.secrets).toContain("literal-client-secret");
		await loginMcpServer(server, new McpAuthStore(mcpAuthFile(home)), { openBrowser: browser });
		expect(fake.registered).toBe(0);
		expect(fake.tokenRequests[0]?.get("client_id")).toBe("my-client");
	});

	it("does not use OAuth for a server with its own Authorization header", async () => {
		const manager = await connected(
			remote({ headers: { Authorization: "Bearer mine" } }),
			new McpAuthStore(mcpAuthFile(home)),
		);
		expect(manager.status()[0]?.state).toBe("failed");
		await manager.close();
	});

	it("signs out by deleting the server's credentials", async () => {
		const store = new McpAuthStore(mcpAuthFile(home));
		await loginMcpServer(remote(), store, { openBrowser: browser });
		logoutMcpServer(remote(), store);
		expect(await readFile(mcpAuthFile(home), "utf8")).not.toContain("access-token-1");
		const manager = await connected(remote(), new McpAuthStore(mcpAuthFile(home)));
		expect(manager.status()[0]?.state).toBe("needs_auth");
		await manager.close();
	});

	it("signs a session's server in and out, reconnecting it each time", async () => {
		const manager = new McpManager(
			{ file: "mcp.json", servers: [remote()], problems: [], secrets: [] },
			{ auth: new McpAuthStore(mcpAuthFile(home)), openBrowser: browser },
		);
		manager.start();
		await manager.ready();
		expect(manager.status()[0]?.state).toBe("needs_auth");
		await manager.login("remote");
		expect(manager.status()[0]).toMatchObject({ state: "connected", tools: ["whoami"] });
		await manager.logout("remote");
		expect(manager.status()[0]?.state).toBe("needs_auth");
		await expect(manager.login("nope")).rejects.toThrow('No MCP server named "nope"');
		await manager.close();
	});

	it("stops waiting for the browser when the manager closes", async () => {
		const manager = new McpManager(
			{ file: "mcp.json", servers: [remote()], problems: [], secrets: [] },
			{ auth: new McpAuthStore(mcpAuthFile(home)), openBrowser: () => {} },
		);
		const login = manager.login("remote");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await manager.close();
		await expect(login).rejects.toThrow("closed");
	});
});
