import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	catalogFile,
	ModelData,
	modelDataOf,
	modelsDevSource,
	readCatalog,
	refreshSource,
} from "../src/model-catalog/index.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let home: string;
let file: string;
let server: Server;
let base: string;
let handler: Handler;
const seen: IncomingMessage[] = [];

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-model-catalog-"));
	file = catalogFile(home);
	seen.length = 0;
	server = createServer((request, response) => {
		seen.push(request);
		handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
});

/** A slice of models.dev's api.json: two providers Atelier reads and one it does not. */
const MODELS_DEV = {
	anthropic: {
		id: "anthropic",
		models: {
			"claude-new-6": {
				id: "claude-new-6",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
				limit: { context: 1_000_000, output: 128_000 },
				cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
			},
			broken: { id: 7, limit: { context: -1 } },
		},
	},
	"opencode-go": {
		id: "opencode-go",
		models: {
			"grok-4.7": {
				id: "grok-4.7",
				reasoning_options: [{ type: "effort", values: ["none", "minimal", "low", "high"] }],
				limit: { context: 500_000 },
				cost: {
					input: 2,
					output: 6,
					cache_read: 0.5,
					tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: "context", size: 200_000 } }],
				},
			},
			"odd-tier": {
				id: "odd-tier",
				limit: { context: 0 },
				cost: { input: 1, output: 2, tiers: [{ input: 2, output: 4, tier: { type: "hour", size: 3 } }] },
			},
		},
	},
	openai: { id: "openai", models: { "gpt-6.1-terra": { id: "gpt-6.1-terra", limit: { context: 1_050_000 } } } },
};

const json =
	(body: unknown, headers: Record<string, string> = {}, status = 200): Handler =>
	(_request, response) => {
		response.writeHead(status, { "content-type": "application/json", ...headers });
		response.end(typeof body === "string" ? body : JSON.stringify(body));
	};

const source = () => modelsDevSource({ url: `${base}/api.json` });

it("reads no catalog when the file is missing or broken", async () => {
	expect(await readCatalog(file)).toEqual({ sources: {} });
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(file, "{not json");
	expect(await readCatalog(file)).toEqual({ sources: {} });
	expect(modelDataOf(await readCatalog(file)).model("anthropic-api", "claude-new-6")).toBeUndefined();
});

it("keeps what models.dev says of the providers' models in ~/.atelier/models.json, with its etag", async () => {
	handler = json(MODELS_DEV, { etag: '"v1"' });
	expect(await refreshSource(file, source(), { now: 1_000 })).toBe("changed");
	expect(file).toBe(join(home, ".atelier", "models.json"));

	const catalog = await readCatalog(file);
	expect(catalog.sources["models.dev"]).toMatchObject({ etag: '"v1"', checkedAt: 1_000 });
	const data = modelDataOf(catalog);
	expect(data.model("anthropic-api", "claude-new-6")).toEqual({
		id: "claude-new-6",
		contextWindow: 1_000_000,
		prices: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
		efforts: ["low", "medium", "high", "xhigh", "max"],
	});
	// `none` turns thinking off, as `disabled` stands for it; a level Atelier does not send is left out.
	expect(data.model("opencode-go", "grok-4.7")).toEqual({
		id: "grok-4.7",
		contextWindow: 500_000,
		prices: [
			{ upToPromptTokens: 200_000, input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
			{ input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
		],
		efforts: ["low", "high"],
		off: "disabled",
	});
	// A window that is not a size, or a tier that is not by prompt size, is not invented: it is left out.
	expect(data.model("opencode-go", "odd-tier")).toEqual({ id: "odd-tier" });
	expect(data.model("anthropic-api", "broken")).toBeUndefined();
	// Codex serves its own windows, not the API's: models.dev's OpenAI models are not read.
	expect(data.model("openai-codex", "gpt-6.1-terra")).toBeUndefined();
	expect(seen[0]?.headers.authorization).toBeUndefined();
});

it("asks again only after the interval or when forced, with the etag, and keeps the models on 304", async () => {
	handler = json(MODELS_DEV, { etag: '"v1"' });
	await refreshSource(file, source(), { now: 1_000, intervalMs: 500 });
	expect(await refreshSource(file, source(), { now: 1_400, intervalMs: 500 })).toBe("fresh");
	expect(seen).toHaveLength(1);

	handler = (_request, response) => {
		response.writeHead(304);
		response.end();
	};
	expect(await refreshSource(file, source(), { now: 1_400, intervalMs: 500, force: true })).toBe("unchanged");
	expect(seen[1]?.headers["if-none-match"]).toBe('"v1"');
	const catalog = await readCatalog(file);
	expect(catalog.sources["models.dev"]?.checkedAt).toBe(1_400);
	expect(modelDataOf(catalog).model("opencode-go", "grok-4.7")?.contextWindow).toBe(500_000);
});

it("keeps the cached models when the answer fails, is broken or never comes", async () => {
	handler = json(MODELS_DEV, { etag: '"v1"' });
	await refreshSource(file, source(), { now: 1_000 });

	for (const failing of [
		json({ error: "down" }, {}, 500),
		json("{not json"),
		json([1, 2, 3]),
		() => {
			// Never answers: the request times out.
		},
	]) {
		handler = failing;
		expect(await refreshSource(file, source(), { now: 2_000, force: true, timeoutMs: 100 })).toBe("failed");
		const catalog = await readCatalog(file);
		expect(catalog.sources["models.dev"]).toMatchObject({ etag: '"v1"', checkedAt: 1_000 });
		expect(modelDataOf(catalog).model("anthropic-api", "claude-new-6")?.contextWindow).toBe(1_000_000);
	}
});

it("asks again at the next refresh after a failure, not only after the interval", async () => {
	handler = json(MODELS_DEV, { etag: '"v1"' });
	await refreshSource(file, source(), { now: 1_000, intervalMs: 500 });
	handler = json({ error: "down" }, {}, 500);
	expect(await refreshSource(file, source(), { now: 1_600, intervalMs: 500 })).toBe("failed");
	handler = json(MODELS_DEV, { etag: '"v2"' });
	expect(await refreshSource(file, source(), { now: 1_700, intervalMs: 500 })).toBe("changed");
	expect((await readCatalog(file)).sources["models.dev"]).toMatchObject({ etag: '"v2"', checkedAt: 1_700 });
});

it("fails without a server and writes the file whole, leaving no temporary behind", async () => {
	const offline = modelsDevSource({ url: "http://127.0.0.1:1/api.json" });
	expect(await refreshSource(file, offline, { now: 1_000 })).toBe("failed");
	expect(modelDataOf(await readCatalog(file)).model("anthropic-api", "claude-new-6")).toBeUndefined();

	handler = json(MODELS_DEV, { etag: '"v1"' });
	await Promise.all([1, 2, 3, 4].map((n) => refreshSource(file, source(), { now: n, force: true })));
	expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
	expect(await readdir(join(home, ".atelier"))).toEqual(["models.json"]);
});

it("drops a source whose check time is not a date", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	// As written in the file: the first two numbers are out of a date's range.
	const entry = (checkedAt: string) => `{"checkedAt":${checkedAt},"models":{"opencode-go":[{"id":"grok-4.7"}]}}`;
	await writeFile(
		file,
		`{"version":1,"sources":{"opencode-go":${entry("9999999999999999")},"openai-codex":${entry("-1e20")},"models.dev":${entry("5")}}}`,
	);
	expect(Object.keys((await readCatalog(file)).sources)).toEqual(["models.dev"]);
});

it("drops the entries of a hand-edited file that are not models", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(
		file,
		JSON.stringify({
			version: 1,
			sources: {
				"models.dev": {
					checkedAt: 5,
					models: {
						"anthropic-api": [
							{ id: "ok", contextWindow: 1000, efforts: ["high", "ultra"], prices: [{ input: 1, output: 2 }] },
							{ id: "" },
							"text",
						],
					},
				},
				other: "x",
			},
		}),
	);
	const data = modelDataOf(await readCatalog(file));
	expect(data.model("anthropic-api", "ok")).toEqual({ id: "ok", contextWindow: 1000, efforts: ["high"] });
	expect(new ModelData().model("anthropic-api", "ok")).toBeUndefined();
});
