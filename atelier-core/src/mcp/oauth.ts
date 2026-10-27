import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { VERSION } from "../version.ts";
import type { HttpServerConfig } from "./config.ts";

/** What a server's sign-in leaves: the registered client, the redirect URI it was registered with, and the tokens. */
interface Credentials {
	client?: OAuthClientInformationMixed;
	redirectUrl?: string;
	tokens?: OAuthTokens;
}

/** How long `loginMcpServer` waits for the browser to come back. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PATH = "/callback";

export function mcpAuthFile(home: string): string {
	return join(home, ".atelier", "mcp-auth.json");
}

/** Credentials belong to a server name and URL: the same URL under two names signs in twice. */
function authKey(server: HttpServerConfig): string {
	return `${server.name} ${server.url}`;
}

/** Whether the server's headers already authenticate it; OAuth is only for servers without an Authorization header. */
export function usesOAuth(server: HttpServerConfig): boolean {
	return !Object.keys(server.headers).some((name) => name.toLowerCase() === "authorization");
}

/**
 * The servers' OAuth credentials in `~/.atelier/mcp-auth.json`, which only the user can read or write (0600). Every
 * token and client secret it reads or writes is remembered, so it stays hidden after it is replaced or deleted.
 */
export class McpAuthStore {
	readonly #file: string;
	readonly #seen = new Set<string>();

	constructor(file: string) {
		this.#file = file;
	}

	get(server: HttpServerConfig): Credentials | undefined {
		return this.#read()[authKey(server)];
	}

	update(server: HttpServerConfig, change: (credentials: Credentials) => Credentials | undefined): void {
		const all = this.#read();
		const next = change(all[authKey(server)] ?? {});
		if (next === undefined) delete all[authKey(server)];
		else {
			all[authKey(server)] = next;
			this.#remember(next);
		}
		mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
		const temporary = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ servers: all }, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.#file);
	}

	/** Every token and client secret seen, to hide wherever it could show. */
	secrets(): string[] {
		this.#read();
		return [...this.#seen];
	}

	#read(): Record<string, Credentials> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch {
			return {};
		}
		const servers = (parsed as { servers?: unknown } | null)?.servers;
		if (typeof servers !== "object" || servers === null) return {};
		const all = servers as Record<string, Credentials>;
		for (const credentials of Object.values(all)) this.#remember(credentials);
		return all;
	}

	#remember({ client, tokens }: Credentials): void {
		for (const value of [tokens?.access_token, tokens?.refresh_token, tokens?.id_token, client?.client_secret])
			if (typeof value === "string" && value !== "") this.#seen.add(value);
	}
}

/**
 * The SDK's OAuth client for one server, kept in the store. Without `onRedirect` it never opens a page: a session
 * uses stored tokens and refreshes them, and a server that wants a new sign-in fails as needing one.
 */
export class McpOAuthProvider implements OAuthClientProvider {
	readonly #server: HttpServerConfig;
	readonly #store: McpAuthStore;
	readonly #redirectUrl: string | undefined;
	readonly #onRedirect: ((url: URL) => void | Promise<void>) | undefined;
	#verifier: string | undefined;
	/** The `state` sent with the authorization request, to check the browser's answer against. */
	expectedState: string | undefined;

	constructor(
		server: HttpServerConfig,
		store: McpAuthStore,
		options: { redirectUrl?: string; onRedirect?: (url: URL) => void | Promise<void> } = {},
	) {
		this.#server = server;
		this.#store = store;
		this.#redirectUrl = options.redirectUrl;
		this.#onRedirect = options.onRedirect;
	}

	get redirectUrl(): string {
		return this.#redirectUrl ?? this.#store.get(this.#server)?.redirectUrl ?? `http://127.0.0.1${CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		const oauth = this.#server.oauth;
		return {
			client_name: oauth?.clientName ?? "Atelier",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: oauth?.clientSecret === undefined ? "none" : "client_secret_post",
			...(oauth?.scope === undefined ? {} : { scope: oauth.scope }),
		};
	}

	state(): string {
		this.expectedState = randomBytes(16).toString("hex");
		return this.expectedState;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const oauth = this.#server.oauth;
		if (oauth?.clientId !== undefined)
			return {
				client_id: oauth.clientId,
				...(oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret }),
			};
		return this.#store.get(this.#server)?.client;
	}

	saveClientInformation(client: OAuthClientInformationMixed): void {
		const redirectUrl = this.redirectUrl;
		this.#store.update(this.#server, (credentials) => ({ ...credentials, client, redirectUrl }));
	}

	tokens(): OAuthTokens | undefined {
		return this.#store.get(this.#server)?.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.#store.update(this.#server, (credentials) => ({ ...credentials, tokens }));
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		await this.#onRedirect?.(url);
	}

	saveCodeVerifier(verifier: string): void {
		this.#verifier = verifier;
	}

	codeVerifier(): string {
		if (this.#verifier === undefined) throw new Error("No sign-in is under way for this server");
		return this.#verifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "verifier" || scope === "discovery") {
			if (scope === "verifier") this.#verifier = undefined;
			return;
		}
		this.#store.update(this.#server, (credentials) => {
			if (scope === "all") return undefined;
			const { [scope === "client" ? "client" : "tokens"]: _dropped, ...rest } = credentials;
			return rest;
		});
	}
}

/** The streamable HTTP transport of a server, with OAuth when a provider is given. */
export function httpTransport(server: HttpServerConfig, authProvider?: OAuthClientProvider): Transport {
	// The cast is for exactOptionalPropertyTypes, which the SDK's own types do not follow (`sessionId`).
	return new StreamableHTTPClientTransport(new URL(server.url), {
		requestInit: { headers: server.headers },
		...(authProvider === undefined ? {} : { authProvider }),
	}) as Transport;
}

export interface LoginOptions {
	/** Opens the authorization page; the browser comes back to a loopback callback. */
	openBrowser: (url: URL) => void | Promise<void>;
	timeoutMs?: number;
}

/**
 * Signs in to an HTTP server with OAuth: registers a client unless one is configured, opens the authorization page,
 * waits for the browser's answer on `http://127.0.0.1:<port>/callback`, keeps the tokens and checks that they connect.
 */
export async function loginMcpServer(
	server: HttpServerConfig,
	store: McpAuthStore,
	options: LoginOptions,
): Promise<void> {
	if (!usesOAuth(server)) throw new Error(`${server.name} has an Authorization header: it does not sign in with OAuth`);
	const stored = store.get(server);
	// A configured port is the registered redirect URI's; the port of an earlier registration is only preferred.
	const configured = server.oauth?.callbackPort;
	const callback = await listenForCallback(configured ?? portOf(stored?.redirectUrl), configured !== undefined);
	try {
		// A client registered with another redirect URI cannot use this one; a new sign-in starts without old tokens.
		store.update(server, ({ client, redirectUrl }) =>
			client !== undefined && redirectUrl === callback.url ? { client, redirectUrl } : {},
		);
		const provider = new McpOAuthProvider(server, store, {
			redirectUrl: callback.url,
			onRedirect: options.openBrowser,
		});
		const transport = httpTransport(server, provider) as Transport & { finishAuth(code: string): Promise<void> };
		const first = new Client({ name: "atelier", version: VERSION });
		try {
			await first.connect(transport, { timeout: server.timeoutMs });
			await first.close();
			return;
		} catch (error) {
			if (!(error instanceof UnauthorizedError)) throw error;
		}
		const answer = await withTimeout(callback.answer, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
		if (answer.error !== undefined) throw new Error(`the authorization server refused the sign-in: ${answer.error}`);
		if (answer.state !== provider.expectedState) throw new Error("the sign-in answer does not match the request");
		await transport.finishAuth(answer.code ?? "");
		await first.close().catch(() => {});
		const check = new Client({ name: "atelier", version: VERSION });
		await check.connect(httpTransport(server, new McpOAuthProvider(server, store)), { timeout: server.timeoutMs });
		await check.close();
	} finally {
		callback.close();
	}
}

/** Signs out: the server's client and tokens are deleted. */
export function logoutMcpServer(server: HttpServerConfig, store: McpAuthStore): void {
	store.update(server, () => undefined);
}

interface CallbackAnswer {
	code?: string;
	state?: string;
	error?: string;
}

/** A loopback server for the browser's answer, on `port`; unless `strict`, on any free port when that one is taken. */
async function listenForCallback(
	port: number | undefined,
	strict: boolean,
): Promise<{
	url: string;
	answer: Promise<CallbackAnswer>;
	close: () => void;
}> {
	let settle: (answer: CallbackAnswer) => void = () => {};
	const answer = new Promise<CallbackAnswer>((resolve) => {
		settle = resolve;
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== CALLBACK_PATH) return response.writeHead(404).end();
		const error = url.searchParams.get("error");
		response
			.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
			.end(error === null ? "Atelier: signed in. You can close this tab." : `Atelier: the sign-in failed (${error}).`);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		settle({
			...(code === null ? {} : { code }),
			...(state === null ? {} : { state }),
			...(error === null ? {} : { error: url.searchParams.get("error_description") ?? error }),
		});
	});
	const listen = (on: number) =>
		new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(on, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	try {
		await listen(port ?? 0);
	} catch (error) {
		if (port === undefined || strict) throw error;
		await listen(0);
	}
	const bound = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${bound}${CALLBACK_PATH}`,
		answer,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

function portOf(url: string | undefined): number | undefined {
	if (url === undefined) return undefined;
	try {
		const port = Number(new URL(url).port);
		return port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`no answer from the browser in ${Math.round(ms / 1000)} s`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
