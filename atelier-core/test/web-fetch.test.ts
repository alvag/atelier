import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { createWebFetchTool, MAX_PAGE_CHARS } from "../src/tools/web-fetch.ts";

const cwd = tmpdir();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let handler: Handler;
let seen: string[];
let base: string;

beforeEach(async () => {
	seen = [];
	handler = (_request, response) => response.writeHead(404).end();
	server = createServer((request, response) => {
		seen.push(request.url ?? "");
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

const reply =
	(type: string, body: string | Buffer, status = 200): Handler =>
	(_request, response) =>
		response.writeHead(status, { "content-type": type }).end(body);

/** The tool as a test uses it: loopback is open because the pages come from the local server. */
const local = (options: Parameters<typeof createWebFetchTool>[0] = {}) =>
	createWebFetchTool({ allowLoopback: true, ...options });

const fetchPage = (tool: ReturnType<typeof createWebFetchTool>, url: string, offset?: number): Promise<ToolOutcome> =>
	tool.execute({ url, ...(offset === undefined ? {} : { offset }) }, { cwd });

describe("web_fetch content (S2)", () => {
	it("converts HTML to readable Markdown, without scripts, navigation or tags", async () => {
		const paragraph = "This is a long paragraph about tides and the moon that a reader would care about. ".repeat(6);
		handler = reply(
			"text/html; charset=utf-8",
			`<html><head><title>Tides</title><script>var secret = 1;</script></head><body>
			<nav><a href="/home">Home menu</a></nav>
			<article><h1>Tides explained</h1><p>${paragraph} <strong>Bold claim</strong> and <a href="https://example.com/more">a link</a>.</p>
			<h2>Second part</h2><p>${paragraph}</p></article></body></html>`,
		);
		const out = await fetchPage(local(), `${base}/page`);
		expect(out.ok).toBe(true);
		expect(out.output).toContain("# Tides explained");
		expect(out.output).toContain("## Second part");
		expect(out.output).toContain("**Bold claim**");
		expect(out.output).toContain("[a link](https://example.com/more)");
		expect(out.output).not.toContain("var secret");
		expect(out.output).not.toContain("<p>");
	});

	it.each([
		["text/plain", "plain words\nsecond line"],
		["text/markdown", "# Title\n\n- item"],
		["application/json", '{"a": [1, 2], "b": "x"}'],
	])("returns %s as it is", async (type, body) => {
		handler = reply(type, body);
		const out = await fetchPage(local(), `${base}/doc`);
		expect(out).toMatchObject({ ok: true, output: body });
	});

	it("rejects other types, naming the type", async () => {
		handler = reply("application/pdf", Buffer.from("%PDF-1.4"));
		const out = await fetchPage(local(), `${base}/doc.pdf`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("application/pdf");
		handler = reply("image/png", Buffer.from([137, 80, 78, 71]));
		expect((await fetchPage(local(), `${base}/a.png`)).output).toContain("image/png");
	});

	it("rejects a URL that is not http or https without a request", async () => {
		const out = await fetchPage(local(), "file:///etc/passwd");
		expect(out.ok).toBe(false);
		expect(out.output).toContain("http");
		expect(seen).toEqual([]);
	});

	it("reports an error status as a failed result", async () => {
		handler = reply("text/plain", "gone", 410);
		const out = await fetchPage(local(), `${base}/old`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("410");
	});
});

const nextOffset = (out: ToolOutcome) =>
	Number(/Call web_fetch again with offset (\d+) to continue/.exec(out.output)?.[1]);

describe("web_fetch pages (S2)", () => {
	const long = `${"a".repeat(MAX_PAGE_CHARS)}${"b".repeat(MAX_PAGE_CHARS)}${"c".repeat(100)}`;

	it("caps a response at 30,000 characters and says which offset follows", async () => {
		expect(MAX_PAGE_CHARS).toBe(30_000);
		handler = reply("text/plain", long);
		const out = await fetchPage(local(), `${base}/long`);
		expect(out.ok).toBe(true);
		expect(out.output.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
		expect(out.output.startsWith("a".repeat(29_000))).toBe(true);
		expect(out.output).not.toContain("bbb");
		expect(nextOffset(out)).toBeLessThan(MAX_PAGE_CHARS);
	});

	it("serves a later offset from the page already downloaded, without a second request", async () => {
		handler = reply("text/plain", long);
		const tool = local();
		await fetchPage(tool, `${base}/long`);
		const second = await fetchPage(tool, `${base}/long`, MAX_PAGE_CHARS);
		expect(seen).toEqual(["/long"]);
		expect(second.output.startsWith("b".repeat(29_000))).toBe(true);
		expect(nextOffset(second)).toBeGreaterThan(MAX_PAGE_CHARS);
		const third = await fetchPage(tool, `${base}/long`, 2 * MAX_PAGE_CHARS);
		expect(seen).toEqual(["/long"]);
		expect(third.output.startsWith("b".repeat(100))).toBe(false);
		expect(third.output.endsWith("c".repeat(100))).toBe(true);
		expect(third.output).not.toContain("offset");
	});

	it("downloads again when the cached page is older than an hour", async () => {
		handler = reply("text/plain", long);
		let now = 1_000;
		const tool = local({ now: () => now });
		await fetchPage(tool, `${base}/long`);
		now += 60 * 60 * 1000 + 1;
		await fetchPage(tool, `${base}/long`, MAX_PAGE_CHARS);
		expect(seen).toEqual(["/long", "/long"]);
	});

	it("downloads a page for an offset when it was never fetched in the session", async () => {
		handler = reply("text/plain", long);
		const out = await fetchPage(local(), `${base}/long`, MAX_PAGE_CHARS);
		expect(seen).toEqual(["/long"]);
		expect(out.output.startsWith("b".repeat(29_000))).toBe(true);
	});

	it("says so when the offset is past the end", async () => {
		handler = reply("text/plain", "short");
		const out = await fetchPage(local(), `${base}/short`, 500);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("5 characters");
	});
});

describe("web_fetch limits (S2)", () => {
	it("refuses a body over 5 MiB", async () => {
		handler = reply("text/plain", Buffer.alloc(5 * 1024 * 1024 + 1, "x"));
		const out = await fetchPage(local(), `${base}/big`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("5 MiB");
	});

	it("takes a body of exactly 5 MiB", async () => {
		handler = reply("text/plain", Buffer.alloc(5 * 1024 * 1024, "x"));
		const out = await fetchPage(local(), `${base}/edge`);
		expect(out.ok).toBe(true);
	});

	it("gives up when the server does not answer in time", async () => {
		handler = () => {};
		const out = await fetchPage(local({ timeoutMs: 50 }), `${base}/slow`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("timed out");
	});

	it("follows up to 5 redirects and no more", async () => {
		handler = (request, response) => {
			const hop = Number(request.url?.slice(1) ?? 0);
			if (hop < 5) response.writeHead(302, { location: `/${hop + 1}` }).end();
			else response.writeHead(200, { "content-type": "text/plain" }).end("arrived");
		};
		expect(await fetchPage(local(), `${base}/0`)).toMatchObject({ ok: true, output: "arrived" });
		seen.length = 0;
		const out = await fetchPage(local(), `${base}/-1`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("redirects");
		expect(seen).toHaveLength(6);
	});

	it("follows a relative redirect to the final page", async () => {
		handler = (request, response) => {
			if (request.url === "/start") response.writeHead(301, { location: "/end" }).end();
			else response.writeHead(200, { "content-type": "text/plain" }).end("end page");
		};
		expect((await fetchPage(local(), `${base}/start`)).output).toBe("end page");
	});
});

describe("web_fetch address guard (S2)", () => {
	const refused = [
		["IPv4 loopback", "http://127.0.0.1:9/"],
		["IPv4 loopback, other host part", "http://127.1.2.3/"],
		["decimal loopback", "http://2130706433/"],
		["10/8", "http://10.1.2.3/"],
		["172.16/12", "http://172.16.0.1/"],
		["172.31 edge", "http://172.31.255.255/"],
		["192.168/16", "http://192.168.1.1/"],
		["link-local metadata address", "http://169.254.169.254/latest/meta-data/"],
		["unspecified", "http://0.0.0.0/"],
		["IPv6 loopback", "http://[::1]/"],
		["IPv6 unique local", "http://[fd12:3456::1]/"],
		["IPv6 unique local fc00", "http://[fc00::1]/"],
		["IPv6 link-local", "http://[fe80::1]/"],
		["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
		["IPv4-mapped private", "http://[::ffff:10.0.0.1]/"],
	];

	it.each(refused)("refuses %s", async (_name, url) => {
		const out = await fetchPage(createWebFetchTool(), url);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("Refused");
	});

	it("refuses a hostname that resolves to a refused address, without a request", async () => {
		const port = new URL(base).port;
		for (const address of ["10.0.0.5", "192.168.0.9", "169.254.1.1", "::1", "fd00::5", "fe80::2"]) {
			const tool = createWebFetchTool({ resolve: async () => [address] });
			const out = await fetchPage(tool, `http://sneaky.example:${port}/`);
			expect(out.ok).toBe(false);
			expect(out.output).toContain("Refused");
		}
		expect(seen).toEqual([]);
	});

	it("refuses a hostname when any of its addresses is refused", async () => {
		const tool = createWebFetchTool({ resolve: async () => ["93.184.216.34", "10.0.0.5"] });
		const out = await fetchPage(tool, "http://mixed.example/");
		expect(out.output).toContain("Refused");
	});

	it("connects to a hostname through the address it resolved", async () => {
		handler = reply("text/plain", "by name");
		const tool = local({ resolve: async () => ["127.0.0.1"] });
		const out = await fetchPage(tool, `http://pages.example:${new URL(base).port}/named`);
		expect(out).toMatchObject({ ok: true, output: "by name" });
		expect(seen).toEqual(["/named"]);
	});

	it("refuses a redirect from an allowed host to a refused address, after the first request", async () => {
		handler = (_request, response) => response.writeHead(302, { location: "http://169.254.169.254/latest/" }).end();
		const out = await fetchPage(local(), `${base}/bounce`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("Refused");
		expect(out.output).toContain("169.254.169.254");
		expect(seen).toEqual(["/bounce"]);
	});

	it("refuses a redirect to a hostname that resolves to a private address", async () => {
		handler = (_request, response) => response.writeHead(302, { location: "http://inner.example/admin" }).end();
		const tool = local({ resolve: async (host) => (host === "inner.example" ? ["10.0.0.7"] : ["127.0.0.1"]) });
		const out = await fetchPage(tool, `${base}/bounce`);
		expect(out.ok).toBe(false);
		expect(out.output).toContain("Refused");
		expect(seen).toEqual(["/bounce"]);
	});

	it("does not open loopback unless the tool was built for tests", async () => {
		const out = await fetchPage(createWebFetchTool(), `${base}/x`);
		expect(out.ok).toBe(false);
		expect(seen).toEqual([]);
	});
});

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const call = (url: string, callId = "w1"): FakeStep => ({ toolCall: { tool: "web_fetch", input: { url }, callId } });

/** One turn calling web_fetch on a session whose only tool is a local web_fetch. */
async function ask(url: string, options: Partial<SessionOptions> & { answer?: boolean } = {}) {
	const { answer = true, ...rest } = options;
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[call(url), finished]]);
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
	const events = await collect(session.send("fetch it"));
	await session.close();
	return { questions, events, results: backend.toolResults };
}

describe("web_fetch permissions (S4)", () => {
	beforeEach(() => {
		handler = reply("text/plain", "page body");
	});

	it.each([
		["the default mode", {}],
		["normal", { permissionMode: "normal" }],
	] as const)("asks in %s with the tool and the command, then fetches", async (_name, options) => {
		const { questions, events, results } = await ask(`${base}/ok`, options);
		const command = `web_fetch ${base}/ok`;
		expect(questions).toEqual([{ callId: "w1", command, tool: "web_fetch" }]);
		expect(events.filter((event) => event.type === "approval_requested")).toEqual([
			expect.objectContaining({ callId: "w1", command, tool: "web_fetch" }),
		]);
		expect(results[0]).toEqual({ ok: true, output: "page body" });
		expect(seen).toEqual(["/ok"]);
	});

	it("does not ask in yolo", async () => {
		const { questions, events, results } = await ask(`${base}/ok`, { permissionMode: "yolo" });
		expect(questions).toEqual([]);
		expect(events.filter((event) => event.type === "approval_requested")).toEqual([]);
		expect(results[0]).toEqual({ ok: true, output: "page body" });
	});

	it("leaves the decision to the classifier in auto, which sees the tool and the command", async () => {
		const answer: FakeStep[] = [
			{ event: { type: "text_delta", text: JSON.stringify({ decision: "allow", reason: "the user asked for it" }) } },
			finished,
		];
		const classifier = new FakeBackend([answer]);
		const { questions, events, results } = await ask(`${base}/ok`, {
			permissionMode: "auto",
			permissionClassifier: { createBackend: () => classifier },
		});
		expect(questions).toEqual([]);
		expect(events.filter((event) => event.type === "permission_classified")).toEqual([
			expect.objectContaining({ callId: "w1", decision: "allow" }),
		]);
		expect(classifier.prompts.join("\n")).toContain("web_fetch");
		expect(classifier.prompts.join("\n")).toContain(`web_fetch ${base}/ok`);
		expect(results[0]).toEqual({ ok: true, output: "page body" });
	});

	it("answers a denial without any request to the server", async () => {
		const { questions, results, events } = await ask(`${base}/never`, { answer: false });
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
		const { results } = await ask(`${base}/never`, {
			permissionMode: "auto",
			permissionClassifier: { createBackend: () => new FakeBackend([answer]) },
		});
		expect(results[0]?.ok).toBe(false);
		expect(seen).toEqual([]);
	});
});

describe("web_fetch roles (S5)", () => {
	it("is a tool of the main agent", () => {
		expect(coreTools.map((tool) => tool.name)).toContain("web_fetch");
	});

	it("is in the worker and explorer lists and in no other built-in role", () => {
		const withIt = BUILTIN_AGENTS.filter((agent) => agent.tools.includes("web_fetch")).map((agent) => agent.name);
		expect(withIt.sort()).toEqual(["explorer", "worker"]);
	});

	it("is not among the tools of the review lenses", () => {
		expect(createTreeTools(cwd, "candidate").map((tool) => tool.name)).not.toContain("web_fetch");
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
		expect(names[1]).toContain("web_fetch");
	});
});

describe("independent web_fetch regressions", () => {
	it.each(["[::ffff:7f00:1]", "[0:0:0:0:0:0:0:1]", "[::]", "[fe80::1%25lo0]", "0x7f.1", "127.1", "0177.0.0.1"])(
		"S2: refuses alternate internal address %s before HTTP",
		async (host) => {
			const out = await fetchPage(createWebFetchTool(), `http://${host}:${new URL(base).port}/never`);
			expect(out.ok).toBe(false);
			expect(out.output).toMatch(/Refused:|Not a valid URL:/);
			expect(seen).toEqual([]);
		},
	);

	it("S2: includes pagination metadata inside the 30,000-character output cap", async () => {
		handler = reply("text/plain", "a".repeat(30_001));
		const out = await fetchPage(local(), `${base}/long`);
		expect(out.ok).toBe(true);
		expect(out.truncated).toBe(true);
		expect(out.output.length).toBeLessThanOrEqual(30_000);
		expect(out.output).toMatch(/offset [1-9][0-9]*/);
	});

	it.each([200, 302, 404])("S2: bounds chunked bodies for HTTP %s", async (status) => {
		handler = (request, response) => {
			if (request.url === "/end") {
				response.writeHead(200, { "content-type": "text/plain" }).end("final");
				return;
			}
			response.writeHead(status, { "content-type": "text/plain", ...(status === 302 ? { location: "/end" } : {}) });
			for (let i = 0; i < 81; i++) response.write(Buffer.alloc(65_536, "x"));
			response.end();
		};
		const out = await fetchPage(local(), `${base}/large`);
		expect(out.ok).toBe(false);
		expect(out.output).toBe("The response is over the 5 MiB limit.");
		expect(seen).toEqual(["/large"]);
	});

	it("S2: times out a body after headers have arrived", async () => {
		handler = (_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.write("first chunk, no end");
		};
		const out = await fetchPage(local({ timeoutMs: 60 }), `${base}/slow-body`);
		expect(out.ok).toBe(false);
		expect(out.output).toBe("The request timed out after 0s.");
	});

	it("S2: refuses a redirect to a non-HTTP scheme", async () => {
		handler = (_request, response) => response.writeHead(302, { location: "file:///etc/passwd" }).end();
		const out = await fetchPage(local(), `${base}/bounce`);
		expect(out.ok).toBe(false);
		expect(out.output).toBe("Only http and https URLs can be fetched, not file:");
		expect(seen).toEqual(["/bounce"]);
	});

	it("S2: pins DNS for the connection and rechecks on the next call", async () => {
		handler = reply("text/plain", "pinned");
		let lookups = 0;
		const tool = local({ resolve: async () => (++lookups === 1 ? ["127.0.0.1"] : ["10.0.0.1"]) });
		const url = `http://rebind.example:${new URL(base).port}/pinned`;
		expect((await fetchPage(tool, url)).output).toBe("pinned");
		expect(lookups).toBe(1);
		expect((await fetchPage(tool, url)).output).toBe(
			"Refused: 10.0.0.1 is a private, link-local or otherwise internal address.",
		);
		expect(seen).toEqual(["/pinned"]);
	});

	it("S2: evicts the oldest of 21 cached pages", async () => {
		handler = reply("text/plain", "cached");
		const tool = local();
		for (let i = 0; i < 21; i++) await fetchPage(tool, `${base}/${i}`);
		await fetchPage(tool, `${base}/1`, 1);
		expect(seen).toHaveLength(21);
		await fetchPage(tool, `${base}/0`, 1);
		expect(seen).toHaveLength(22);
	});

	it.each(["worker", "explorer"])("S4/S5: %s cannot inherit a yolo approval bypass", async (agent) => {
		handler = reply("text/plain", "never");
		const child = new FakeBackend([[call(`${base}/never`), finished]]);
		const questions: ApprovalRequest[] = [];
		const session = await Session.start({
			backend: new FakeBackend([
				[{ toolCall: { tool: "task", input: { agent, prompt: "fetch" }, callId: "task" } }, finished],
			]),
			cwd,
			tools: [local()],
			permissionMode: "yolo",
			approve: async (request) => {
				expect(seen).toEqual([]);
				questions.push(request);
				return false;
			},
			subagents: { agents: BUILTIN_AGENTS, createBackend: () => child },
		});
		try {
			await collect(session.send("fetch"));
		} finally {
			await session.close();
		}
		expect(questions).toEqual([{ callId: "w1", command: `web_fetch ${base}/never`, tool: "web_fetch" }]);
		expect(child.toolResults[0]?.ok).toBe(false);
		expect(seen).toEqual([]);
	});
});

describe("web_fetch paging", () => {
	it("rebuilds the page exactly from the offsets each page names, every page within the cap", async () => {
		const text = Array.from({ length: 70_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
		handler = reply("text/plain", text);
		const tool = local();
		let rebuilt = "";
		let offset = 0;
		for (let pages = 0; pages < 10; pages++) {
			const out = await fetchPage(tool, `${base}/paged`, offset || undefined);
			expect(out.ok).toBe(true);
			expect(out.output.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
			const next = out.output.match(
				/\n\n\[Showing characters \d+-\d+ of \d+\. Call web_fetch again with offset (\d+) to continue\.\]$/,
			);
			rebuilt += next ? out.output.slice(0, next.index) : out.output;
			if (!next) break;
			offset = Number(next[1]);
		}
		expect(rebuilt).toBe(text);
	});
});
