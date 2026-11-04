import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
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

function serve(connectMcp?: (cwd: string) => McpManager, createBackend: () => FakeBackend = () => new FakeBackend([])) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const server = new RpcServer({
		input,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend,
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
	const close = () => {
		input.end();
		return done;
	};
	return { request, close, messages };
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

	it("answers an error when signing in to a server the session does not have", async () => {
		const rpc = serve(() => new McpManager({ file: "mcp.json", servers: [], problems: [], secrets: [] }));
		const started = await rpc.request({ command: "session.start", cwd });
		const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;
		expect(await rpc.request({ command: "session.mcp_login", sessionId, server: "nope" })).toMatchObject({
			ok: false,
			error: { message: 'No MCP server named "nope"' },
		});
		expect(await rpc.request({ command: "session.mcp_logout", sessionId, server: "nope" })).toMatchObject({
			ok: false,
		});
		await rpc.close();
	});

	describe("status changes outside a turn", () => {
		const slow = () => {
			const manager = new McpManager({
				file: join(cwd, "mcp.json"),
				servers: [
					{
						name: "slow",
						transport: "stdio",
						enabled: true,
						timeoutMs: 1000,
						command: process.execPath,
						args: [fileURLToPath(new URL("fixtures/mcp/server.ts", import.meta.url))],
						env: {},
						cwd,
					},
				],
				problems: [],
				secrets: [],
			});
			// The state changes while the session is being started, before the client knows its id.
			const backend = () => {
				const fake = new FakeBackend([]);
				const start = fake.start.bind(fake);
				fake.start = async (options) => {
					manager.start();
					await manager.ready();
					return start(options);
				};
				return fake;
			};
			return { manager, backend };
		};
		const events = (messages: ServerMessage[]) => messages.filter((m) => m.type === "session_event");
		const until = async (condition: () => boolean) => {
			for (let i = 0; i < 250 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
			expect(condition()).toBe(true);
		};

		it("sends it to a client that asked for session events, after the response that names the session", async () => {
			const { manager, backend } = slow();
			const rpc = serve(() => manager, backend);
			const started = await rpc.request({ command: "session.start", cwd, sessionEvents: true });
			await until(() => events(rpc.messages).length > 0);
			const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;
			const first = events(rpc.messages)[0];
			expect(first).toMatchObject({
				sessionId,
				event: { type: "mcp_status", servers: [{ name: "slow", state: "connected" }] },
			});
			expect(rpc.messages.indexOf(started)).toBeLessThan(rpc.messages.indexOf(first as ServerMessage));
			await rpc.close();
		});

		it("sends nothing to a client that did not ask", async () => {
			const { manager, backend } = slow();
			const rpc = serve(() => manager, backend);
			const started = await rpc.request({ command: "session.start", cwd });
			const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;
			await manager.ready();
			await rpc.request({ command: "session.mcp", sessionId });
			expect(events(rpc.messages)).toEqual([]);
			await rpc.close();
		});
	});
});
