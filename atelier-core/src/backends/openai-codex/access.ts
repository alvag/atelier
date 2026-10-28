import type { AuthStore, Credential } from "../../auth-store.ts";
import { CHATGPT_PROVIDER, refreshChatGpt } from "../../openai/chatgpt-auth.ts";
import { CODEX_PROVIDER, codexAccountId, refreshCodex } from "../../openai/codex-auth.ts";
import { OpenAiAuthError } from "../../openai/oauth.ts";
import type { ResponsesEndpoint } from "../../responses/client.ts";

/** `legacy`: ChatGPT's Codex endpoint with the Codex client's sign-in; `chatgpt`: api.openai.com with Sign in with ChatGPT. */
export type CodexVariant = "legacy" | "chatgpt";
export const CODEX_VARIANTS: readonly CodexVariant[] = ["legacy", "chatgpt"];

export const CODEX_URL = "https://chatgpt.com/backend-api";
export const OPENAI_URL = "https://api.openai.com/v1";
/** A token closer than this to its expiry is refreshed before a request. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 20_000;

const PROVIDER: Record<CodexVariant, string> = { legacy: CODEX_PROVIDER, chatgpt: CHATGPT_PROVIDER };

/** No sign-in for the variant, or one OpenAI refused: signing in again is the way out. */
export class NotSignedInError extends Error {
	override name = "NotSignedInError";
	readonly code = "not_logged_in";
}

/** ATELIER_CODEX_VARIANT: `legacy` or `chatgpt` forces that sign-in; unset lets the session choose. */
export function codexVariantFrom(env: Record<string, string | undefined>): CodexVariant | undefined {
	const value = env.ATELIER_CODEX_VARIANT?.trim();
	if (value === undefined || value === "") return undefined;
	if (!CODEX_VARIANTS.includes(value as CodexVariant))
		throw new Error(`ATELIER_CODEX_VARIANT must be ${CODEX_VARIANTS.join(" or ")}, got ${JSON.stringify(value)}.`);
	return value as CodexVariant;
}

export function loginCommand(variant: CodexVariant): string {
	return `/login account ${PROVIDER[variant]} (or atelier login account ${PROVIDER[variant]})`;
}

export const NOT_SIGNED_IN_MESSAGE = `Not signed in to ChatGPT for Codex: use ${loginCommand("legacy")}, or Sign in with ChatGPT with /login account ${CHATGPT_PROVIDER}.`;

export interface CodexAccessOptions {
	store: AuthStore;
	/** Forced by ATELIER_CODEX_VARIANT; otherwise legacy when signed in to it, then chatgpt. */
	variant?: CodexVariant;
	authUrl?: string;
	codexUrl?: string;
	openaiUrl?: string;
	fetch?: typeof globalThis.fetch;
	/** Retries of the Responses client; tests lower the wait. */
	baseDelayMs?: number;
}

/**
 * The signed-in variant a session sends its requests with, and its tokens: refreshed under the store's lock when they
 * are about to expire, or when OpenAI refused the one sent.
 */
export class CodexAccess {
	readonly #options: CodexAccessOptions;
	#variant: CodexVariant | undefined;
	/** The access token of the last request, so a refusal refreshes that one and not a newer one. */
	#sent: string | undefined;

	constructor(options: CodexAccessOptions) {
		this.#options = options;
		this.#variant = options.variant;
	}

	/** The variant the next request uses; throws `NotSignedInError` when there is none. */
	get variant(): CodexVariant {
		const variant = this.#variant ?? CODEX_VARIANTS.find((each) => this.#stored(each) !== undefined);
		if (variant === undefined || this.#stored(variant) === undefined)
			throw new NotSignedInError(
				variant === undefined
					? NOT_SIGNED_IN_MESSAGE
					: `Not signed in for the ${variant} variant: use ${loginCommand(variant)}.`,
			);
		return variant;
	}

	/** Moves to Sign in with ChatGPT when the Codex endpoint refuses Atelier; false when there is nothing to move to. */
	fallBack(): boolean {
		if (this.#options.variant !== undefined || this.variant !== "legacy" || this.#stored("chatgpt") === undefined)
			return false;
		this.#variant = "chatgpt";
		return true;
	}

	/** Refreshes the token OpenAI refused, unless another process already replaced it. */
	async renew(): Promise<void> {
		const rejected = this.#sent;
		await this.#fresh(this.variant, (credential) => credential.access === rejected);
	}

	/** The endpoint of the current variant; its headers carry a token fresh at each attempt. */
	endpoint(sessionId: string): ResponsesEndpoint {
		const variant = this.variant;
		const base = {
			...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
			...(this.#options.baseDelayMs === undefined ? {} : { baseDelayMs: this.#options.baseDelayMs }),
		};
		if (variant === "chatgpt")
			return {
				...base,
				url: `${this.#options.openaiUrl ?? OPENAI_URL}/responses`,
				headers: async () => ({ authorization: `Bearer ${(await this.#fresh(variant)).access}` }),
			};
		return {
			...base,
			url: `${this.#options.codexUrl ?? CODEX_URL}/codex/responses`,
			headers: async () => {
				const credential = await this.#fresh(variant);
				const accountId =
					typeof credential.accountId === "string" ? credential.accountId : codexAccountId(credential.access);
				return {
					authorization: `Bearer ${credential.access}`,
					"chatgpt-account-id": accountId ?? "",
					"OpenAI-Beta": "responses=experimental",
					originator: "atelier",
					"session-id": sessionId,
				};
			},
		};
	}

	/** Every token this session may send, to hide them from messages. */
	secrets(): string[] {
		return CODEX_VARIANTS.flatMap((variant) => {
			const credential = this.#stored(variant);
			return credential === undefined ? [] : [credential.access, credential.refresh];
		});
	}

	#stored(variant: CodexVariant): (Credential & { type: "oauth" }) | undefined {
		const credential = this.#options.store.get(PROVIDER[variant]);
		return credential?.type === "oauth" ? credential : undefined;
	}

	async #fresh(
		variant: CodexVariant,
		refused: (credential: Credential & { type: "oauth" }) => boolean = () => false,
	): Promise<Credential & { type: "oauth"; accountId?: unknown }> {
		const options = {
			...(this.#options.authUrl ? { authUrl: this.#options.authUrl } : {}),
			...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		};
		let credential: Credential | undefined;
		try {
			credential = await this.#options.store.refreshed(
				PROVIDER[variant],
				(stored) => stored.type === "oauth" && (stored.expires - Date.now() < REFRESH_MARGIN_MS || refused(stored)),
				(stored) => {
					if (stored.type !== "oauth") throw new OpenAiAuthError("the stored credential is not a sign-in", true);
					return variant === "legacy" ? refreshCodex(stored.refresh, options) : refreshChatGpt(stored, options);
				},
			);
		} catch (error) {
			if (error instanceof OpenAiAuthError && error.expired)
				throw new NotSignedInError(`The ChatGPT sign-in expired (${error.message}): use ${loginCommand(variant)}.`);
			throw error;
		}
		if (credential?.type !== "oauth") throw new NotSignedInError(`Not signed in: use ${loginCommand(variant)}.`);
		this.#sent = credential.access;
		return credential;
	}
}
