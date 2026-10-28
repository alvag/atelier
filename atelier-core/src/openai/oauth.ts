import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

/** How long a sign-in waits for the browser or the pasted URL before it gives up. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
export const CALLBACK_PATH = "/auth/callback";

/** What a sign-in needs from whoever runs it: the CLI on a terminal, the line-by-line session or the TUI. */
export interface OAuthInteraction {
	/** Opens the sign-in page; a failure only means the user opens the URL that `show` gave. */
	openBrowser(url: string): Promise<void>;
	/** Tells the user something: the URL to open, the device code. */
	show(text: string): void;
	/**
	 * Asks for the redirect URL (or the code) the browser ended on; `signal` aborts the question when the browser
	 * answered first. Undefined when the user cancelled.
	 */
	askPasted(prompt: string, signal: AbortSignal): Promise<string | undefined>;
	/**
	 * Offers to cancel while a device code waits: resolves when the user cancels; `signal` aborts the offer when the
	 * sign-in ended first. Without it, only `signal` cancels.
	 */
	waitOrCancel?(prompt: string, signal: AbortSignal): Promise<void>;
	/** Cancels the sign-in. */
	signal?: AbortSignal;
}

/** A sign-in or a refresh the auth server refused; `expired` when signing in again is the way out. */
export class OpenAiAuthError extends Error {
	override name = "OpenAiAuthError";
	readonly code = "openai_auth_error";
	readonly expired: boolean;

	constructor(message: string, expired = false) {
		super(message);
		this.expired = expired;
	}
}

export interface Pkce {
	verifier: string;
	challenge: string;
}

export function createPkce(): Pkce {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const randomState = (): string => randomBytes(16).toString("hex");

/** The claims of a JWT, or undefined when it is not one. Nothing is verified: the server that issued it is trusted. */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** What the browser's redirect carried. */
export interface Authorization {
	code: string;
	/** Every parameter of the redirect, for flows that read more than the code. */
	params: URLSearchParams;
}

/**
 * Whether pasted text is a redirect (a URL, or its query) rather than a bare code: a redirect names its sign-in's state,
 * or its error. A bare code may hold `=` (base64 padding), so `=` alone does not make a query.
 */
export function isPastedRedirect(text: string): boolean {
	return ["code=", "state=", "error=", "://"].some((mark) => text.includes(mark));
}

/** A pasted redirect URL, query string or bare code; a redirect must carry the sign-in's `state`. */
export function parsePasted(input: string, state: string): Authorization {
	const value = input.trim();
	let params: URLSearchParams;
	let bare = false;
	try {
		params = new URL(value).searchParams;
	} catch {
		bare = !isPastedRedirect(value);
		params = bare ? new URLSearchParams({ code: value }) : new URLSearchParams(value);
	}
	const error = params.get("error");
	if (error !== null) throw new OpenAiAuthError(`the sign-in failed: ${redirectError(params)}`);
	// A redirect says which sign-in it answers: one without the state could be another's, so only a bare code may lack it.
	const given = params.get("state");
	if (!bare && given !== state)
		throw new OpenAiAuthError(
			given === null
				? "the pasted URL has no state: paste the whole URL the browser ended on"
				: "the pasted URL belongs to another sign-in (state mismatch)",
		);
	const code = params.get("code");
	if (!code) throw new OpenAiAuthError("the pasted text has no authorization code");
	return { code, params };
}

/** A redirect's error and its description, with the code it carried hidden: a description may repeat it. */
function redirectError(params: URLSearchParams): string {
	const said = [params.get("error"), params.get("error_description")].filter((part) => part !== null).join(": ");
	const code = params.get("code");
	return code ? said.replaceAll(code, "[code]") : said;
}

interface Callback {
	answer: Promise<Authorization>;
	close(): void;
}

/** A loopback server for the browser's redirect; requests of another sign-in (another state) are answered and ignored. */
async function listenForCallback(host: string, port: number, state: string): Promise<Callback> {
	let settle: (authorization: Authorization) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const answer = new Promise<Authorization>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== CALLBACK_PATH) return void response.writeHead(404).end();
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const reply = (status: number, text: string) =>
			response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
		if (url.searchParams.get("state") !== state)
			return void reply(400, "Atelier: this is not the sign-in it waits for.");
		if (error !== null || !code) {
			const said = error === null ? "no code" : redirectError(url.searchParams);
			reply(400, `Atelier: the sign-in failed (${said}).`);
			return fail(new OpenAiAuthError(`the sign-in failed: ${said}`));
		}
		reply(200, "Atelier: signed in. You can close this tab.");
		settle({ code, params: url.searchParams });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		answer,
		close: () => {
			// close() alone keeps the browser's spare connections, which a later sign-in's redirect could reach.
			server.closeAllConnections();
			server.close();
		},
	};
}

export interface BrowserSignIn {
	/** The authorize URL, built once the redirect URI is known. */
	url: string;
	state: string;
	host: string;
	port: number;
	/** Who holds the port when it is taken, for the message. */
	portOwner: string;
	/** Checks what the browser's redirect carried, beyond the state (the issued client id, ...). */
	check?: (authorization: Authorization) => void;
}

/**
 * Opens the sign-in page and waits for whichever comes first: the browser's redirect to the loopback server, or the
 * URL the user pastes. When the port is taken, only the pasted URL can finish it.
 */
export async function waitForAuthorization(
	interaction: OAuthInteraction,
	signIn: BrowserSignIn,
): Promise<Authorization> {
	// Without the loopback server only the pasted URL finishes the sign-in: the port is taken, or not one to listen on.
	let unreachable: string | undefined;
	const callback = await listenForCallback(signIn.host, signIn.port, signIn.state).catch(
		(error: NodeJS.ErrnoException) => {
			unreachable =
				error.code === "EADDRINUSE"
					? `Port ${signIn.port} is in use (${signIn.portOwner})`
					: `Atelier cannot listen on port ${signIn.port} (${error.code ?? error.message})`;
			return undefined;
		},
	);
	const asking = new AbortController();
	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const cancelled = AbortSignal.any([timeout, ...(interaction.signal ? [interaction.signal] : [])]);
	try {
		interaction.show(`Sign in at: ${signIn.url}`);
		if (unreachable !== undefined)
			interaction.show(
				`${unreachable}: after signing in, the browser cannot reach Atelier. Copy the URL the browser ends on and paste it here.`,
			);
		await interaction.openBrowser(signIn.url).catch(() => {});
		const pasted = interaction
			.askPasted(
				"Paste the redirect URL (or the code) if the browser does not finish by itself",
				AbortSignal.any([asking.signal, cancelled]),
			)
			.then((input) => {
				if (input === undefined)
					throw new OpenAiAuthError(timeout.aborted ? "the sign-in timed out" : "the sign-in was cancelled");
				return parsePasted(input, signIn.state);
			});
		const aborted = new Promise<never>((_resolve, reject) =>
			cancelled.addEventListener(
				"abort",
				() => reject(new OpenAiAuthError(timeout.aborted ? "the sign-in timed out" : "the sign-in was cancelled")),
				{ once: true },
			),
		);
		const authorization = await Promise.race([...(callback ? [callback.answer] : []), pasted, aborted]);
		signIn.check?.(authorization);
		return authorization;
	} finally {
		asking.abort();
		callback?.close();
	}
}

/** Posts a form to a token endpoint and returns its JSON; a refusal becomes an `OpenAiAuthError` without the body's secrets. */
export async function postForm(
	url: string,
	form: Record<string, string>,
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; what: string },
): Promise<Record<string, unknown>> {
	return readJson(
		await request(options, url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form).toString(),
		}),
		options.what,
	);
}

export async function postJson(
	url: string,
	body: unknown,
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; what: string },
): Promise<Response> {
	return request(options, url, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function request(
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; what: string },
	url: string,
	init: RequestInit,
): Promise<Response> {
	try {
		return await (options.fetch ?? fetch)(url, { ...init, ...(options.signal ? { signal: options.signal } : {}) });
	} catch (error) {
		if (options.signal?.aborted) throw new OpenAiAuthError("the sign-in was cancelled");
		throw new OpenAiAuthError(`${options.what} could not reach ${new URL(url).host}: ${(error as Error).message}`);
	}
}

/** The error code of an OAuth error body: `{error: "x"}` or `{error: {code: "x"}}`. */
export function errorCode(json: unknown): string | undefined {
	const error = (json as { error?: unknown } | null)?.error;
	if (typeof error === "string") return error;
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

export async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
	const text = await response.text().catch(() => "");
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	if (!response.ok) {
		const code = errorCode(json);
		// Only the code: the body of a token endpoint may echo what was sent.
		throw new OpenAiAuthError(
			`${what} failed (${response.status}${code ? `, ${code}` : ""})`,
			response.status === 400 || response.status === 401,
		);
	}
	if (typeof json !== "object" || json === null || Array.isArray(json))
		throw new OpenAiAuthError(`${what} answered something that is not a JSON object`);
	return json as Record<string, unknown>;
}

/** The access and refresh tokens of a token response, and when the access token expires. */
export function tokensOf(
	json: Record<string, unknown>,
	what: string,
): { access: string; refresh: string; expires: number } {
	const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = json;
	if (typeof access !== "string" || access === "" || typeof refresh !== "string" || refresh === "")
		throw new OpenAiAuthError(`${what} answered without tokens`);
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
		throw new OpenAiAuthError(`${what} answered without a valid expires_in`);
	return { access, refresh, expires: Date.now() + expiresIn * 1000 };
}

/** Polls `poll` every `intervalMs` (at least `minIntervalMs`) until it returns a value, or the deadline passes. */
export async function pollUntil<T>(
	poll: () => Promise<T | "pending" | "slow_down">,
	options: { intervalMs: number; minIntervalMs: number; deadlineMs: number; signal?: AbortSignal },
): Promise<T> {
	let interval = Math.max(options.minIntervalMs, options.intervalMs);
	const deadline = Date.now() + options.deadlineMs;
	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new OpenAiAuthError("the sign-in was cancelled");
		const result = await poll();
		if (result === "slow_down") interval += 5_000;
		else if (result !== "pending") return result;
		await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, {
			...(options.signal ? { signal: options.signal } : {}),
		}).catch(() => {
			throw new OpenAiAuthError("the sign-in was cancelled");
		});
	}
	throw new OpenAiAuthError("the device code expired before the sign-in finished");
}
