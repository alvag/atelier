import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	type CatalogSource,
	catalogFile,
	DynamicModelCatalog,
	ModelData,
	readCatalog,
	useModelData,
} from "../src/model-catalog/index.ts";
import { BACKEND_MODELS } from "../src/options.ts";
import { costOfRequest } from "../src/pricing.ts";

let home: string;
let file: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-model-dynamic-"));
	file = catalogFile(home);
});

afterEach(async () => {
	useModelData(new ModelData());
	await rm(home, { recursive: true, force: true });
});

const anthropic = (ids: string[], asked: string[] = []): CatalogSource => ({
	name: "anthropic-api",
	async fetch() {
		asked.push("anthropic-api");
		return { kind: "changed", models: { "anthropic-api": ids.map((id) => ({ id })) } };
	},
});
const modelsDev: CatalogSource = {
	name: "models.dev",
	async fetch() {
		return {
			kind: "changed",
			models: {
				"anthropic-api": [{ id: "claude-new-6", prices: [{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] }],
			},
		};
	},
};
const hanging: CatalogSource = { name: "openai-codex", fetch: () => new Promise(() => {}) };
const USAGE = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

it("offers the code's lists until a provider lists more, then adds its models after them", async () => {
	const catalog = new DynamicModelCatalog({
		file,
		sources: [modelsDev, anthropic(["claude-new-6", "claude-sonnet-5-5"])],
	});
	expect(await catalog.models("anthropic-api")).toEqual(BACKEND_MODELS["anthropic-api"]);
	expect(costOfRequest("claude-new-6", USAGE)).toBeUndefined();

	expect(await catalog.refresh()).toEqual({ "models.dev": "changed", "anthropic-api": "changed" });
	expect(await catalog.models("anthropic-api")).toEqual([...BACKEND_MODELS["anthropic-api"], "claude-new-6"]);
	expect(await catalog.models("openai-codex")).toEqual(BACKEND_MODELS["openai-codex"]);
	// The backends price and size the new model from the same catalog.
	expect(costOfRequest("claude-new-6", USAGE)).toBe(3);

	// A new process reads the cache: no source is asked to offer what was listed.
	const asked: string[] = [];
	const next = new DynamicModelCatalog({ file, sources: [anthropic([], asked)] });
	expect(await next.models("anthropic-api")).toContain("claude-new-6");
	expect(asked).toEqual([]);
});

it("refreshes in the background: a source that hangs holds up neither the lists nor the other sources", async () => {
	const catalog = new DynamicModelCatalog({
		file,
		sources: [hanging, anthropic(["claude-new-6"])],
		refresh: { timeoutMs: 100 },
	});
	const done = catalog.start();
	expect(await catalog.models("anthropic-api")).toEqual(BACKEND_MODELS["anthropic-api"]);
	expect(await done).toEqual({ "openai-codex": "failed", "anthropic-api": "changed" });
	expect(await catalog.models("anthropic-api")).toContain("claude-new-6");
});

it("lists Claude Code's models from a session it is lent, unless the network is off", async () => {
	const list = async () => [{ value: "opus" }, { value: "claude-fable-5-1", supportedEffortLevels: ["low"] }];
	const offline = new DynamicModelCatalog({ file, sources: [], network: false });
	await offline.listClaudeCode(list);
	expect(await offline.models("claude-code")).toEqual(BACKEND_MODELS["claude-code"]);
	expect((await readCatalog(file)).sources).toEqual({});

	const catalog = new DynamicModelCatalog({ file, sources: [] });
	await catalog.listClaudeCode(list);
	expect(await catalog.models("claude-code")).toEqual([...BACKEND_MODELS["claude-code"], "claude-fable-5-1"]);
	// Within the interval the next session's list is not asked for.
	let asked = 0;
	await catalog.listClaudeCode(async () => {
		asked++;
		return [];
	});
	expect(asked).toBe(0);
});

it("does not ask the network when it is off, and still offers what the cache holds", async () => {
	await new DynamicModelCatalog({ file, sources: [anthropic(["claude-new-6"])] }).refresh();
	const asked: string[] = [];
	const offline = new DynamicModelCatalog({ file, sources: [anthropic(["other"], asked)], network: false });
	expect(await offline.start()).toEqual({});
	expect(asked).toEqual([]);
	expect(await offline.models("anthropic-api")).toContain("claude-new-6");
});
