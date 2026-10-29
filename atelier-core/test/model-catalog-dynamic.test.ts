import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	type CatalogSource,
	catalogFile,
	DynamicModelCatalog,
	ModelData,
	modelRefreshEnabled,
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
const PRICE = [{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }];

/** A cache that lists `id` for anthropic-api, priced. */
const listing = (id: string) => ({
	sources: { "anthropic-api": { checkedAt: Date.now(), models: { "anthropic-api": [{ id, prices: PRICE }] } } },
});

async function until(condition: () => boolean): Promise<void> {
	for (let tries = 0; !condition(); tries++) {
		if (tries > 200) throw new Error("condition not met");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

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

it("offers the code's lists when the cache cannot be read or makes no sense, and recovers at the next read", async () => {
	for (const read of [
		async () => {
			throw new Error("disk");
		},
		async () => ({ sources: { "models.dev": { checkedAt: 1, models: null } } }) as never,
		async () => ({ sources: { "anthropic-api": { checkedAt: 1, models: { "anthropic-api": "x" } } } }) as never,
	]) {
		const catalog = new DynamicModelCatalog({ file, sources: [], network: false, read });
		expect(await catalog.models("anthropic-api")).toEqual(BACKEND_MODELS["anthropic-api"]);
	}

	// The next read, once the cache makes sense again, offers what it holds.
	let broken = true;
	const catalog = new DynamicModelCatalog({
		file,
		sources: [],
		read: async () => {
			if (broken) throw new Error("disk");
			return listing("claude-new-6");
		},
	});
	expect(await catalog.models("anthropic-api")).toEqual(BACKEND_MODELS["anthropic-api"]);
	broken = false;
	await catalog.refresh();
	expect(await catalog.models("anthropic-api")).toContain("claude-new-6");
	expect(costOfRequest("claude-new-6", USAGE)).toBe(3);
});

it("keeps the newest read when two reads of the cache overlap and the older one ends last", async () => {
	const held: (() => void)[] = [];
	let reads = 0;
	const catalog = new DynamicModelCatalog({
		file,
		sources: [],
		read: async () => {
			reads++;
			if (reads === 1) return listing("claude-first-6");
			if (reads === 2) {
				// The older read: it ends after the newer one.
				await new Promise<void>((resolve) => held.push(resolve));
				return listing("claude-older-6");
			}
			return listing("claude-newer-7");
		},
	});
	expect(await catalog.models("anthropic-api")).toContain("claude-first-6");
	const older = catalog.refresh();
	await until(() => held.length === 1);
	await catalog.listClaudeCode(async () => []);
	expect(await catalog.models("anthropic-api")).toContain("claude-newer-7");
	held[0]?.();
	await older;
	const models = await catalog.models("anthropic-api");
	expect(models).toContain("claude-newer-7");
	expect(models).not.toContain("claude-older-6");
	// The backends see the same data as the lists.
	expect(costOfRequest("claude-newer-7", USAGE)).toBe(3);
	expect(costOfRequest("claude-older-6", USAGE)).toBeUndefined();
});

it("keeps offering the last lists while a new read of the cache is under way", async () => {
	await new DynamicModelCatalog({ file, sources: [anthropic(["claude-new-6"])] }).refresh();
	let release: () => void = () => {};
	let reads = 0;
	const catalog = new DynamicModelCatalog({
		file,
		sources: [anthropic(["claude-newer-7"])],
		refresh: { force: true },
		read: async (path) => {
			if (reads++ > 0) await new Promise<void>((resolve) => (release = resolve));
			return readCatalog(path);
		},
	});
	expect(await catalog.models("anthropic-api")).toContain("claude-new-6");
	const refreshed = catalog.refresh();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(reads).toBe(2);
	expect(await catalog.models("anthropic-api")).toContain("claude-new-6");
	release();
	await refreshed;
	expect(await catalog.models("anthropic-api")).toContain("claude-newer-7");
});

it("drops an odd entry of the cache file alone", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	const listed = { checkedAt: 1, models: { "anthropic-api": [{ id: "claude-new-6" }, { id: "__proto__" }, 7] } };
	await writeFile(
		file,
		`{"version":1,"sources":{"__proto__":{"checkedAt":1,"models":{}},"opencode-go":[],"anthropic-api":${JSON.stringify(listed)}}}`,
	);
	const catalog = new DynamicModelCatalog({ file, sources: [], network: false });
	expect(await catalog.models("anthropic-api")).toEqual([
		...BACKEND_MODELS["anthropic-api"],
		"claude-new-6",
		"__proto__",
	]);
	expect(await catalog.models("opencode-go")).toEqual(BACKEND_MODELS["opencode-go"]);
	expect(Object.getPrototypeOf((await readCatalog(file)).sources)).toBe(Object.prototype);
});

it("asks no source, at start or for Claude Code, offline (ATELIER_OFFLINE=1) or with ATELIER_MODEL_REFRESH=off", async () => {
	expect(modelRefreshEnabled({})).toBe(true);
	expect(modelRefreshEnabled({ ATELIER_OFFLINE: "0" })).toBe(true);
	expect(modelRefreshEnabled({ ATELIER_OFFLINE: "" })).toBe(true);
	for (const env of [{ ATELIER_OFFLINE: "1" }, { ATELIER_MODEL_REFRESH: "off" }]) {
		expect(modelRefreshEnabled(env)).toBe(false);
		const asked: string[] = [];
		const catalog = new DynamicModelCatalog({
			file,
			sources: [anthropic(["claude-new-6"], asked)],
			network: modelRefreshEnabled(env),
		});
		expect(await catalog.start()).toEqual({});
		expect(await catalog.refresh({ force: true })).toEqual({});
		let listed = 0;
		await catalog.listClaudeCode(async () => {
			listed++;
			return [];
		});
		expect({ asked, listed }).toEqual({ asked: [], listed: 0 });
	}
});

it("does not ask the network when it is off, and still offers what the cache holds", async () => {
	await new DynamicModelCatalog({ file, sources: [anthropic(["claude-new-6"])] }).refresh();
	const asked: string[] = [];
	const offline = new DynamicModelCatalog({ file, sources: [anthropic(["other"], asked)], network: false });
	expect(await offline.start()).toEqual({});
	expect(asked).toEqual([]);
	expect(await offline.models("anthropic-api")).toContain("claude-new-6");
});
