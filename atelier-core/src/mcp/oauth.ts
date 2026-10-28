import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { writeSecretFile } from "../secret-file.ts";
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
	/** Why the file is not 0600, when it could not be set to it; said in the servers' problems. */
	#problem: string | undefined;

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
		// Written 0600 in the hidden temporary folder and renamed over the file, never through a link.
		writeSecretFile(this.#file, `${JSON.stringify({ servers: all }, null, "\t")}\n`);
	}

	/** Why the file is not `0600`, when it could not be set to it (another user's file, a read-only mount). */
	problem(): string | undefined {
		return this.#problem;
	}

	/**
	 * A file another tool left readable by others is made the user's own again, whether it parses or not. When that
	 * fails, what was read is still used, and `problem` says so; it always says how the file is now, not how it was.
	 */
	#secure(): void {
		let mode: number;
		try {
			mode = statSync(this.#file).mode & 0o777;
		} catch {
			// No file, nothing readable by others.
			this.#problem = undefined;
			return;
		}
		if (mode === 0o600) {
			this.#problem = undefined;
			return;
		}
		try {
			chmodSync(this.#file, 0o600);
			this.#problem = undefined;
		} catch (error) {
			this.#problem = `${this.#file} is not 0600 (it is 0${mode.toString(8)}) and could not be set to it: ${(error as Error).message}`;
		}
	}

	/** Every token and client secret seen, to hide wherever it could show. */
	secrets(): string[] {
		this.#read();
		return [...this.#seen];
	}

	#read(): Record<string, Credentials> {
		this.#secure();
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
	/** A sign-in that stopped (aborted, or cancelled by a sign-out) saves nothing more. */
	readonly #signal: AbortSignal | undefined;
	#verifier: string | undefined;
	/** The `state` sent with the authorization request, to check the browser's answer against. */
	expectedState: string | undefined;

	constructor(
		server: HttpServerConfig,
		store: McpAuthStore,
		options: { redirectUrl?: string; onRedirect?: (url: URL) => void | Promise<void>; signal?: AbortSignal } = {},
	) {
		this.#signal = options.signal;
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
		if (this.#signal?.aborted) return;
		const redirectUrl = this.redirectUrl;
		this.#store.update(this.#server, (credentials) => ({ ...credentials, client, redirectUrl }));
	}

	tokens(): OAuthTokens | undefined {
		return this.#store.get(this.#server)?.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		if (this.#signal?.aborted) return;
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
	/** Stops waiting for the browser. */
	signal?: AbortSignal;
}

/** Opens a page in the user's browser; rejects naming the page when it cannot. */
export function openInBrowser(url: URL): Promise<void> {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url.href]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url.href]]
				: ["xdg-open", [url.href]];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
		child.once("error", (error) =>
			reject(new Error(`could not open the browser (${error.message}); open ${url.href}`)),
		);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
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
	// The whole sign-in, the first connection included, stops on abort or timeout, and the callback closes then.
	const deadline = stopAt(options.timeoutMs ?? LOGIN_TIMEOUT_MS, options.signal);
	const guarded = <T>(work: Promise<T>) => Promise.race([work, deadline.stopped]);
	const stop = { signal: deadline.signal };
	try {
		// A client registered with another redirect URI cannot use this one; a new sign-in starts without old tokens.
		store.update(server, ({ client, redirectUrl }) =>
			client !== undefined && redirectUrl === callback.url ? { client, redirectUrl } : {},
		);
		const provider = new McpOAuthProvider(server, store, {
			redirectUrl: callback.url,
			onRedirect: options.openBrowser,
			...stop,
		});
		const transport = httpTransport(server, provider) as Transport & { finishAuth(code: string): Promise<void> };
		const first = new Client({ name: "atelier", version: VERSION });
		try {
			await guarded(first.connect(transport, { timeout: server.timeoutMs }));
			await first.close();
			return;
		} catch (error) {
			if (!(error instanceof UnauthorizedError)) {
				await first.close().catch(() => {});
				throw error;
			}
		}
		const answer = await guarded(callback.answer);
		if (answer.error !== undefined) throw new Error(`the authorization server refused the sign-in: ${answer.error}`);
		if (answer.state !== provider.expectedState) throw new Error("the sign-in answer does not match the request");
		await guarded(transport.finishAuth(answer.code ?? ""));
		await first.close().catch(() => {});
		const check = new Client({ name: "atelier", version: VERSION });
		// The timeout or the abort cuts it, and a refresh answered after either saves nothing.
		const checked = new McpOAuthProvider(server, store, stop);
		try {
			await guarded(check.connect(httpTransport(server, checked), { timeout: server.timeoutMs, ...stop }));
		} finally {
			await check.close().catch(() => {});
		}
	} finally {
		deadline.clear();
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

/**
 * When the sign-in times out or is aborted: `stopped` rejects (with the abort's reason when it is an error) and
 * `signal` aborts with the same error, for the work the race alone would leave running.
 */
function stopAt(
	ms: number,
	signal: AbortSignal | undefined,
): { stopped: Promise<never>; signal: AbortSignal; clear: () => void } {
	const stop = new AbortController();
	const timer = setTimeout(() => stop.abort(new Error(`no answer from the browser in ${Math.round(ms / 1000)} s`)), ms);
	const onAbort = () =>
		stop.abort(
			signal?.reason instanceof Error ? signal.reason : new Error("the sign-in stopped: the MCP servers closed"),
		);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const stopped = new Promise<never>((_resolve, reject) => {
		if (stop.signal.aborted) reject(stop.signal.reason);
		else stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true });
	});
	// Nobody may be waiting on it when it fires.
	stopped.catch(() => {});
	return {
		stopped,
		signal: stop.signal,
		clear: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}
