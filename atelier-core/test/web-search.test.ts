import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type ApprovalRequest,
	type AtelierEvent,
	BUILTIN_AGENTS,
	coreTools,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
	type ToolOutcome,
} from "../src/index.ts";
import { createTreeTools } from "../src/review/tree-tools.ts";
import { createWebSearchTool } from "../src/tools/web-search.ts";

const cwd = tmpdir();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

interface Seen {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let handler: Handler;
let seen: Seen[];
let endpoint: string;

beforeEach(async () => {
	seen = [];
	handler = (_request, response) => response.writeHead(500).end();
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let body: Seen["body"] = {};
			try {
				body = JSON.parse(text);
			} catch {
				// A request that is not JSON is recorded with an empty body.
			}
			seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
			handler(request, response);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

/** What Exa's `web_search_exa` puts in the text of its answer: one block per result. */
const block = (title: string, url: string, highlights: string) =>
	`Title: ${title}\nURL: ${url}\nPublished Date: 2026-01-02\nAuthor: someone\nHighlights:\n${highlights}\n\n---\n`;

const exaText = (...results: Array<[string, string, string]>) => results.map((r) => block(...r)).join("\n");

const rpc = (text: string) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });

/** The streamable HTTP server answers a tools/call as an SSE stream with one `message` event. */
const sse =
	(text: string): Handler =>
	(_request, response) =>
		response
			.writeHead(200, { "content-type": "text/event-stream" })
			.end(`event: message\ndata: ${JSON.stringify(rpc(text))}\n\n`);

const json =
	(text: string): Handler =>
	(_request, response) =>
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rpc(text)));

const local = (options: Parameters<typeof createWebSearchTool>[0] = {}) =>
	createWebSearchTool({ endpoint, ...options });

const search = (tool: ReturnType<typeof createWebSearchTool>, input: Record<string, unknown>): Promise<ToolOutcome> =>
	tool.execute(input, { cwd });

const three = exaText(
	["Tides", "https://example.com/tides", "Tides follow the moon."],
	["Moon", "https://example.com/moon", "The moon is far."],
	["Sun", "https://example.com/sun", "The sun is hot."],
);

describe("web_search results (S3)", () => {
	it("asks Exa's search tool with the query and returns title, URL and snippet of each result (SSE)", async () => {
		handler = sse(three);
		const out = await search(local(), { query: "why tides" });
		expect(out.ok).toBe(true);
		expect(out.output).toBe(
			[
				"1. Tides\n   https://example.com/tides\n   Tides follow the moon.",
				"2. Moon\n   https://example.com/moon\n   The moon is far.",
				"3. Sun\n   https://example.com/sun\n   The sun is hot.",
			].join("\n\n"),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.headers.accept).toBe("application/json, text/event-stream");
		expect(seen[0]?.body).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: "why tides" } },
		});
	});

	it("reads a plain JSON answer the same way", async () => {
		handler = json(three);
		const out = await search(local(), { query: "why tides" });
		expect(out.ok).toBe(true);
		expect(out.output).toContain("2. Moon\n   https://example.com/moon\n   The moon is far.");
	});

	it("reads results that carry Text instead of Highlights, collapsing whitespace and cutting long snippets", async () => {
		const long = "word ".repeat(400);
		handler = sse(`Title: Long\nURL: https://example.com/l\nText: first line\n\n${long}\n---\n`);
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(true);
		const snippet = out.output.split("\n")[2]?.trim() ?? "";
		expect(snippet.startsWith("first line word word")).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(500);
		expect(out.output).not.toContain("\n\n");
	});

	it("says there were no results when Exa returns text without any", async () => {
		handler = sse("No results found.");
		const out = await search(local(), { query: "zzzz" });
		expect(out).toMatchObject({ ok: true });
		expect(out.output).toContain("No results");
	});

	it("bounds the answer: long titles and URLs are cut", async () => {
		handler = sse(exaText(["T".repeat(5000), `https://example.com/${"u".repeat(5000)}`, "snippet"]));
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(true);
		expect(out.output.startsWith(`1. ${"T".repeat(10)}`)).toBe(true);
		expect(out.output.length).toBeLessThan(3000);
	});
});

describe("web_search numResults (S3)", () => {
	it("asks for 5 results by default", async () => {
		handler = sse(three);
		await search(local(), { query: "q" });
		expect(seen[0]?.body.params?.arguments?.numResults).toBe(5);
	});

	it.each([1, 7, 10])("passes %i through", async (n) => {
		handler = sse(three);
		await search(local(), { query: "q", numResults: n });
		expect(seen[0]?.body.params?.arguments?.numResults).toBe(n);
	});

	it.each([0, 11, -1, 2.5])("rejects %s as input, without a request", async (n) => {
		const out = await search(local(), { query: "q", numResults: n }).catch((error: Error) => error);
		expect(out).toBeInstanceOf(Error);
		expect(seen).toEqual([]);
	});

	it("declares the bounds in its input schema", () => {
		const schema = z.object(local().inputShape);
		expect(schema.safeParse({ query: "q", numResults: 1 }).success).toBe(true);
		expect(schema.safeParse({ query: "q", numResults: 10 }).success).toBe(true);
		expect(schema.safeParse({ query: "q", numResults: 0 }).success).toBe(false);
		expect(schema.safeParse({ query: "q", numResults: 11 }).success).toBe(false);
		expect(schema.safeParse({ query: "" }).success).toBe(false);
	});

	it("returns no more results than were asked for, even if Exa sends more", async () => {
		handler = sse(three);
		const out = await search(local(), { query: "q", numResults: 2 });
		expect(out.output).toContain("2. Moon");
		expect(out.output).not.toContain("3. Sun");
	});
});

describe("web_search failures (S3)", () => {
	it("answers the anonymous limit (429) as a result that says so and that keys come later", async () => {
		handler = (_request, response) => response.writeHead(429, { "content-type": "text/plain" }).end("Too many");
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toContain("429");
		expect(out.output).toContain("rate limit");
		expect(out.output).toMatch(/API keys .*later/i);
	});

	it("answers another error status as a failed result naming the status", async () => {
		handler = (_request, response) => response.writeHead(503).end("down");
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toContain("503");
		expect(out.output).not.toMatch(/API keys/i);
	});

	it("answers a network error as a failed result", async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
		const port = (closed.address() as AddressInfo).port;
		await new Promise((resolve) => closed.close(resolve));
		const out = await search(createWebSearchTool({ endpoint: `http://127.0.0.1:${port}/mcp` }), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toMatch(/^Web search failed: /);
	});

	it.each([
		["not JSON", (_q: IncomingMessage, r: ServerResponse) => r.writeHead(200).end("<html>oops</html>")],
		["an empty body", (_q: IncomingMessage, r: ServerResponse) => r.writeHead(200).end("")],
		[
			"an SSE stream without a result",
			(_q: IncomingMessage, r: ServerResponse) =>
				r.writeHead(200, { "content-type": "text/event-stream" }).end("event: ping\ndata: {}\n\n"),
		],
		[
			"a result without text",
			(_q: IncomingMessage, r: ServerResponse) => r.writeHead(200).end(JSON.stringify({ result: { content: [] } })),
		],
	] as const)("answers %s as a failed result", async (_name, serve) => {
		handler = serve;
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toMatch(/^Web search failed: /);
	});

	it("answers a JSON-RPC error with its message", async () => {
		handler = (_request, response) =>
			response
				.writeHead(200)
				.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad query" } }));
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toContain("bad query");
	});

	it("answers a tool error from Exa with its text", async () => {
		handler = (_request, response) =>
			response
				.writeHead(200)
				.end(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "Exa is unhappy" }] } }));
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toContain("Exa is unhappy");
	});

	it("gives up when the server does not answer in time", async () => {
		handler = () => {};
		const out = await search(local({ timeoutMs: 100 }), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toContain("timed out");
	});

	it("refuses an answer over 1 MiB instead of reading it all", async () => {
		handler = (_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${"x".repeat(2 * 1024 * 1024)}`);
			response.end();
		};
		const out = await search(local(), { query: "q" });
		expect(out.ok).toBe(false);
		expect(out.output).toContain("1 MiB");
	});

	it("stops when the turn is aborted", async () => {
		handler = () => {};
		const controller = new AbortController();
		const pending = local().execute({ query: "q" }, { cwd, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const out = await pending;
		expect(out.ok).toBe(false);
	});
});

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const call = (query: string, callId = "s1"): FakeStep => ({
	toolCall: { tool: "web_search", input: { query }, callId },
});

/** One turn calling web_search on a session whose only tool is a web_search against the local server. */
async function ask(query: string, options: Partial<SessionOptions> & { answer?: boolean } = {}) {
	const { answer = true, ...rest } = options;
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[call(query), finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [local()],
		approve: async (request) => {
			questions.push(request);
			return answer;
		},
		...rest,
	});
	const events = await collect(session.send("search it"));
	await session.close();
	return { questions, events, results: backend.toolResults };
}

describe("web_search permissions (S4)", () => {
	beforeEach(() => {
		handler = sse(three);
	});

	it.each([
		["the default mode", {}],
		["normal", { permissionMode: "normal" }],
	] as const)("asks in %s with the tool and the command, then searches", async (_name, options) => {
		const { questions, events, results } = await ask("why tides", options);
		expect(questions).toEqual([{ callId: "s1", command: "web_search why tides", tool: "web_search" }]);
		expect(events.filter((event) => event.type === "approval_requested")).toEqual([
			expect.objectContaining({ callId: "s1", command: "web_search why tides", tool: "web_search" }),
		]);
		expect(results[0]?.ok).toBe(true);
		expect(results[0]?.output).toContain("1. Tides");
		expect(seen).toHaveLength(1);
	});

	it("does not ask in yolo", async () => {
		const { questions, events, results } = await ask("why tides", { permissionMode: "yolo" });
		expect(questions).toEqual([]);
		expect(events.filter((event) => event.type === "approval_requested")).toEqual([]);
		expect(results[0]?.ok).toBe(true);
		expect(results[0]?.output).toContain("1. Tides");
		expect(seen).toHaveLength(1);
	});

	it("leaves the decision to the classifier in auto, which sees the tool and the command", async () => {
		const answer: FakeStep[] = [
			{ event: { type: "text_delta", text: JSON.stringify({ decision: "allow", reason: "the user asked for it" }) } },
			finished,
		];
		const classifier = new FakeBackend([answer]);
		const { questions, events, results } = await ask("why tides", {
			permissionMode: "auto",
			permissionClassifier: { createBackend: () => classifier },
		});
		expect(questions).toEqual([]);
		expect(events.filter((event) => event.type === "permission_classified")).toEqual([
			expect.objectContaining({ callId: "s1", decision: "allow" }),
		]);
		expect(classifier.prompts.join("\n")).toContain("web_search why tides");
		expect(results[0]?.ok).toBe(true);
	});

	it("answers a denial without any request to the server", async () => {
		const { questions, results, events } = await ask("secret", { answer: false });
		expect(questions).toHaveLength(1);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.output).toContain("denied");
		expect(seen).toEqual([]);
		expect(events.find((event) => event.type === "tool_call_finished")).toMatchObject({ ok: false });
	});

	it("answers a classifier denial without any request to the server", async () => {
		const answer: FakeStep[] = [
			{ event: { type: "text_delta", text: JSON.stringify({ decision: "deny", reason: "not asked for" }) } },
			finished,
		];
		const { results } = await ask("secret", {
			permissionMode: "auto",
			permissionClassifier: { createBackend: () => new FakeBackend([answer]) },
		});
		expect(results[0]?.ok).toBe(false);
		expect(seen).toEqual([]);
	});
});

describe("web_search roles (S5)", () => {
	it("is a tool of the main agent, after web_fetch", () => {
		const names = coreTools.map((tool) => tool.name);
		expect(names.indexOf("web_search")).toBe(names.indexOf("web_fetch") + 1);
	});

	it("is in the worker and explorer lists and in no other built-in role", () => {
		const withIt = BUILTIN_AGENTS.filter((agent) => agent.tools.includes("web_search")).map((agent) => agent.name);
		expect(withIt.sort()).toEqual(["explorer", "worker"]);
	});

	it("is not among the tools of the review lenses", () => {
		expect(createTreeTools(cwd, "candidate").map((tool) => tool.name)).not.toContain("web_search");
	});

	it("reaches an explorer and a worker session through the task tool", async () => {
		const children: FakeBackend[] = [];
		const parent = new FakeBackend([
			[
				{ toolCall: { tool: "task", input: { agent: "explorer", prompt: "look" }, callId: "t1" } },
				{ toolCall: { tool: "task", input: { agent: "worker", prompt: "do" }, callId: "t2" } },
				finished,
			],
		]);
		const session = await Session.start({
			backend: parent,
			cwd,
			tools: coreTools,
			permissionMode: "yolo",
			subagents: {
				agents: BUILTIN_AGENTS,
				createBackend: () => {
					const child = new FakeBackend([[finished]]);
					children.push(child);
					return child;
				},
			},
		});
		await collect(session.send("go"));
		await session.close();
		const names = children.map((child) => child.startOptions?.tools.map((tool) => tool.name) ?? []);
		expect(names[0]).toEqual(["read", "grep", "web_fetch", "web_search"]);
		expect(names[1]).toContain("web_search");
	});
});
