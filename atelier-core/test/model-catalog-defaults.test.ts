import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore, authFile } from "../src/auth-store.ts";
import type { SecurityRunner } from "../src/credentials.ts";
import { catalogFile, defaultCatalogSources, refreshCatalog } from "../src/model-catalog/index.ts";
import { fakeCodexAccess, fakeJwt, fakeRefresh } from "./support/fake-openai-auth.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

let home: string;
let file: string;
let server: Server;
let base: string;
const seen: IncomingMessage[] = [];
/** Each `security` call, as its arguments; the Keychain holds the key when `keychainHasKey`. */
let security: string[][];
let keychainHasKey: boolean;
const runSecurity: SecurityRunner = async (args) => {
	security.push([...args]);
	if (!keychainHasKey) return { code: 44, stdout: "", stderr: "not found" };
	return { code: 0, stdout: args.includes("-w") ? "sk-ant-keychain\n" : "", stderr: "" };
};

const answers: Record<string, unknown> = {
	"/api.json": { anthropic: { models: { "claude-new-6": { id: "claude-new-6", limit: { context: 1000 } } } } },
	"/v1/models": { data: [{ id: "claude-new-6" }], has_more: false },
	"/go/v1/models": { data: [{ id: "grok-4.7" }] },
	"/backend-api/codex/models": { models: [{ slug: "gpt-6.1-terra", visibility: "list", priority: 1 }] },
};

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-model-defaults-"));
	file = catalogFile(home);
	seen.length = 0;
	security = [];
	keychainHasKey = false;
	server = createServer((request: IncomingMessage, response: ServerResponse) => {
		seen.push(request);
		const body = answers[new URL(request.url ?? "/", "http://x").pathname];
		response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
		response.end(JSON.stringify(body ?? {}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
});

const sources = (env: Record<string, string> = {}, interactive = false) =>
	defaultCatalogSources({
		home,
		env,
		interactive,
		platform: "darwin",
		runSecurity,
		urls: {
			modelsDev: `${base}/api.json`,
			anthropic: base,
			openCodeGo: `${base}/go`,
			codex: `${base}/backend-api`,
		},
	});
const asked = (path: string) => seen.filter((request) => request.url?.startsWith(path));
const store = () => new AuthStore(authFile(home));

it("asks only models.dev when nothing is signed in, checking the Keychain only for whether it has a key", async () => {
	expect(await refreshCatalog(file, sources())).toEqual({
		"models.dev": "changed",
		"anthropic-api": "skipped",
		"opencode-go": "skipped",
		"openai-codex": "skipped",
	});
	expect(seen.map((request) => new URL(request.url ?? "", "http://x").pathname)).toEqual(["/api.json"]);
	expect(security.length).toBeGreaterThan(0);
	expect(security.some((args) => args.includes("-w"))).toBe(false);
});

it("never reads a Keychain key in the background, and reads it when the user asks for the refresh", async () => {
	keychainHasKey = true;
	expect((await refreshCatalog(file, sources()))["anthropic-api"]).toBe("skipped");
	expect(security.some((args) => args.includes("-w"))).toBe(false);
	expect(asked("/v1/models")).toHaveLength(0);

	expect((await refreshCatalog(file, sources({}, true), { force: true }))["anthropic-api"]).toBe("changed");
	expect(security.some((args) => args.includes("-w"))).toBe(true);
	expect(asked("/v1/models")[0]?.headers["x-api-key"]).toBe("sk-ant-keychain");
});

it("asks each signed-in provider with its own credential, and nothing while its answer is fresh", async () => {
	await store().set("anthropic", { type: "api_key", key: "sk-ant-stored" });
	await store().set("opencode-go", { type: "api_key", key: "oc-stored" });
	const accountId = `acct-${randomUUID()}`;
	const access = fakeCodexAccess(accountId);
	await store().set("openai-codex", {
		type: "oauth",
		access,
		refresh: fakeRefresh(),
		expires: Date.now() + 3_600_000,
		accountId,
	} as never);
	expect(await refreshCatalog(file, sources())).toEqual({
		"models.dev": "changed",
		"anthropic-api": "changed",
		"opencode-go": "changed",
		"openai-codex": "changed",
	});
	expect(asked("/v1/models")[0]?.headers["x-api-key"]).toBe("sk-ant-stored");
	expect(asked("/go/v1/models")[0]?.headers.authorization).toBeUndefined();
	expect(asked("/backend-api/codex/models")[0]?.headers.authorization).toBe(`Bearer ${access}`);
	expect(security).toEqual([]);

	seen.length = 0;
	const again = await refreshCatalog(file, sources());
	expect(Object.values(again)).toEqual(["fresh", "fresh", "fresh", "fresh"]);
	expect(seen).toHaveLength(0);
});

it("skips the Codex catalog with Sign in with ChatGPT alone, without touching its token", async () => {
	await store().set("openai-chatgpt", {
		type: "oauth",
		access: fakeJwt({ sub: randomUUID() }),
		refresh: fakeRefresh(),
		expires: Date.now() - 1000,
		clientId: "issued-1",
		scopes: [],
	} as never);
	expect((await refreshCatalog(file, sources()))["openai-codex"]).toBe("skipped");
	expect(asked("/backend-api")).toHaveLength(0);
});

it("reads no credential with ATELIER_LOGIN_CHECK=off: only models.dev, which takes none, is asked", async () => {
	keychainHasKey = true;
	await store().set("anthropic", { type: "api_key", key: "sk-ant-stored" });
	const off = sources({ ATELIER_LOGIN_CHECK: "off" }, true);
	expect(off.map((source) => source.name)).toEqual(["models.dev"]);
	expect(await refreshCatalog(file, off)).toEqual({ "models.dev": "changed" });
	expect(security).toEqual([]);
});
