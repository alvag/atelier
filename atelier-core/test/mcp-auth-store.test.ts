import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HttpServerConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { McpAuthStore } from "../src/mcp/oauth.ts";

/** When set, chmodSync fails as it does on a file of another user or a read-only mount. */
const chmodFails = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
			if (chmodFails.on) throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
			return actual.chmodSync(...args);
		},
	};
});

let dir: string;
const server: HttpServerConfig = {
	name: "remote",
	transport: "http",
	url: "https://example.invalid/mcp",
	headers: {},
	enabled: false,
	timeoutMs: 100,
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "atelier-mcp-auth-store-"));
	chmodFails.on = false;
});

afterEach(async () => {
	chmodFails.on = false;
	await rm(dir, { recursive: true, force: true });
});

it("keeps the credentials it read when the file cannot be set to 0600, and says so", async () => {
	const file = join(dir, "mcp-auth.json");
	const store = new McpAuthStore(file);
	store.update(server, () => ({ tokens: { access_token: "kept-token-123", token_type: "Bearer" } }));
	await chmod(file, 0o644);
	chmodFails.on = true;
	expect(store.get(server)?.tokens?.access_token).toBe("kept-token-123");
	expect((await stat(file)).mode & 0o777).toBe(0o644);
	expect(store.problem()).toBe(
		`${file} is not 0600 (it is 0644) and could not be set to it: EPERM: operation not permitted, chmod`,
	);
	const manager = new McpManager({ file: "mcp.json", servers: [server], problems: [], secrets: [] }, { auth: store });
	expect(manager.problems()).toEqual([store.problem()]);
	await manager.close();
});

it("says nothing once the file is 0600", async () => {
	const file = join(dir, "mcp-auth.json");
	const store = new McpAuthStore(file);
	store.update(server, () => ({ tokens: { access_token: "kept-token-123", token_type: "Bearer" } }));
	await chmod(file, 0o644);
	store.get(server);
	expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect(store.problem()).toBeUndefined();
});
