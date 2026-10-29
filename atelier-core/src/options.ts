import { CLAUDE_CODE_MODELS } from "./backends/claude-code/models.ts";
import { CODEX_MODELS } from "./backends/openai-codex/models.ts";
import { OPENCODE_GO_MODELS } from "./backends/opencode-go/models.ts";
import type { BackendName } from "./protocol/types.ts";

/**
 * The models a client offers for each backend; the first one is the backend's default. A name outside the list
 * still works: it is a convenience for selectors, not a limit. Pure: the desktop renderer imports it.
 */
export const BACKEND_MODELS: Readonly<Record<BackendName, readonly string[]>> = Object.freeze({
	// Versioned ids; the aliases (`opus`, `sonnet`) still work written.
	"claude-code": CLAUDE_CODE_MODELS,
	"anthropic-api": ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
	// The table's first model is the default, minimax-m3.
	"opencode-go": Object.keys(OPENCODE_GO_MODELS),
	"openai-codex": CODEX_MODELS,
});

/**
 * Where the model lists come from: `options.list` asks it for every backend, so a catalog that also asks the providers'
 * APIs replaces this one without changing a client.
 */
export interface ModelCatalog {
	models(backend: BackendName): Promise<readonly string[]>;
}

/** The lists written in the code, `BACKEND_MODELS`. */
export const BASE_CATALOG: ModelCatalog = Object.freeze({
	models: async (backend: BackendName) => BACKEND_MODELS[backend],
});
