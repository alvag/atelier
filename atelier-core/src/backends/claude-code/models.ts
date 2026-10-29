import { currentModelData } from "../../model-catalog/current.ts";

/**
 * The models `claude-code` offers until a session lists the subscription's: the ones its aliases `opus`, `sonnet` and
 * `haiku` stand for, which every plan has. Pure: the desktop renderer imports it.
 */
export const CLAUDE_CODE_MODELS: readonly string[] = Object.freeze([
	"claude-opus-5-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
]);

/** The alias that stands for each of the code's models, until a session lists what the aliases stand for. */
const CODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	"claude-opus-5-5": "opus",
	"claude-sonnet-5-5": "sonnet",
	"claude-haiku-5-5": "haiku",
});

/** Claude Code's ids are all `claude-...`: a name without that is an alias. */
export const isVersionedClaudeId = (id: string): boolean => id.startsWith("claude-");

/** The model an id is, without the `[1m]` that asks Claude Code for a 1M window. */
export const withoutWindow = (id: string): string => id.replace(/\[1m\]$/i, "");

/**
 * What Claude Code is sent for `model`: the alias that stands for it now, when one does, since only the alias gets the
 * 1M window where the plan has it (a bare id runs with 200K); anything else as it is. The subscription's list says
 * which, once a session listed it with the aliases resolved; until then, the code's.
 */
export function claudeCodeName(model: string): string {
	const data = currentModelData();
	const listed = data.listed("claude-code");
	if (listed === undefined || !listed.every(isVersionedClaudeId)) return CODE_ALIASES[model] ?? model;
	return data.model("claude-code", model)?.aliases?.[0] ?? model;
}
