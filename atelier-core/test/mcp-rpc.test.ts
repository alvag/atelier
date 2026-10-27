import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, McpManager } from "../src/index.ts";
import { decodeServerMessage } from "../src/protocol/codec.ts";
import type { ServerMessage } from "../src/protocol/types.ts";
import { RpcServer } from "../src/server/rpc-server.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-mcp-rpc-")));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function serve(connectMcp?: (cwd: string) => McpManager) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const server = new RpcServer({
		input,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend: () => new FakeBackend([]),
		tools: [],
		systemPromptAppend: "",
		home: cwd,
		sessions: false,
		...(connectMcp ? { connectMcp } : {}),
	});
	const done = server.run();
	let next = 0;
	const request = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		for (let i = 0; i < 400; i++) {
			const found = messages.find((m) => m.type === "response" && m.id === id);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`no response to ${id}`);
	};
	return { request, close: () => (input.end(), done) };
}

describe("session.mcp", () => {
	it("answers the state of the session's MCP servers", async () => {
		const manager = new McpManager({
			file: join(cwd, "mcp.json"),
			servers: [
				{ name: "off", transport: "http", enabled: false, timeoutMs: 1000, url: "https://x.example/mcp", headers: {} },
			],
			problems: [{ name: "bad", message: "the entry must be an object" }],
			secrets: [],
		});
		const rpc = serve(() => manager);
		const started = await rpc.request({ command: "session.start", cwd });
		const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;
		expect(await rpc.request({ command: "session.mcp", sessionId })).toMatchObject({
			ok: true,
			result: {
				servers: [
					{ name: "off", transport: "http", state: "disabled", tools: [] },
					{ name: "bad", state: "invalid", tools: [], error: "the entry must be an object" },
				],
				problems: [],
			},
		});
		await rpc.close();
	});

	it("answers no servers for a session without MCP, and an error for an unknown session", async () => {
		const rpc = serve();
		const started = await rpc.request({ command: "session.start", cwd });
		const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;
		expect(await rpc.request({ command: "session.mcp", sessionId })).toMatchObject({
			ok: true,
			result: { servers: [], problems: [] },
		});
		expect(await rpc.request({ command: "session.mcp", sessionId: "nope" })).toMatchObject({ ok: false });
		await rpc.close();
	});
});
