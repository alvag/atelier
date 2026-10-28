import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, authFile } from "@atelier/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeOpenAiAuth, fakeCodexAccess, fakeRefresh } from "../../atelier-core/test/support/fake-openai-auth.ts";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";
import { type LoginOption, type LoginPorts, login, logout } from "../src/login.ts";

requireIsolatedHome();

let home: string;
let auth: FakeOpenAiAuth;
let port: number;
let accountId: string;
let access: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-login-openai-"));
	// A Claude Code that is not logged in, for the Anthropic row of the lists.
	await writeFile(join(home, "claude"), `#!/bin/sh\necho '{"loggedIn":false,"authMethod":"none"}'\nexit 1\n`);
	await chmod(join(home, "claude"), 0o755);
	auth = await new FakeOpenAiAuth().start();
	accountId = `acct-${randomUUID()}`;
	access = fakeCodexAccess(accountId);
	auth.routes.set("/oauth/token", () => ({
		json: { access_token: access, refresh_token: fakeRefresh(), expires_in: 3600 },
	}));
	auth.routes.set("/api/accounts/oauth/token", () => ({
		json: {
			access_token: access,
			refresh_token: fakeRefresh(),
			id_token: "id",
			expires_in: 3600,
			scope: "openid chatgpt.tokens.use.direct",
		},
	}));
	const free = createServer();
	await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
	port = (free.address() as AddressInfo).port;
	await new Promise((resolve) => free.close(resolve));
});

afterEach(async () => {
	await auth.stop();
	await rm(home, { recursive: true, force: true });
});

/** Ports whose "browser" follows the sign-in page to its redirect with a code, as a person signing in would. */
function ports(options: { choices?: number[]; interactive?: boolean; env?: Record<string, string> } = {}) {
	const shown: string[] = [];
	const lists: { title: string; options: readonly LoginOption[] }[] = [];
	const opened: string[] = [];
	const asked: AbortSignal[] = [];
	const value: LoginPorts = {
		home,
		env: options.env ?? {},
		claudeCode: join(home, "claude"),
		// A desktop with a browser; the SSH test says otherwise through the environment.
		platform: "darwin",
		interactive: options.interactive ?? true,
		openai: { authUrl: auth.url, callbackPort: port, minPollIntervalMs: 0 },
		openBrowser: async (url) => {
			opened.push(url);
			const page = new URL(url);
			const redirect = page.searchParams.get("redirect_uri") ?? "";
			const state = page.searchParams.get("state") ?? "";
			await fetch(`${redirect}?code=c-1&state=${state}&client_id=issued-1`);
		},
		choose: async (title, list) => {
			lists.push({ title, options: list });
			return options.choices?.shift();
		},
		askSecret: async () => undefined,
		askUntil: (prompt, signal) => {
			shown.push(`ask: ${prompt}`);
			asked.push(signal);
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
		},
		confirm: async () => false,
		handOver: async (task) => task(),
		say: (text) => shown.push(text),
		fail: (text) => shown.push(`error: ${text}`),
	};
	return { value, shown, lists, opened, asked };
}

const store = () => new AuthStore(authFile(home));

it("lists Codex and Sign in with ChatGPT among the accounts, with their state", async () => {
	await store().set("openai-chatgpt", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 });
	const p = ports({ choices: [] });
	expect(await login(p.value, { method: "account" })).toBe(false);
	expect(p.lists[0]?.options.map(({ label }) => label)).toEqual([
		"Anthropic",
		"OpenAI Codex (ChatGPT Plus/Pro)",
		"Sign in with ChatGPT",
	]);
	expect(p.lists[0]?.options.slice(1).map(({ status }) => status)).toEqual(["not signed in", "✓ signed in"]);
});

it("signs in to Codex in the browser, warns about its terms, and stores the sign-in", async () => {
	const p = ports({ choices: [0] });
	expect(await login(p.value, { method: "account", provider: "openai-codex" })).toBe(true);
	expect(p.lists[0]).toMatchObject({ title: "How to sign in to OpenAI Codex" });
	expect(p.lists[0]?.options.map(({ label }) => label)).toEqual(["In the browser", "With a device code"]);
	expect(p.shown.join("\n")).toMatch(/Codex CLI's own sign-in.*may refuse it at any time.*terms/s);
	expect(p.opened).toHaveLength(1);
	expect(p.asked[0]?.aborted).toBe(true);
	expect(store().get("openai-codex")).toMatchObject({ type: "oauth", access, accountId });
	expect(p.shown.at(-1)).toBe(
		"✓ OpenAI Codex: signed in, stored in ~/.atelier/auth.json; --backend openai-codex uses it.",
	);
});

it("offers the device code first over SSH, and signs in with it", async () => {
	auth.routes.set("/api/accounts/deviceauth/usercode", () => ({
		json: { device_auth_id: "d-1", user_code: "WXYZ-1234", interval: "0" },
	}));
	auth.routes.set("/api/accounts/deviceauth/token", () => ({
		json: { authorization_code: "c-2", code_verifier: "v-2" },
	}));
	const p = ports({ choices: [0], env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" } });
	expect(await login(p.value, { method: "account", provider: "openai-codex" })).toBe(true);
	expect(p.lists[0]?.options.map(({ label }) => label)).toEqual(["With a device code", "In the browser"]);
	expect(p.shown.join("\n")).toContain("WXYZ-1234");
	expect(p.opened).toEqual([]);
	expect(store().get("openai-codex")).toMatchObject({ accountId });
});

it("signs in with ChatGPT and stores the client it was issued", async () => {
	const p = ports();
	expect(await login(p.value, { method: "account", provider: "openai-chatgpt" })).toBe(true);
	expect(store().get("openai-chatgpt")).toMatchObject({ type: "oauth", access, clientId: "issued-1" });
	expect(p.shown.at(-1)).toBe(
		"✓ Sign in with ChatGPT: signed in, stored in ~/.atelier/auth.json; --backend openai-codex uses it.",
	);
});

it("says a failed sign-in, needs a terminal, and stores nothing", async () => {
	auth.routes.set("/oauth/token", () => ({ status: 400, json: { error: "invalid_grant" } }));
	const refused = ports({ choices: [0] });
	expect(await login(refused.value, { method: "account", provider: "openai-codex" })).toBe(false);
	expect(refused.shown.at(-1)).toMatch(/^error: The sign-in's token exchange failed \(400, invalid_grant\)/);
	const piped = ports({ interactive: false });
	expect(await login(piped.value, { method: "account", provider: "openai-chatgpt" })).toBe(false);
	expect(piped.shown).toEqual(["error: signing in with an account needs a terminal: run atelier login in one"]);
	expect(store().providers()).toEqual([]);
});

it("signs out of Codex and of ChatGPT by removing the stored sign-in, with nothing to confirm", async () => {
	await store().set("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 1 });
	await store().set("openai-chatgpt", { type: "oauth", access: "b", refresh: "s", expires: 1 });
	const p = ports({ choices: [0] });
	expect(await logout(p.value, { method: "account" })).toBe(true);
	expect(p.lists[0]?.options.map(({ label }) => label)).toEqual(["OpenAI Codex sign-in", "Sign in with ChatGPT"]);
	expect(p.shown).toEqual(["OpenAI Codex sign-in removed from ~/.atelier/auth.json."]);
	const chatgpt = ports();
	expect(await logout(chatgpt.value, { provider: "openai-chatgpt" })).toBe(true);
	expect(store().providers()).toEqual([]);
});
