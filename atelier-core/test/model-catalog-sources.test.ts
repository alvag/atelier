import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	anthropicModelsSource,
	catalogFile,
	claudeCodeModelsSource,
	codexModelsSource,
	modelDataOf,
	modelsDevSource,
	openCodeGoModelsSource,
	readCatalog,
	refreshCatalog,
} from "../src/model-catalog/index.ts";

let home: string;
let file: string;
let server: Server;
let base: string;
let routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void>;
const seen: IncomingMessage[] = [];

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-model-sources-"));
	file = catalogFile(home);
	seen.length = 0;
	routes = {};
	server = createServer((request, response) => {
		seen.push(request);
		const route = routes[new URL(request.url ?? "/", "http://x").pathname];
		if (route) route(request, response);
		else {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
});

const json = (body: unknown) => (_request: IncomingMessage, response: ServerResponse) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
};

const supported = (value: boolean) => ({ supported: value });
const anthropicModel = (id: string, window: number | null, efforts: string[], off?: string) => ({
	id,
	type: "model",
	max_input_tokens: window,
	capabilities: {
		effort: Object.fromEntries([["supported", efforts.length > 0], ...efforts.map((e) => [e, supported(true)])]),
		thinking: {
			supported: true,
			types: {
				adaptive: supported(true),
				disabled: supported(off === "disabled"),
				between_tools: supported(off === "between_tools"),
			},
		},
	},
});

it("lists Anthropic's models with the key, page by page, over what models.dev says of them", async () => {
	routes["/api.json"] = json({
		anthropic: {
			models: {
				"claude-new-6": {
					id: "claude-new-6",
					limit: { context: 1_000_000 },
					cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
					reasoning_options: [{ type: "effort", values: ["low"] }],
				},
			},
		},
	});
	routes["/v1/models"] = (request, response) => {
		const after = new URL(request.url ?? "", "http://x").searchParams.get("after_id");
		json(
			after === null
				? { data: [anthropicModel("claude-new-6", 900_000, ["low", "high"], "disabled")], has_more: true, last_id: "a" }
				: { data: [anthropicModel("claude-old-3", null, [], "between_tools")], has_more: false, last_id: "b" },
		)(request, response);
	};
	const outcomes = await refreshCatalog(file, [
		modelsDevSource({ url: `${base}/api.json` }),
		anthropicModelsSource({ apiKey: async () => "sk-ant-fake", baseUrl: base }),
	]);
	expect(outcomes).toEqual({ "models.dev": "changed", "anthropic-api": "changed" });

	const listing = seen.filter((request) => request.url?.startsWith("/v1/models"));
	expect(listing.map((request) => request.headers["x-api-key"])).toEqual(["sk-ant-fake", "sk-ant-fake"]);
	expect(listing[0]?.headers["anthropic-version"]).toBe("2023-06-01");
	expect(listing[1]?.url).toContain("after_id=a");

	const data = modelDataOf(await readCatalog(file));
	expect(data.listed("anthropic-api")).toEqual(["claude-new-6", "claude-old-3"]);
	// What the provider says wins; what it does not say comes from models.dev.
	expect(data.model("anthropic-api", "claude-new-6")).toEqual({
		id: "claude-new-6",
		contextWindow: 900_000,
		prices: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
		efforts: ["low", "high"],
		off: "disabled",
	});
	expect(data.model("anthropic-api", "claude-old-3")).toEqual({ id: "claude-old-3", off: "between_tools" });
});

it("does not ask Anthropic without a key, and lists nothing for it", async () => {
	routes["/v1/models"] = json({ data: [], has_more: false });
	expect(await refreshCatalog(file, [anthropicModelsSource({ apiKey: async () => undefined, baseUrl: base })])).toEqual(
		{
			"anthropic-api": "failed",
		},
	);
	expect(seen).toHaveLength(0);
	expect(modelDataOf(await readCatalog(file)).listed("anthropic-api")).toBeUndefined();
});

it("does not ask OpenCode Go when it has no key", async () => {
	routes["/go/v1/models"] = json({ data: [{ id: "grok-4.7" }] });
	const source = { ...openCodeGoModelsSource({ baseUrl: `${base}/go` }), available: async () => false };
	expect(await refreshCatalog(file, [source])).toEqual({ "opencode-go": "skipped" });
	expect(seen).toHaveLength(0);
});

it("lists OpenCode Go's models without its key", async () => {
	routes["/go/v1/models"] = json({ object: "list", data: [{ id: "grok-4.7" }, { id: "minimax-m3" }, { id: 3 }] });
	await refreshCatalog(file, [openCodeGoModelsSource({ baseUrl: `${base}/go` })]);
	expect(seen[0]?.headers.authorization).toBeUndefined();
	const data = modelDataOf(await readCatalog(file));
	expect(data.listed("opencode-go")).toEqual(["grok-4.7", "minimax-m3"]);
	expect(data.model("opencode-go", "grok-4.7")).toEqual({ id: "grok-4.7" });
});

it("lists the Codex models the account's picker shows, in its order, with their windows and levels", async () => {
	const level = (effort: string) => ({ effort, description: effort });
	routes["/backend-api/codex/models"] = json({
		models: [
			{ slug: "gpt-6-luna", visibility: "list", priority: 4, context_window: 272_000, supported_reasoning_levels: [] },
			{
				slug: "gpt-6.1-terra",
				visibility: "list",
				priority: 1,
				context_window: 400_000,
				supported_reasoning_levels: ["low", "high", "ultra"].map(level),
			},
			{ slug: "codex-auto-review", visibility: "hide", priority: 0, context_window: 272_000 },
		],
	});
	await refreshCatalog(file, [
		codexModelsSource({ headers: async () => ({ authorization: "Bearer fake" }), baseUrl: `${base}/backend-api` }),
	]);
	expect(seen[0]?.headers.authorization).toBe("Bearer fake");
	expect(new URL(seen[0]?.url ?? "", "http://x").searchParams.get("client_version")).toMatch(/^\d+\.\d+\.\d+$/);
	const data = modelDataOf(await readCatalog(file));
	expect(data.listed("openai-codex")).toEqual(["gpt-6.1-terra", "gpt-6-luna"]);
	expect(data.model("openai-codex", "gpt-6.1-terra")).toEqual({
		id: "gpt-6.1-terra",
		contextWindow: 400_000,
		efforts: ["low", "high"],
	});
});

it("lists the models Claude Code offers the subscription, aliases included, with their levels", async () => {
	const models = async () => [
		{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "" },
		{ value: "claude-fable-5-1", displayName: "Fable", description: "", supportedEffortLevels: ["low", "max"] },
		{ value: "", displayName: "", description: "" },
	];
	await refreshCatalog(file, [claudeCodeModelsSource(models)]);
	const data = modelDataOf(await readCatalog(file));
	expect(data.listed("claude-code")).toEqual(["opus", "claude-fable-5-1"]);
	expect(data.model("claude-code", "claude-fable-5-1")).toEqual({ id: "claude-fable-5-1", efforts: ["low", "max"] });
	expect(data.model("claude-code", "opus")).toEqual({ id: "opus" });
});

it("gives up on a source that hangs before its request, without holding up the others", async () => {
	routes["/go/v1/models"] = json({ data: [{ id: "grok-4.7" }] });
	const never = () => new Promise<never>(() => {});
	const outcomes = await refreshCatalog(
		file,
		[
			claudeCodeModelsSource(never),
			codexModelsSource({ headers: never, baseUrl: `${base}/backend-api` }),
			anthropicModelsSource({ apiKey: never, baseUrl: base }),
			openCodeGoModelsSource({ baseUrl: `${base}/go` }),
		],
		{ timeoutMs: 100 },
	);
	expect(outcomes).toEqual({
		"claude-code": "failed",
		"openai-codex": "failed",
		"anthropic-api": "failed",
		"opencode-go": "changed",
	});
	expect(modelDataOf(await readCatalog(file)).listed("opencode-go")).toEqual(["grok-4.7"]);
});

it("keeps the last list when a provider fails, and each source apart from the others", async () => {
	routes["/go/v1/models"] = json({ data: [{ id: "grok-4.7" }] });
	await refreshCatalog(file, [openCodeGoModelsSource({ baseUrl: `${base}/go` })], { now: 1_000 });
	routes["/go/v1/models"] = json({ error: "not a list" });
	const outcomes = await refreshCatalog(
		file,
		[
			openCodeGoModelsSource({ baseUrl: `${base}/go` }),
			codexModelsSource({ headers: async () => undefined, baseUrl: `${base}/backend-api` }),
		],
		{ now: 2_000, force: true },
	);
	expect(outcomes).toEqual({ "opencode-go": "failed", "openai-codex": "failed" });
	expect(modelDataOf(await readCatalog(file)).listed("opencode-go")).toEqual(["grok-4.7"]);
});
