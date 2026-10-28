import type { Effort } from "../../events.ts";
import { currentModelData } from "../../model-catalog/current.ts";
import type { ThinkingLevel } from "../../profiles/index.ts";

/** The models the ChatGPT subscription serves to Codex; the first is the default. Another name still works. */
export const CODEX_MODELS = [
	"gpt-6-sol",
	"gpt-6.1-sol",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;
export const DEFAULT_CODEX_MODEL: string = CODEX_MODELS[0];
/** The window both endpoints serve for these models. */
export const CODEX_CONTEXT_WINDOW = 272_000;

/** What the Codex catalog says of a model the list above lacks. */
const catalogModel = (model: string) =>
	(CODEX_MODELS as readonly string[]).includes(model) ? undefined : currentModelData().model("openai-codex", model);

/** The model's window: the one above, or the Codex catalog's for a model the list lacks. */
export function codexContextWindow(model: string): number {
	return catalogModel(model)?.contextWindow ?? CODEX_CONTEXT_WINDOW;
}

/** Models whose reasoning cannot be turned off: `off` is not sent to them. */
const ALWAYS_REASONS: ReadonlySet<string> = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

/** What a thinking level sends as `reasoning.effort`, and what `session_started.effort` says about it. */
export interface CodexReasoning {
	report: Effort | "off" | "unsupported";
	/** The API's effort: one of Atelier's levels, or `none` to turn reasoning off. */
	effort?: Effort | "none";
}

/**
 * The reasoning effort for a profile level: nothing when none was asked, so the model reasons as it does by
 * default. `minimal` is sent as `low`, as pi does; `off` is `none`, except where the model always reasons. A model
 * only the Codex catalog knows takes the levels it lists.
 */
export function codexReasoning(model: string, level: ThinkingLevel | undefined): CodexReasoning | undefined {
	if (level === undefined) return undefined;
	if (level === "off") return ALWAYS_REASONS.has(model) ? { report: "unsupported" } : { report: "off", effort: "none" };
	const effort = level === "minimal" ? "low" : level;
	const levels = catalogModel(model)?.efforts;
	return levels === undefined || levels.includes(effort) ? { report: effort, effort } : { report: "unsupported" };
}
