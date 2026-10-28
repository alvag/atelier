import type { AgentBackend } from "./backend.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "./backends/anthropic-api/backend.ts";
import { ClaudeCodeBackend, type ClaudeCodeBackendOptions } from "./backends/claude-code/backend.ts";
import { createOpenCodeGoBackend, type OpenCodeGoBackendOptions } from "./backends/opencode-go/backend.ts";
import { resolveApiKey, resolveOpenCodeGoKey } from "./credentials.ts";
import type { BackendName } from "./protocol/types.ts";

export interface BackendFactoryOptions {
	claudeCode?: ClaudeCodeBackendOptions;
	anthropicApi?: Omit<AnthropicApiBackendOptions, "apiKey">;
	/** Defaults to the `anthropicApi` options that both loops share (`compactAt`). */
	opencodeGo?: Omit<OpenCodeGoBackendOptions, "apiKey">;
	/** Injected in tests; defaults to the environment, then the Keychain. */
	resolveApiKey?: () => Promise<string>;
	/** Injected in tests; defaults to OPENCODE_API_KEY, then `auth.json`. */
	resolveOpenCodeGoKey?: () => Promise<string>;
}

/** Builds a backend by name. anthropic-api and opencode-go read their API key; Claude Code uses the subscription. */
export async function createBackend(name: BackendName, options: BackendFactoryOptions = {}): Promise<AgentBackend> {
	if (name === "claude-code") return new ClaudeCodeBackend(options.claudeCode);
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
