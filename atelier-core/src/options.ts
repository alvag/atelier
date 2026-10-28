import { OPENCODE_GO_MODELS } from "./backends/opencode-go/models.ts";
import type { BackendName } from "./protocol/types.ts";

/**
 * The models a client offers for each backend; the first one is the backend's default. A name outside the list
 * still works: it is a convenience for selectors, not a limit. Pure: the desktop renderer imports it.
 */
export const BACKEND_MODELS: Readonly<Record<BackendName, readonly string[]>> = Object.freeze({
	"claude-code": ["opus", "sonnet", "haiku"],
	"anthropic-api": ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
	// The table's first model is the default, minimax-m3.
	"opencode-go": Object.keys(OPENCODE_GO_MODELS),
});
