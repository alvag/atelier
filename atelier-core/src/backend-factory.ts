import type { AgentBackend } from "./backend.ts";
import { AnthropicApiBackend, type AnthropicApiBackendOptions } from "./backends/anthropic-api/backend.ts";
import { ClaudeCodeBackend, type ClaudeCodeBackendOptions } from "./backends/claude-code/backend.ts";
import { resolveApiKey } from "./credentials.ts";
import type { BackendName } from "./protocol/types.ts";

export interface BackendFactoryOptions {
	claudeCode?: ClaudeCodeBackendOptions;
	anthropicApi?: Omit<AnthropicApiBackendOptions, "apiKey">;
	/** Injected in tests; defaults to the environment, then the Keychain. */
	resolveApiKey?: () => Promise<string>;
}

/** Builds a backend by name. Only anthropic-api reads the API key; Claude Code uses the subscription. */
export async function createBackend(name: BackendName, options: BackendFactoryOptions = {}): Promise<AgentBackend> {
	if (name === "claude-code") return new ClaudeCodeBackend(options.claudeCode);
	const apiKey = await (options.resolveApiKey ?? (() => resolveApiKey()))();
	return new AnthropicApiBackend({ ...options.anthropicApi, apiKey });
}
