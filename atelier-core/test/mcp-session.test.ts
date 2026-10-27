import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEvent, type AtelierEventBody, FakeBackend, type FakeStep, Session } from "../src/index.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import type { SubagentDefinition } from "../src/subagents/definitions.ts";

const FIXTURE = fileURLToPath(new URL("fixtures/mcp/server.ts", import.meta.url));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const call = (tool: string, input: Record<string, unknown>, callId = "c1"): FakeStep => ({
	toolCall: { tool, input: input as never, callId },
});

let dir: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "atelier-mcp-session-")));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function server(name: string, extra: Partial<McpServerConfig> = {}, env: Record<string, string> = {}): McpServerConfig {
	return {
		name,
		transport: "stdio",
		enabled: true,
		timeoutMs: 10_000,
		command: process.execPath,
		args: [FIXTURE],
		env,
		cwd: dir,
		...extra,
	} as McpServerConfig;
}

function mcp(servers: McpServerConfig[]): McpManager {
	const manager = new McpManager({ file: join(dir, "mcp.json"), servers, problems: [], secrets: [] });
	manager.start();
	return manager;
}

async function collect(stream: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("MCP in a session", () => {
	it("declares mcp_search and mcp_call and lists the servers in the system prompt", async () => {
		const backend = new FakeBackend([]);
		const session = await Session.start({
			backend,
			cwd: dir,
			tools: [],
			mcp: mcp([
				server("docs", { description: "Search the product docs" }),
				server("plain"),
				server("off", { enabled: false }),
			]),
		});
		try {
			expect(backend.startOptions?.tools.map((tool) => tool.name)).toEqual(["mcp_search", "mcp_call"]);
			const prompt = backend.startOptions?.systemPromptAppend ?? "";
			expect(prompt).toContain("find them with mcp_search and run them with mcp_call");
			expect(prompt).toContain("- docs: Search the product docs");
			expect(prompt).toContain("- plain: no description yet; mcp_search lists its tools");
			expect(prompt).not.toContain("- off");
		} finally {
			await session.close();
		}
	});

	it("has no MCP tools nor prompt block without servers", async () => {
		const backend = new FakeBackend([]);
		const session = await Session.start({ backend, cwd: dir, tools: [], mcp: mcp([]) });
		expect(backend.startOptions?.tools).toEqual([]);
		expect(backend.startOptions?.systemPromptAppend).toBe("");
		await session.close();
	});

	it("finds tools with their schema, calls them, and reports their errors", async () => {
		const backend = new FakeBackend([
			[
				call("mcp_search", { query: "echo text" }, "s1"),
				call("mcp_call", { server: "fixture", tool: "echo", arguments: { text: "hola" } }, "c1"),
				call("mcp_call", { server: "fixture", tool: "fail" }, "c2"),
				call("mcp_call", { server: "nope", tool: "echo" }, "c3"),
				{ event: finished },
			],
		]);
		const session = await Session.start({ backend, cwd: dir, tools: [], mcp: mcp([server("fixture")]) });
		try {
			const events = await collect(session.send("use the fixture"));
			const [search, echo, fail, unknown] = backend.toolResults;
			expect(search?.ok).toBe(true);
			expect(search?.output).toContain("fixture/echo — Echo the text back");
			expect(search?.output).toContain('"properties":{"text":{"type":"string"}}');
			expect(search?.output.indexOf("fixture/echo")).toBe(0);
			expect(echo).toEqual({ ok: true, output: "echo: hola" });
			expect(fail).toEqual({ ok: false, output: "it failed on purpose" });
			expect(unknown?.ok).toBe(false);
			expect(unknown?.output).toContain('No MCP server named "nope"');
			const summaries = events.flatMap((event) => (event.type === "tool_call_finished" ? [event.summary] : []));
			expect(summaries[1]).toBe("fixture › echo");
			expect(events.some((event) => event.type === "approval_requested")).toBe(false);
		} finally {
			await session.close();
		}
	});

	it("gives the first line of a server's instructions once, before the next prompt, when it has no description", async () => {
		const backend = new FakeBackend([[{ event: finished }], [{ event: finished }]]);
		const manager = mcp([server("plain", {}, { MCP_INSTRUCTIONS: "Plain tools for testing.\nDetails." })]);
		const session = await Session.start({ backend, cwd: dir, tools: [], mcp: manager });
		try {
			await manager.ready();
			await collect(session.send("first"));
			await collect(session.send("second"));
			expect(backend.prompts[0]).toBe(
				"<mcp_servers>\nFirst lines of the instructions of MCP servers that connected:\n- plain: Plain tools for testing.\n</mcp_servers>\n\nfirst",
			);
			expect(backend.prompts[1]).toBe("second");
		} finally {
			await session.close();
		}
	});

	it("never gives MCP tools to a subagent, even when its definition names them", async () => {
		const agent: SubagentDefinition = {
			name: "worker",
			description: "Changes code",
			tools: ["mcp_search", "mcp_call"],
			prompt: "WORKER",
			models: {},
			maxRequests: 5,
		};
		const children: FakeBackend[] = [];
		const backend = new FakeBackend([[call("task", { agent: "worker", prompt: "do it" }), { event: finished }]]);
		const session = await Session.start({
			backend,
			cwd: dir,
			tools: [],
			mcp: mcp([server("fixture")]),
			subagents: {
				agents: [agent],
				createBackend: () => {
					const child = new FakeBackend([[{ event: finished }]]);
					children.push(child);
					return child;
				},
			},
		});
		try {
			await collect(session.send("delegate"));
			expect(children[0]?.startOptions?.tools).toEqual([]);
			expect(children[0]?.startOptions?.systemPromptAppend).not.toContain("mcp_search");
		} finally {
			await session.close();
		}
	});

	it("closes its servers when the session closes", async () => {
		const manager = mcp([server("fixture")]);
		const session = await Session.start({ backend: new FakeBackend([]), cwd: dir, tools: [], mcp: manager });
		await manager.ready();
		await session.close();
		await expect(manager.call("fixture", "echo", { text: "x" })).rejects.toThrow("not connected");
	});
});
