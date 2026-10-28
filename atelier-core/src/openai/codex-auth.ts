import type { OAuthCredential } from "../auth-store.ts";
import {
	CALLBACK_PATH,
	createPkce,
	errorCode,
	jwtClaims,
	type OAuthInteraction,
	OpenAiAuthError,
	pollUntil,
	postForm,
	postJson,
	randomState,
	readJson,
	tokensOf,
	waitForAuthorization,
} from "./oauth.ts";

/**
 * The legacy "OpenAI Codex" sign-in: the Codex CLI's own OAuth client, whose tokens reach ChatGPT's Codex endpoint.
 * It is the Codex CLI's client, not one issued to Atelier, so OpenAI may stop it at any time.
 */
export const CODEX_PROVIDER = "openai-codex";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_URL = "https://auth.openai.com";
/** The port the Codex CLI registered for its redirect; the Codex CLI itself uses it while it signs in. */
export const CODEX_CALLBACK_PORT = 1455;
const SCOPE = "openid profile email offline_access";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const MIN_POLL_INTERVAL_MS = 1_000;

/** Codex's tokens, with the ChatGPT account every request names. */
export interface CodexCredential extends OAuthCredential {
	accountId: string;
}

export interface CodexAuthOptions {
	/** auth.openai.com, or a fake in tests. */
	authUrl?: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

export interface CodexLoginOptions extends CodexAuthOptions {
	/** `browser` waits for the redirect or a pasted URL; `device` shows a code to enter on another device. */
	method: "browser" | "device";
	/** The redirect's port: 1455, the one the Codex client allows. */
	callbackPort?: number;
	/** The device code's shortest wait between polls; tests lower it. */
	minPollIntervalMs?: number;
}

/** The ChatGPT account in Codex's access token, which every request to the Codex endpoint names. */
export function codexAccountId(access: string): string | undefined {
	const auth = jwtClaims(access)?.[ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
	const id = auth?.chatgpt_account_id;
	return typeof id === "string" && id !== "" ? id : undefined;
}

function credentialOf(json: Record<string, unknown>, what: string): CodexCredential {
	const tokens = tokensOf(json, what);
	const accountId = codexAccountId(tokens.access);
	if (accountId === undefined) throw new OpenAiAuthError(`${what} answered a token without a ChatGPT account`);
	return { type: "oauth", ...tokens, accountId };
}

const authUrl = (options: CodexAuthOptions) => options.authUrl ?? OPENAI_AUTH_URL;

async function exchange(
	code: string,
	verifier: string,
	redirectUri: string,
	options: CodexAuthOptions,
): Promise<CodexCredential> {
	const json = await postForm(
		`${authUrl(options)}/oauth/token`,
		{
			grant_type: "authorization_code",
			client_id: CODEX_CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		},
		{ ...options, what: "The sign-in's token exchange" },
	);
	return credentialOf(json, "The sign-in's token exchange");
}

/** Signs in to ChatGPT with the Codex client, in the browser or with a device code. */
export function loginCodex(interaction: OAuthInteraction, options: CodexLoginOptions): Promise<CodexCredential> {
	const signal = options.signal ?? interaction.signal;
	const withSignal = { ...options, ...(signal ? { signal } : {}) };
	return options.method === "device"
		? loginWithDeviceCode(interaction, withSignal)
		: loginInBrowser(interaction, withSignal);
}

async function loginInBrowser(interaction: OAuthInteraction, options: CodexLoginOptions): Promise<CodexCredential> {
	const port = options.callbackPort ?? CODEX_CALLBACK_PORT;
	const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
	const pkce = createPkce();
	const state = randomState();
	const url = new URL(`${authUrl(options)}/oauth/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: CODEX_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: SCOPE,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "atelier",
	}).toString();
	const { code } = await waitForAuthorization(
		{ ...interaction, ...(options.signal ? { signal: options.signal } : {}) },
		{ url: url.href, state, host: "127.0.0.1", port, portOwner: "probably the Codex CLI signing in" },
	);
	return exchange(code, pkce.verifier, redirectUri, options);
}

async function loginWithDeviceCode(
	interaction: OAuthInteraction,
	options: CodexLoginOptions,
): Promise<CodexCredential> {
	// The user may cancel while the code waits: that stops the polling and every request with it. Once the code was
	// approved the offer closes, so the token exchange of a sign-in the user finished is never cut short.
	const ended = new AbortController();
	const cancelled = new AbortController();
	const signal = AbortSignal.any([cancelled.signal, ...(options.signal ? [options.signal] : [])]);
	let granted: DeviceGrant;
	try {
		granted = await deviceCode(interaction, { ...options, signal }, () => {
			interaction.waitOrCancel?.("Waiting for the code to be entered", ended.signal).then(
				() => {
					if (!ended.signal.aborted) cancelled.abort();
				},
				() => {},
			);
		});
	} finally {
		ended.abort();
	}
	return exchange(granted.code, granted.verifier, granted.redirectUri, options);
}

/** What an approved device code gives to exchange for tokens. */
interface DeviceGrant {
	code: string;
	verifier: string;
	redirectUri: string;
}

async function deviceCode(
	interaction: OAuthInteraction,
	options: CodexLoginOptions & { signal: AbortSignal },
	offerCancel: () => void,
): Promise<DeviceGrant> {
	const base = authUrl(options);
	const what = "The device code request";
	const started = await postJson(
		`${base}/api/accounts/deviceauth/usercode`,
		{ client_id: CODEX_CLIENT_ID },
		{ ...options, what },
	);
	if (started.status === 404)
		throw new OpenAiAuthError("OpenAI does not offer device codes here: sign in with the browser");
	const device = await readJson(started, what);
	const interval = Number(device.interval);
	if (typeof device.device_auth_id !== "string" || typeof device.user_code !== "string" || !Number.isFinite(interval))
		throw new OpenAiAuthError(`${what} answered without a device code`);
	interaction.show(`On any device, open ${base}/codex/device and enter the code ${device.user_code}.`);
	offerCancel();

	const granted = await pollUntil(
		async () => {
			const response = await postJson(
				`${base}/api/accounts/deviceauth/token`,
				{ device_auth_id: device.device_auth_id, user_code: device.user_code },
				{ ...options, what: "The device code check" },
			);
			if (response.status === 403 || response.status === 404) return "pending";
			if (!response.ok) {
				const code = errorCode(
					await response
						.clone()
						.json()
						.catch(() => undefined),
				);
				if (code === "deviceauth_authorization_pending") return "pending";
				if (code === "slow_down") return "slow_down";
			}
			const json = await readJson(response, "The device code check");
			if (typeof json.authorization_code !== "string" || typeof json.code_verifier !== "string")
				throw new OpenAiAuthError("The device code check answered without a code");
			return { code: json.authorization_code, verifier: json.code_verifier };
		},
		{
			intervalMs: interval * 1000,
			minIntervalMs: options.minPollIntervalMs ?? MIN_POLL_INTERVAL_MS,
			deadlineMs: DEVICE_CODE_TIMEOUT_MS,
			signal: options.signal,
		},
	);
	return { ...granted, redirectUri: `${base}/deviceauth/callback` };
}

/** New tokens for a refresh token; an `OpenAiAuthError` with `expired` when it was refused. */
export async function refreshCodex(refresh: string, options: CodexAuthOptions = {}): Promise<CodexCredential> {
	const json = await postForm(
		`${authUrl(options)}/oauth/token`,
		{ grant_type: "refresh_token", refresh_token: refresh, client_id: CODEX_CLIENT_ID },
		{ ...options, what: "Refreshing the ChatGPT sign-in" },
	);
	return credentialOf(json, "Refreshing the ChatGPT sign-in");
}
