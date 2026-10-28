import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CHATGPT_SCOPE, loginChatGpt, refreshChatGpt } from "../src/openai/chatgpt-auth.ts";
import type { OAuthInteraction } from "../src/openai/oauth.ts";
import { FakeOpenAiAuth, fakeJwt, fakeRefresh } from "./support/fake-openai-auth.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

let auth: FakeOpenAiAuth;
let home: string;
let access: string;
let refresh: string;
let scope: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-chatgpt-auth-"));
	auth = await new FakeOpenAiAuth().start();
	access = fakeJwt({ sub: randomUUID() });
	refresh = fakeRefresh();
	scope = CHATGPT_SCOPE;
	auth.routes.set("/api/accounts/oauth/token", () => ({
		json: { access_token: access, refresh_token: refresh, id_token: "id", expires_in: 3600, scope },
	}));
});

afterEach(async () => {
	await auth.stop();
	await rm(home, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** The browser: follows the sign-in page to the redirect with `query`, or the user pastes `pasted`. */
function browser(
	query: (state: string) => string,
	pasted?: (state: string) => string,
): OAuthInteraction & { url: URL } {
	const person = {
		url: new URL("http://unset"),
		show: () => {},
		openBrowser: async (url: string) => {
			person.url = new URL(url);
			if (pasted) return;
			const redirect = person.url.searchParams.get("redirect_uri") ?? "";
			await fetch(`${redirect}?${query(person.url.searchParams.get("state") ?? "")}`);
		},
		askPasted: (_prompt: string, signal: AbortSignal) =>
			pasted
				? Promise.resolve(pasted(person.url.searchParams.get("state") ?? ""))
				: new Promise<string | undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined))),
	};
	return person;
}

it("signs in with ChatGPT: a client issued for Atelier, this installation's id, a token for the Responses API", async () => {
	const port = await freePort();
	const person = browser((state) => `code=c-1&state=${state}&client_id=issued-1`);
	const before = Date.now();
	const credential = await loginChatGpt(person, { home, authUrl: auth.url, callbackPort: port });
	expect(credential).toMatchObject({ type: "oauth", access, refresh, clientId: "issued-1" });
	expect(credential.scopes).toContain("chatgpt.tokens.use.direct");
	// Refreshed three minutes early, so no request starts with a token about to expire.
	expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 180_000);
	expect(credential.expires).toBeGreaterThanOrEqual(before + 3600_000 - 180_000);

	const deviceId = (await readFile(join(home, ".atelier", "device-id"), "utf8")).trim();
	expect((await stat(join(home, ".atelier", "device-id"))).mode & 0o777).toBe(0o600);
	expect(person.url.origin + person.url.pathname).toBe(`${auth.url}/api/accounts/authorize`);
	expect(Object.fromEntries(person.url.searchParams)).toMatchObject({
		client_id: "dynamic_agent_client",
		agent_name_hint: "Atelier",
		ext_agent_host_id: `urn:uuid:${deviceId}`,
		response_type: "code",
		redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
		resource: "https://api.openai.com/v1",
		scope: CHATGPT_SCOPE,
		code_challenge_method: "S256",
	});
	expect(auth.requests.at(-1)?.body).toMatchObject({
		grant_type: "authorization_code",
		client_id: "issued-1",
		code: "c-1",
		redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
		resource: "https://api.openai.com/v1",
	});

	const again = browser((state) => `code=c-2&state=${state}&client_id=issued-2`);
	await loginChatGpt(again, { home, authUrl: auth.url, callbackPort: port });
	expect(again.url.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${deviceId}`);
});

it("needs the whole pasted URL, which carries the issued client", async () => {
	const port = await freePort();
	const bare = browser(
		() => "",
		() => "c-3",
	);
	await expect(loginChatGpt(bare, { home, authUrl: auth.url, callbackPort: port })).rejects.toThrow(/whole URL/);
	const pasted = browser(
		() => "",
		(state) => `http://127.0.0.1:${port}/auth/callback?code=c-4&state=${state}&client_id=issued-4`,
	);
	await expect(loginChatGpt(pasted, { home, authUrl: auth.url, callbackPort: port })).resolves.toMatchObject({
		clientId: "issued-4",
	});
});

it("refuses a grant without the scope the Responses API needs", async () => {
	scope = "openid profile email offline_access";
	const port = await freePort();
	const person = browser((state) => `code=c-5&state=${state}&client_id=issued-5`);
	await expect(loginChatGpt(person, { home, authUrl: auth.url, callbackPort: port })).rejects.toThrow(
		/chatgpt\.tokens\.use\.direct/,
	);
});

it("refreshes with the issued client, and says the sign-in expired when refused", async () => {
	const old = { type: "oauth" as const, access: "x", refresh: fakeRefresh(), expires: 0, clientId: "issued-6" };
	await expect(refreshChatGpt(old, { authUrl: auth.url })).resolves.toMatchObject({ access, clientId: "issued-6" });
	expect(auth.requests.at(-1)?.body).toEqual({
		grant_type: "refresh_token",
		client_id: "issued-6",
		refresh_token: old.refresh,
		resource: "https://api.openai.com/v1",
	});
	auth.routes.set("/api/accounts/oauth/token", () => ({ status: 401, json: { error: "invalid_grant" } }));
	await expect(refreshChatGpt(old, { authUrl: auth.url })).rejects.toMatchObject({ expired: true });
});
