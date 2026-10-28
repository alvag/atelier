import { homedir } from "node:os";
import { AuthStore, authFile } from "./auth-store.ts";
import type { AgentBackend } from "./backend.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "./backends/anthropic-api/backend.ts";
import { ClaudeCodeBackend, type ClaudeCodeBackendOptions } from "./backends/claude-code/backend.ts";
import { CODEX_VARIANTS, type CodexVariant } from "./backends/openai-codex/access.ts";
import { OpenAiCodexBackend, type OpenAiCodexBackendOptions } from "./backends/openai-codex/backend.ts";
import { createOpenCodeGoBackend, type OpenCodeGoBackendOptions } from "./backends/opencode-go/backend.ts";
import { resolveApiKey, resolveOpenCodeGoKey } from "./credentials.ts";
import type { BackendName } from "./protocol/types.ts";

export interface BackendFactoryOptions {
	claudeCode?: ClaudeCodeBackendOptions;
	anthropicApi?: Omit<AnthropicApiBackendOptions, "apiKey">;
	/** Defaults to the `anthropicApi` options that both loops share (`compactAt`). */
	opencodeGo?: Omit<OpenCodeGoBackendOptions, "apiKey">;
	/** The store defaults to `~/.atelier/auth.json`; the variant to ATELIER_CODEX_VARIANT. */
	openaiCodex?: Partial<OpenAiCodexBackendOptions>;
	/** Where ATELIER_CODEX_VARIANT is read; this process's environment by default. */
	env?: Record<string, string | undefined>;
	/** Injected in tests; defaults to the environment, then the Keychain. */
	resolveApiKey?: () => Promise<string>;
	/** Injected in tests; defaults to OPENCODE_API_KEY, then `auth.json`. */
	resolveOpenCodeGoKey?: () => Promise<string>;
}

/** ATELIER_CODEX_VARIANT: `legacy` or `chatgpt` forces that sign-in; unset lets the backend choose. */
function codexVariant(env: Record<string, string | undefined>): CodexVariant | undefined {
	const value = env.ATELIER_CODEX_VARIANT?.trim();
	if (value === undefined || value === "") return undefined;
	if (!CODEX_VARIANTS.includes(value as CodexVariant))
		throw new Error(`ATELIER_CODEX_VARIANT must be ${CODEX_VARIANTS.join(" or ")}, got ${JSON.stringify(value)}.`);
	return value as CodexVariant;
}

/**
 * Builds a backend by name. anthropic-api and opencode-go read their API key; Claude Code uses the Claude subscription
 * and openai-codex the ChatGPT sign-in stored by `atelier login`, which it reads at each request.
 */
export async function createBackend(name: BackendName, options: BackendFactoryOptions = {}): Promise<AgentBackend> {
	if (name === "claude-code") return new ClaudeCodeBackend(options.claudeCode);
	if (name === "openai-codex") {
		const variant = codexVariant(options.env ?? process.env);
		return new OpenAiCodexBackend({
			store: new AuthStore(authFile(homedir())),
			...(variant === undefined ? {} : { variant }),
			...options.openaiCodex,
		});
	}
	if (name === "opencode-go") {
		const apiKey = await (options.resolveOpenCodeGoKey ?? (() => resolveOpenCodeGoKey()))();
		const { compactAt } = options.anthropicApi ?? {};
		return createOpenCodeGoBackend({
			...(compactAt === undefined ? {} : { compactAt }),
			...options.opencodeGo,
			apiKey,
		});
	}
	const apiKey = await (options.resolveApiKey ?? (() => resolveApiKey()))();
	return new AnthropicApiBackend({ ...options.anthropicApi, apiKey });
}
