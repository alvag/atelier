import type { ModelUsage, SDKControlGetContextUsageResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContextUsage } from "../../events.ts";
import { withoutWindow } from "./models.ts";

/** The model of Claude Code's own messages, such as an API error it reports as an answer: no request was made. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * How full the context of a Claude Code session is, from the messages it sends: what the last main-thread request
 * carried (input, cache read and cache write; the answer's `output_tokens` is only partial in those messages), against
 * the window the turn's result says the model ran with. Claude Code keeps the conversation and compacts it on its own,
 * so right after it compacts the size is unknown until an answer measures it again.
 */
export class ContextTracker {
	#tokens: number | undefined;
	#unknown = false;
	#model: string | undefined;
	#window: number | undefined;
	/** Where Claude Code compacts the model in use, once it said so; the window until then. */
	compactAt: number | undefined;

	observe(message: SDKMessage): void {
		if (message.type === "assistant") {
			const { model, usage } = message.message ?? {};
			if (message.parent_tool_use_id !== null || model === SYNTHETIC_MODEL || !usage) return;
			this.#tokens =
				(usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
			this.#unknown = false;
			this.#model = model;
		} else if (message.type === "system" && message.subtype === "compact_boundary") {
			this.#tokens = message.compact_metadata.post_tokens ?? 0;
			this.#unknown = true;
		} else if (message.type === "result" && this.#model !== undefined) {
			this.#window = windowOf(message.modelUsage, this.#model) ?? this.#window;
		}
	}

	/** Undefined until an answer was measured and Claude Code said its model's window. */
	usage(): ContextUsage | undefined {
		if (this.#tokens === undefined || this.#window === undefined) return undefined;
		return {
			tokens: this.#tokens,
			window: this.#window,
			compactAt: this.compactAt ?? this.#window,
			...(this.#unknown ? { unknown: true as const } : {}),
		};
	}
}

/** The window `model` ran with, under its own key or one with `[1m]`, or by the canonical id the entry names. */
function windowOf(usage: Record<string, ModelUsage> | undefined, model: string): number | undefined {
	const wanted = withoutWindow(model);
	for (const [key, entry] of Object.entries(usage ?? {})) {
		if (withoutWindow(entry.canonicalModel ?? key) !== wanted && withoutWindow(key) !== wanted) continue;
		if (Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0) return entry.contextWindow;
	}
	return undefined;
}

/** Where Claude Code says it compacts, when it compacts on its own and says where. */
export function compactThresholdOf(
	usage: Pick<SDKControlGetContextUsageResponse, "isAutoCompactEnabled" | "autoCompactThreshold">,
): number | undefined {
	const at = usage.autoCompactThreshold;
	return usage.isAutoCompactEnabled && Number.isSafeInteger(at) && at !== undefined && at > 0 ? at : undefined;
}
