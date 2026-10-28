import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OAuthCredential } from "../auth-store.ts";
import { ensureSecretFolder, readSecretFile, writeSecretFile } from "../secret-file.ts";
import { OPENAI_AUTH_URL } from "./codex-auth.ts";
import {
	type Authorization,
	CALLBACK_PATH,
	createPkce,
	type OAuthInteraction,
	OpenAiAuthError,
	postForm,
	randomState,
	tokensOf,
	waitForAuthorization,
} from "./oauth.ts";

/**
 * "Sign in with ChatGPT": OpenAI's sign-in for other agents. Each sign-in registers a client for Atelier, whose
 * token reaches the Responses API of api.openai.com and counts against the ChatGPT subscription's limits.
 */
export const CHATGPT_PROVIDER = "openai-chatgpt";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
const CHATGPT_CALLBACK_PORT = 1455;
/** The token is taken for expired this long before it is, so no request starts with one about to expire. */
const EXPIRY_MARGIN_MS = 3 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ChatGPT's tokens, with the client the sign-in registered, which refreshes them. */
export interface ChatGptCredential extends OAuthCredential {
	clientId: string;
	scopes: string[];
}

export interface ChatGptAuthOptions {
	authUrl?: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

export interface ChatGptLoginOptions extends ChatGptAuthOptions {
	/** Where `~/.atelier/device-id` is: OpenAI knows each installation by a stable id. */
	home: string;
	callbackPort?: number;
}

/** This installation's id, made once and kept in `~/.atelier/device-id`. */
export function installationId(home: string): string {
	const folder = join(home, ".atelier");
	const file = join(folder, "device-id");
	const kept = readSecretFile(file)?.trim();
	if (kept !== undefined && UUID.test(kept)) return kept.toLowerCase();
	ensureSecretFolder(folder);
	const id = randomUUID();
	writeSecretFile(file, `${id}\n`);
	return id;
}

function credentialOf(json: Record<string, unknown>, clientId: string, what: string): ChatGptCredential {
	const tokens = tokensOf(json, what);
	const scopes = typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [];
	if (!scopes.includes(DIRECT_TOKEN_SCOPE)) throw new OpenAiAuthError(`${what}: the grant lacks ${DIRECT_TOKEN_SCOPE}`);
	return { type: "oauth", ...tokens, expires: tokens.expires - EXPIRY_MARGIN_MS, clientId, scopes };
}

const authUrl = (options: ChatGptAuthOptions) => options.authUrl ?? OPENAI_AUTH_URL;

/** The client OpenAI issued for this sign-in, which only the redirect carries. */
function issuedClient(authorization: Authorization): string {
	const clientId = authorization.params.get("client_id")?.trim();
	if (!clientId)
		throw new OpenAiAuthError("paste the whole URL the browser ended on: it names the client OpenAI issued");
	return clientId;
}

/** Signs in with ChatGPT in the browser; there is no device code for this sign-in. */
export async function loginChatGpt(
	interaction: OAuthInteraction,
	options: ChatGptLoginOptions,
): Promise<ChatGptCredential> {
	const signal = options.signal ?? interaction.signal;
	const port = options.callbackPort ?? CHATGPT_CALLBACK_PORT;
	const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
	const pkce = createPkce();
	const state = randomState();
	const url = new URL(`${authUrl(options)}/api/accounts/authorize`);
	url.search = new URLSearchParams({
		client_id: DYNAMIC_CLIENT_ID,
		agent_name_hint: "Atelier",
		ext_agent_host_id: `urn:uuid:${installationId(options.home)}`,
		response_type: "code",
		redirect_uri: redirectUri,
		resource: RESOURCE,
		scope: CHATGPT_SCOPE,
		state,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		nonce: randomBytes(32).toString("base64url"),
	}).toString();
	const authorization = await waitForAuthorization(
		{ ...interaction, ...(signal ? { signal } : {}) },
		{
			url: url.href,
			state,
			host: "127.0.0.1",
			port,
			portOwner: "probably another sign-in or the Codex CLI",
			check: issuedClient,
		},
	);
	const clientId = issuedClient(authorization);
	const what = "The sign-in's token exchange";
	const json = await postForm(
		`${authUrl(options)}/api/accounts/oauth/token`,
		{
			grant_type: "authorization_code",
			client_id: clientId,
			code: authorization.code,
			code_verifier: pkce.verifier,
			redirect_uri: redirectUri,
			resource: RESOURCE,
		},
		{ ...options, ...(signal ? { signal } : {}), what },
	);
	return credentialOf(json, clientId, what);
}

/** New tokens from the client that signed in; an `OpenAiAuthError` with `expired` when refused. */
export async function refreshChatGpt(
	credential: OAuthCredential & { clientId?: unknown },
	options: ChatGptAuthOptions = {},
): Promise<ChatGptCredential> {
	const clientId = typeof credential.clientId === "string" ? credential.clientId : "";
	if (clientId === "")
		throw new OpenAiAuthError("the ChatGPT sign-in has no client to refresh it: sign in again", true);
	const what = "Refreshing the ChatGPT sign-in";
	const json = await postForm(
		`${authUrl(options)}/api/accounts/oauth/token`,
		{ grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh, resource: RESOURCE },
		{ ...options, what },
	);
	return credentialOf(json, clientId, what);
}
