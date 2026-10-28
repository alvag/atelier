import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	type PermissionMode,
	Session,
} from "../src/index.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { createMcpTools, MCP_CALL_TOOL } from "../src/mcp/tools.ts";
import { sweepStaleScratch } from "../src/scratch.ts";
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

	it("says the servers' state in the first turn, and again only in a turn where it changed", async () => {
		const backend = new FakeBackend([[{ event: finished }], [{ event: finished }], [{ event: finished }]]);
		const manager = new McpManager({
			file: join(dir, "mcp.json"),
			servers: [server("fixture"), server("off", { enabled: false })],
			problems: [{ name: "bad", message: "the entry must be an object" }, { message: "file problem" }],
			secrets: [],
		});
		const session = await Session.start({ backend, cwd: dir, tools: [], mcp: manager });
		try {
			const statuses = async (prompt: string) =>
				(await collect(session.send(prompt))).filter((event) => event.type === "mcp_status");
			const first = await statuses("one");
			expect(first).toEqual([
				expect.objectContaining({
					type: "mcp_status",
					servers: [
						{ name: "fixture", transport: "stdio", state: "connecting", tools: [] },
						{ name: "off", transport: "stdio", state: "disabled", tools: [] },
						{ name: "bad", state: "invalid", tools: [], error: "the entry must be an object" },
					],
					problems: ["file problem"],
				}),
			]);
			manager.start();
			await manager.ready();
			const second = await statuses("two");
			expect(second[0]).toMatchObject({
				servers: [{ name: "fixture", state: "connected", tools: expect.arrayContaining(["echo"]) }, {}, {}],
			});
			expect(await statuses("three")).toEqual([]);
			expect(session.mcpStatus()).toEqual({
				servers: second[0]?.type === "mcp_status" ? second[0].servers : [],
				problems: ["file problem"],
			});
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

	it("cuts a large text result in the middle and keeps the whole text in the session's scratch directory", async () => {
		const backend = new FakeBackend([[call("mcp_call", { server: "fixture", tool: "big" }), { event: finished }]]);
		const session = await Session.start({
			backend,
			cwd: dir,
			tools: [],
			mcp: mcp([server("fixture", {}, { MCP_BIG_CHARS: "50000" })]),
		});
		try {
			const events = await collect(session.send("big"));
			const output = backend.toolResults[0]?.output ?? "";
			expect(output.length).toBeLessThan(21_000);
			expect(output.startsWith("start-x")).toBe(true);
			expect(output).toContain("chars truncated…");
			expect(output.trimEnd().endsWith("-end") || output.includes("x-end")).toBe(true);
			const finishedCall = events.find((event) => event.type === "tool_call_finished");
			expect(finishedCall).toMatchObject({
				truncated: true,
				fullOutputPath: expect.stringContaining("atelier-session-"),
			});
			const path = finishedCall?.type === "tool_call_finished" ? finishedCall.fullOutputPath : undefined;
			expect(output).toContain(`The full result is in ${path}`);
			expect(await readFile(path ?? "", "utf8")).toBe(`start-${"x".repeat(50_000)}-end`);
		} finally {
			await session.close();
		}
	});

	it("saves a long result and an image without a scratch directory each in one of its own, which a sweep deletes once its process is dead", async () => {
		const manager = mcp([server("fixture", {}, { MCP_BIG_CHARS: "50000" })]);
		const mcpCall = createMcpTools(manager).find((tool) => tool.name === MCP_CALL_TOOL);
		const previous = process.env.TMPDIR;
		const root = join(dir, "tmp");
		await mkdir(root);
		process.env.TMPDIR = root;
		try {
			const big = await mcpCall?.execute({ server: "fixture", tool: "big" }, { cwd: dir });
			const image = await mcpCall?.execute({ server: "fixture", tool: "image" }, { cwd: dir });
			const bigPath = big?.fullOutputPath ?? "";
			const imagePath = /saved to (\S+\.png)\]/.exec(image?.output ?? "")?.[1] ?? "";
			expect(await readFile(bigPath, "utf8")).toBe(`start-${"x".repeat(50_000)}-end`);
			expect(await readFile(imagePath, "utf8")).toBe("png-bytes");
			for (const path of [bigPath, imagePath]) expect((await readdir(join(path, ".."))).length).toBe(1);
			expect((await readdir(root)).every((name) => name.startsWith("atelier-mcp-"))).toBe(true);

			const dead = { isAlive: () => false, startedAt: async () => undefined };
			expect(await sweepStaleScratch({ tmpRoot: root, processes: dead })).toHaveLength(2);
			expect(await readdir(root)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			await manager.close();
		}
	});

	it("saves an image to the scratch directory and tells the model where", async () => {
		const backend = new FakeBackend([[call("mcp_call", { server: "fixture", tool: "image" }), { event: finished }]]);
		const session = await Session.start({ backend, cwd: dir, tools: [], mcp: mcp([server("fixture")]) });
		try {
			await collect(session.send("image"));
			const output = backend.toolResults[0]?.output ?? "";
			const path = /saved to (\S+\.png)\]/.exec(output)?.[1];
			expect(output).toMatch(/^\[image image\/png, 9 bytes, saved to .+\]$/);
			expect(await readFile(path ?? "", "utf8")).toBe("png-bytes");
		} finally {
			await session.close();
		}
	});
});

describe("MCP approval", () => {
	const usage2 = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 };
	const reply = (decision: "allow" | "deny"): FakeStep[] => [
		{ event: { type: "text_delta", text: JSON.stringify({ decision, reason: `because ${decision}` }) } },
		{ event: { type: "turn_finished", stopReason: "end_turn", usage: usage2 } },
	];

	async function run(mode: PermissionMode, classifierScript?: FakeStep[] | Error) {
		const questions: ApprovalRequest[] = [];
		const classifierBackends: FakeBackend[] = [];
		const backend = new FakeBackend([
			[call("mcp_call", { server: "fixture", tool: "echo", arguments: { text: "hola" } }), { event: finished }],
		]);
		const session = await Session.start({
			backend,
			cwd: dir,
			tools: [],
			permissionMode: mode,
			mcp: mcp([server("fixture")]),
			approve: async (request) => {
				questions.push(request);
				return true;
			},
			permissionClassifier: {
				createBackend: () => {
					if (classifierScript instanceof Error) throw classifierScript;
					const made = new FakeBackend([classifierScript ?? []]);
					classifierBackends.push(made);
					return made;
				},
			},
		});
		try {
			const events = await collect(session.send("say hola with the fixture"));
			return { events, questions, result: backend.toolResults[0], classifierBackends };
		} finally {
			await session.close();
		}
	}

	it.each(["normal", "yolo"] as const)("runs MCP calls without asking in %s", async (mode) => {
		const { questions, result, classifierBackends } = await run(mode);
		expect(questions).toEqual([]);
		expect(classifierBackends).toEqual([]);
		expect(result).toEqual({ ok: true, output: "echo: hola" });
	});

	it("asks the classifier in auto, with the tool's description and schema", async () => {
		const { questions, result, classifierBackends } = await run("auto", reply("allow"));
		expect(questions).toEqual([]);
		expect(result).toEqual({ ok: true, output: "echo: hola" });
		const asked = classifierBackends[0]?.prompts[0] ?? "";
		expect(asked).toContain("Echo the text back");
		expect(asked).toContain('"text":{"type":"string"}');
		expect(asked).toContain('fixture › echo {"text":"hola"}');
	});

	it("refuses the call when the classifier denies it in auto", async () => {
		const { questions, result } = await run("auto", reply("deny"));
		expect(questions).toEqual([]);
		expect(result?.ok).toBe(false);
		expect(result?.output).toContain("Denied by the permission classifier");
	});

	it("asks the user when the classifier cannot decide in auto", async () => {
		const { questions, result } = await run("auto", new Error("no classifier"));
		expect(questions).toEqual([{ callId: "c1", command: 'fixture › echo {"text":"hola"}', tool: "mcp_call" }]);
		expect(result?.ok).toBe(true);
	});
});
