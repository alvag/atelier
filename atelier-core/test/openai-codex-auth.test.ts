import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CODEX_CLIENT_ID, loginCodex, refreshCodex } from "../src/openai/codex-auth.ts";
import { type OAuthInteraction, OpenAiAuthError, parsePasted } from "../src/openai/oauth.ts";
import { FakeOpenAiAuth, fakeCodexAccess, fakeRefresh } from "./support/fake-openai-auth.ts";

let auth: FakeOpenAiAuth;
let accountId: string;
let access: string;
let refresh: string;

beforeEach(async () => {
	auth = await new FakeOpenAiAuth().start();
	accountId = `acct-${randomUUID()}`;
	access = fakeCodexAccess(accountId);
	refresh = fakeRefresh();
	auth.routes.set("/oauth/token", () => ({
		json: { access_token: access, refresh_token: refresh, id_token: "id", expires_in: 3600 },
	}));
});

afterEach(async () => {
	await auth.stop();
});

/** A port nobody listens on, for the callback server. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

interface Recorded extends OAuthInteraction {
	opened: string[];
	shown: string[];
	asked: AbortSignal[];
}

/** The user: `paste` answers the question for a pasted URL or code; undefined leaves it open until aborted. */
function user(paste?: () => Promise<string | undefined>): Recorded {
	const recorded: Recorded = {
		opened: [],
		shown: [],
		asked: [],
		openBrowser: async (url) => {
			recorded.opened.push(url);
		},
		show: (text) => recorded.shown.push(text),
		askPasted: (_prompt, signal) => {
			recorded.asked.push(signal);
			if (paste) return paste();
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
		},
	};
	return recorded;
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(check()).toBe(true);
}

it("signs in with the browser: PKCE against auth.openai.com, the code from the callback, the account from the JWT", async () => {
	const port = await freePort();
	const person = user();
	const login = loginCodex(person, { method: "browser", authUrl: auth.url, callbackPort: port });
	await until(() => person.opened.length === 1);
	const url = new URL(person.opened[0] ?? "");
	expect(url.origin + url.pathname).toBe(`${auth.url}/oauth/authorize`);
	expect(Object.fromEntries(url.searchParams)).toMatchObject({
		response_type: "code",
		client_id: CODEX_CLIENT_ID,
		redirect_uri: `http://localhost:${port}/auth/callback`,
		scope: "openid profile email offline_access",
		code_challenge_method: "S256",
		codex_cli_simplified_flow: "true",
		originator: "atelier",
	});
	expect(person.shown.join("\n")).toContain(url.href);

	const state = url.searchParams.get("state") ?? "";
	const wrong = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c-0&state=other`);
	expect(wrong.status).toBe(400);
	const right = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c-1&state=${state}`);
	expect(right.status).toBe(200);

	const credential = await login;
	expect(credential).toMatchObject({ type: "oauth", access, refresh, accountId });
	expect(credential.expires).toBeGreaterThan(Date.now() + 3_500_000);
	const exchange = auth.requests.find((request) => request.path === "/oauth/token")?.body ?? {};
	expect(exchange).toMatchObject({ grant_type: "authorization_code", code: "c-1", client_id: CODEX_CLIENT_ID });
	const challenge = createHash("sha256")
		.update(exchange.code_verifier ?? "")
		.digest("base64url");
	expect(challenge).toBe(url.searchParams.get("code_challenge"));
	expect(person.asked[0]?.aborted).toBe(true);
	await expect(fetch(`http://127.0.0.1:${port}/auth/callback`)).rejects.toThrow();
});

it("takes the pasted redirect URL, or the bare code, and refuses one of another sign-in", async () => {
	const port = await freePort();
	let state = "";
	const person = user(async () => `http://localhost:${port}/auth/callback?code=c-2&state=${state}`);
	person.openBrowser = async (url) => {
		state = new URL(url).searchParams.get("state") ?? "";
	};
	await expect(loginCodex(person, { method: "browser", authUrl: auth.url, callbackPort: port })).resolves.toMatchObject(
		{
			accountId,
		},
	);
	expect(auth.requests.at(-1)?.body.code).toBe("c-2");

	const bare = user(async () => "c-3");
	await loginCodex(bare, { method: "browser", authUrl: auth.url, callbackPort: port });
	expect(auth.requests.at(-1)?.body.code).toBe("c-3");

	const stranger = user(async () => `http://localhost:${port}/auth/callback?code=c-4&state=someone-else`);
	await expect(loginCodex(stranger, { method: "browser", authUrl: auth.url, callbackPort: port })).rejects.toThrow(
		/state/,
	);
});

it("refuses a pasted URL or query without the sign-in's state, and never repeats the code in an error", () => {
	expect(parsePasted("bare-code", "expected").code).toBe("bare-code");
	// A bare code may hold `=` (base64 padding): only `code=` or `://` make it a redirect.
	expect(parsePasted("YmFyZS1jb2Rl==", "expected").code).toBe("YmFyZS1jb2Rl==");
	expect(() => parsePasted("http://127.0.0.1:1455/auth/callback?code=other-login", "expected")).toThrow(/state/);
	expect(() => parsePasted("code=other-login", "expected")).toThrow(/state/);
	const code = `test-code-${randomUUID()}`;
	const failed = (() => {
		try {
			parsePasted(
				`http://127.0.0.1:1455/auth/callback?code=${code}&state=expected&error=access_denied&error_description=bad+${code}`,
				"expected",
			);
		} catch (error) {
			return (error as Error).message;
		}
		return "";
	})();
	expect(failed).toMatch(/access_denied|bad/);
	expect(failed).not.toContain(code);
});

it("says a failed redirect without the code it carried", async () => {
	const port = await freePort();
	const code = `test-code-${randomUUID()}`;
	const person = user();
	const login = loginCodex(person, { method: "browser", authUrl: auth.url, callbackPort: port }).then(
		() => new Error("signed in"),
		(error: unknown) => error as Error,
	);
	await until(() => person.opened.length === 1);
	const state = new URL(person.opened[0] ?? "").searchParams.get("state");
	const page = await fetch(
		`http://127.0.0.1:${port}/auth/callback?state=${state}&code=${code}&error=server_error&error_description=${code}`,
	);
	expect(await page.text()).not.toContain(code);
	const error = await login;
	expect(error).toBeInstanceOf(OpenAiAuthError);
	expect(error.message).not.toContain(code);
});

it("stops polling and cancels the device code when the user cancels while it waits", async () => {
	let polls = 0;
	auth.routes.set("/api/accounts/deviceauth/usercode", () => ({
		json: { device_auth_id: "dev-1", user_code: "WXYZ-1234", interval: "0" },
	}));
	auth.routes.set("/api/accounts/deviceauth/token", () => {
		polls++;
		return { status: 403, json: {} };
	});
	let cancel: () => void = () => {};
	const waited: AbortSignal[] = [];
	const person: OAuthInteraction = {
		...user(),
		waitOrCancel: (_prompt, signal) => {
			waited.push(signal);
			return new Promise<void>((resolve) => {
				cancel = resolve;
			});
		},
	};
	const login = loginCodex(person, { method: "device", authUrl: auth.url, minPollIntervalMs: 0 }).then(
		() => new Error("signed in"),
		(error: unknown) => error as Error,
	);
	await until(() => polls >= 2);
	cancel();
	expect((await login).message).toMatch(/cancelled/);
	const after = polls;
	// A few more turns of the event loop: a poll still running would show up here.
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	expect(polls).toBeLessThanOrEqual(after + 1);
	expect(auth.requests.some((request) => request.path === "/oauth/token")).toBe(false);

	// Signed in on the other device: the question that offered to cancel closes.
	auth.routes.set("/api/accounts/deviceauth/token", () => ({
		json: { authorization_code: "c-7", code_verifier: "v-7" },
	}));
	await loginCodex(person, { method: "device", authUrl: auth.url, minPollIntervalMs: 0 });
	expect(waited.at(-1)?.aborted).toBe(true);
});

it("asks for the pasted URL when another program holds the callback port", async () => {
	const busy: Server = createServer((_request, response) => response.end("codex"));
	await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
	const port = (busy.address() as AddressInfo).port;
	try {
		const person = user(async () => "c-5");
		await expect(
			loginCodex(person, { method: "browser", authUrl: auth.url, callbackPort: port }),
		).resolves.toMatchObject({ accountId });
		expect(person.shown.join("\n")).toMatch(new RegExp(`port ${port} is in use.*paste`, "is"));
	} finally {
		busy.closeAllConnections();
		await new Promise((resolve) => busy.close(resolve));
	}
});

it("stops, and frees the port, when the user cancels", async () => {
	const port = await freePort();
	const person = user(async () => undefined);
	await expect(loginCodex(person, { method: "browser", authUrl: auth.url, callbackPort: port })).rejects.toThrow(
		/cancelled/,
	);
	await expect(fetch(`http://127.0.0.1:${port}/auth/callback`)).rejects.toThrow();
});

it("signs in with a device code: shows the code, polls while it is pending, exchanges what it returns", async () => {
	const userCode = `CODE-${randomUUID().slice(0, 4)}`;
	let polls = 0;
	auth.routes.set("/api/accounts/deviceauth/usercode", () => ({
		json: { device_auth_id: "dev-1", user_code: userCode, interval: "0" },
	}));
	auth.routes.set("/api/accounts/deviceauth/token", () =>
		++polls < 2
			? { status: 403, json: { error: { code: "deviceauth_authorization_pending" } } }
			: { json: { authorization_code: "c-6", code_verifier: "v-6" } },
	);
	const person = user();
	const credential = await loginCodex(person, { method: "device", authUrl: auth.url, minPollIntervalMs: 0 });
	expect(credential).toMatchObject({ access, refresh, accountId });
	expect(person.shown.join("\n")).toContain(userCode);
	expect(person.shown.join("\n")).toContain(`${auth.url}/codex/device`);
	expect(auth.requests.find((request) => request.path === "/api/accounts/deviceauth/usercode")?.body).toEqual({
		client_id: CODEX_CLIENT_ID,
	});
	expect(auth.requests.at(-1)?.body).toMatchObject({
		grant_type: "authorization_code",
		code: "c-6",
		code_verifier: "v-6",
		redirect_uri: `${auth.url}/deviceauth/callback`,
	});
});

it("refreshes the tokens, and says the sign-in expired when the refresh token is refused, without the token", async () => {
	const old = fakeRefresh();
	await expect(refreshCodex(old, { authUrl: auth.url })).resolves.toMatchObject({ access, refresh, accountId });
	expect(auth.requests.at(-1)?.body).toEqual({
		grant_type: "refresh_token",
		refresh_token: old,
		client_id: CODEX_CLIENT_ID,
	});

	auth.routes.set("/oauth/token", () => ({ status: 400, json: { error: "invalid_grant" } }));
	const error = await refreshCodex(old, { authUrl: auth.url }).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(OpenAiAuthError);
	expect((error as OpenAiAuthError).expired).toBe(true);
	expect((error as Error).message).not.toContain(old);
});

it("keeps a device code the user already approved: cancelling during its token exchange changes nothing", async () => {
	auth.routes.set("/api/accounts/deviceauth/usercode", () => ({
		json: { device_auth_id: "dev-1", user_code: "WXYZ-1234", interval: "0" },
	}));
	auth.routes.set("/api/accounts/deviceauth/token", () => ({
		json: { authorization_code: "c-8", code_verifier: "v-8" },
	}));
	let cancel: () => void = () => {};
	let offerOpenAtExchange: boolean | undefined;
	const offers: AbortSignal[] = [];
	const person: OAuthInteraction = {
		...user(),
		waitOrCancel: (_prompt, signal) => {
			offers.push(signal);
			return new Promise<void>((resolve) => {
				cancel = resolve;
			});
		},
	};
	// The user cancels just as the token exchange starts, after the code was approved.
	const exchanging: typeof fetch = async (input, init) => {
		if (String(input).endsWith("/oauth/token")) {
			offerOpenAtExchange = offers.at(-1)?.aborted === false;
			cancel();
			await new Promise((resolve) => setImmediate(resolve));
		}
		return fetch(input, init);
	};
	await expect(
		loginCodex(person, { method: "device", authUrl: auth.url, minPollIntervalMs: 0, fetch: exchanging }),
	).resolves.toMatchObject({ access, accountId });
	expect(offerOpenAtExchange).toBe(false);
});
