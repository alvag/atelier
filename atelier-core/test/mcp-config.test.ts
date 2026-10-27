import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig, mcpConfigFile, redact } from "../src/mcp/config.ts";

let home: string;
let cwd: string;

beforeEach(async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "atelier-mcp-config-")));
	home = join(base, "home");
	cwd = join(base, "project");
	await mkdir(join(home, ".atelier"), { recursive: true });
	await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	await rm(join(home, ".."), { recursive: true, force: true });
});

const write = (config: unknown) =>
	writeFile(mcpConfigFile(home), typeof config === "string" ? config : JSON.stringify(config));
const load = (env: NodeJS.ProcessEnv = {}) => loadMcpConfig({ home, cwd, env });

describe("loadMcpConfig", () => {
	it("has no servers and no problems without a file", () => {
		expect(load()).toMatchObject({ servers: [], problems: [] });
	});

	it("reads stdio and HTTP entries in the standard format", async () => {
		await write({
			mcpServers: {
				files: { command: "npx", args: ["-y", "server", "~/notes"], cwd: "sub", env: { MODE: "fast" } },
				docs: { url: "https://example.com/mcp", description: " Product docs ", timeout: 5 },
				off: { type: "stdio", command: "x", enabled: false },
			},
		});
		const { servers, problems } = load();
		expect(problems).toEqual([]);
		expect(servers).toEqual([
			{
				name: "files",
				transport: "stdio",
				enabled: true,
				timeoutMs: 60_000,
				command: "npx",
				args: ["-y", "server", join(home, "notes")],
				env: { MODE: "fast" },
				cwd: join(cwd, "sub"),
			},
			{
				name: "docs",
				transport: "http",
				enabled: true,
				timeoutMs: 5_000,
				description: "Product docs",
				url: "https://example.com/mcp",
				headers: {},
			},
			expect.objectContaining({ name: "off", enabled: false }),
		]);
	});

	it("expands ${VAR} in env and headers", async () => {
		await write({
			mcpServers: {
				a: { command: "a", env: { TOKEN: "${A_TOKEN}" } },
				b: { url: "https://b.example/mcp", headers: { Authorization: "Bearer ${B_TOKEN}" } },
			},
		});
		const { servers } = load({ A_TOKEN: "alpha-secret", B_TOKEN: "beta-secret" });
		expect(servers[0]).toMatchObject({ env: { TOKEN: "alpha-secret" } });
		expect(servers[1]).toMatchObject({ headers: { Authorization: "Bearer beta-secret" } });
	});

	it("reports invalid entries and keeps the others", async () => {
		await write({
			mcpServers: {
				legacy: { type: "sse", url: "https://x.example/sse" },
				both: { command: "a", url: "https://x.example/mcp" },
				none: {},
				"bad name": { command: "a" },
				unset: { command: "a", env: { KEY: "${NOT_SET_ANYWHERE}" } },
				dup_a: { command: "a" },
				"dup-a": { command: "a" },
				good: { command: "ok" },
			},
		});
		const { servers, problems } = load();
		expect(servers.map((server) => server.name)).toEqual(["dup_a", "good"]);
		expect(problems.map((problem) => problem.name)).toEqual(["legacy", "both", "none", "bad name", "unset", "dup-a"]);
		expect(problems[0]?.message).toContain("SSE is not supported");
		expect(problems[4]?.message).toContain("${NOT_SET_ANYWHERE}");
	});

	it("reports a file that is not JSON", async () => {
		await write("{ nope");
		expect(load().problems[0]?.message).toContain("is not valid JSON");
	});
});

describe("secrets", () => {
	it("covers literal and expanded values of env and headers, their words and URL query values", async () => {
		await write({
			mcpServers: {
				literal: { url: "https://x.example/mcp", headers: { Authorization: "Bearer lit-token-1234" } },
				expanded: { command: "a", env: { KEY: "${MY_KEY}" } },
				query: { url: "https://y.example/mcp?api_key=query-secret-99" },
				invalid: { type: "sse", headers: { "X-Key": "invalid-entry-secret" } },
			},
		});
		const { secrets } = load({ MY_KEY: "from-env-5678" });
		const leaked =
			"auth Bearer lit-token-1234 failed; token lit-token-1234; key from-env-5678; url ?api_key=query-secret-99; invalid-entry-secret";
		const shown = redact(leaked, secrets);
		for (const secret of ["lit-token-1234", "from-env-5678", "query-secret-99", "invalid-entry-secret"])
			expect(shown).not.toContain(secret);
		expect(shown).toContain("auth *** failed");
	});
});
