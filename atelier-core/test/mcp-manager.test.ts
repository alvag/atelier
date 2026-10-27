import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpConfig, McpServerConfig, StdioServerConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";

const FIXTURE = fileURLToPath(new URL("fixtures/mcp/server.ts", import.meta.url));
const WRAPPER = fileURLToPath(new URL("fixtures/mcp/wrapper.ts", import.meta.url));

let dir: string;
let managers: McpManager[];

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "atelier-mcp-manager-")));
	managers = [];
});

afterEach(async () => {
	await Promise.all(managers.map((manager) => manager.close()));
	await rm(dir, { recursive: true, force: true });
});

function stdio(name: string, env: Record<string, string> = {}, script = FIXTURE): StdioServerConfig {
	return {
		name,
		transport: "stdio",
		enabled: true,
		timeoutMs: 10_000,
		command: process.execPath,
		args: [script],
		env,
		cwd: dir,
	};
}

function manager(servers: McpServerConfig[], extra: Partial<McpConfig> = {}): McpManager {
	const created = new McpManager({ file: join(dir, "mcp.json"), servers, problems: [], secrets: [], ...extra });
	managers.push(created);
	created.start();
	return created;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("McpManager over stdio", () => {
	it("connects in the background and lists the server's tools and instructions", async () => {
		const mcp = manager([stdio("fixture", { MCP_INSTRUCTIONS: "Fixture tools.\nMore detail." })]);
		expect(mcp.status()[0]).toMatchObject({ name: "fixture", state: "connecting" });
		await mcp.ready();
		expect(mcp.status()[0]).toMatchObject({ state: "connected", transport: "stdio" });
		expect(mcp.status()[0]?.tools).toEqual(["echo", "big", "fail", "image", "slow"]);
		expect(mcp.instructions("fixture")).toBe("Fixture tools.\nMore detail.");
		expect(mcp.tools("fixture").find((tool) => tool.name === "echo")).toMatchObject({
			description: "Echo the text back",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
		});
		const result = await mcp.call("fixture", "echo", { text: "hi" });
		expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
	});

	it("reports a server that exits with its stderr, with every secret hidden", async () => {
		const mcp = manager([stdio("broken", { MCP_EXIT: "3", MCP_STDERR: "bad key lit-secret-value" })], {
			secrets: ["lit-secret-value"],
		});
		await mcp.ready();
		const [status] = mcp.status();
		expect(status?.state).toBe("failed");
		expect(status?.stderr).toContain("bad key ***");
		expect(JSON.stringify(mcp.status())).not.toContain("lit-secret-value");
	});

	it("reports a command that does not exist", async () => {
		const mcp = manager([{ ...stdio("missing"), command: join(dir, "no-such-command") }]);
		await mcp.ready();
		expect(mcp.status()[0]).toMatchObject({ state: "failed", error: expect.stringContaining("ENOENT") });
	});

	it("leaves disabled servers and invalid entries listed without connecting them", async () => {
		const mcp = manager([{ ...stdio("off"), enabled: false }], {
			problems: [{ name: "bad", message: "the entry must be an object" }, { message: "file problem" }],
		});
		await mcp.ready();
		expect(mcp.status()).toEqual([
			{ name: "off", transport: "stdio", state: "disabled", tools: [] },
			{ name: "bad", state: "invalid", tools: [], error: "the entry must be an object" },
		]);
		expect(mcp.problems()).toEqual(["file problem"]);
	});

	it("stops the whole process group on close, also behind a wrapper like npx", async () => {
		const pidFile = join(dir, "pid");
		const mcp = manager([stdio("wrapped", { MCP_PID_FILE: pidFile }, WRAPPER)]);
		await mcp.ready();
		expect(mcp.status()[0]?.state).toBe("connected");
		const grandchild = Number(await readFile(pidFile, "utf8"));
		expect(alive(grandchild)).toBe(true);
		await mcp.close();
		await until(() => !alive(grandchild));
	});

	it("aborts a call when its signal fires", async () => {
		const mcp = manager([stdio("fixture")]);
		await mcp.ready();
		const abort = new AbortController();
		const call = mcp.call("fixture", "slow", {}, abort.signal);
		abort.abort();
		await expect(call).rejects.toThrow();
	});

	it("rejects a call to a server it does not know", async () => {
		const mcp = manager([]);
		await expect(mcp.call("nope", "echo", {})).rejects.toThrow('No MCP server named "nope"');
	});
});

describe("McpManager over HTTP", () => {
	let http: Server;
	let seen: IncomingHttpHeaders[];
	let url: string;

	beforeEach(async () => {
		seen = [];
		http = createServer(async (request, response) => {
			seen.push(request.headers);
			if (request.headers.authorization !== "Bearer http-secret-token") {
				response.writeHead(403).end("forbidden for Bearer http-secret-token");
				return;
			}
			const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
			server.registerTool(
				"add",
				{ description: "Add", inputSchema: { a: z.number(), b: z.number() } },
				async ({ a, b }) => ({
					content: [{ type: "text", text: String(a + b) }],
				}),
			);
			// Stateless: no session id. The cast is for exactOptionalPropertyTypes, which the SDK's types do not follow.
			const transport = new StreamableHTTPServerTransport(
				{} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
			);
			await server.connect(transport as Parameters<typeof server.connect>[0]);
			await transport.handleRequest(request, response);
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
	});

	afterEach(async () => {
		http.closeAllConnections();
		await new Promise((resolve) => http.close(resolve));
	});

	const remote = (headers: Record<string, string>): McpServerConfig => ({
		name: "remote",
		transport: "http",
		enabled: true,
		timeoutMs: 10_000,
		url,
		headers,
	});

	it("connects with the configured headers and calls a tool", async () => {
		const mcp = manager([remote({ Authorization: "Bearer http-secret-token" })]);
		await mcp.ready();
		expect(mcp.status()[0]).toMatchObject({ state: "connected", transport: "http", tools: ["add"] });
		expect(seen[0]?.authorization).toBe("Bearer http-secret-token");
		const result = await mcp.call("remote", "add", { a: 2, b: 3 });
		expect(result.content).toEqual([{ type: "text", text: "5" }]);
	});

	it("reports a rejected connection without the secret", async () => {
		const mcp = manager([remote({ Authorization: "Bearer wrong-literal-token" })], {
			secrets: ["Bearer wrong-literal-token", "wrong-literal-token", "http-secret-token"],
		});
		await mcp.ready();
		const [status] = mcp.status();
		expect(status?.state).toBe("failed");
		expect(JSON.stringify(status)).not.toMatch(/wrong-literal-token|http-secret-token/);
	});
});
