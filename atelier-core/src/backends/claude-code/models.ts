import { currentModelData } from "../../model-catalog/current.ts";
import type { ModelData } from "../../model-catalog/model-data.ts";

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
	if (resolvedClaudeCodeList(data) === undefined) return CODE_ALIASES[model] ?? model;
	return data.model("claude-code", model)?.aliases?.[0] ?? model;
}

/**
 * The subscription's list, once a session listed it with the aliases resolved: versioned ids only, and some kept with
 * the alias that stands for it, as `supportedModels()` always lists `opus`. Undefined before, for a list kept in an
 * older format too, which is asked again.
 */
export function resolvedClaudeCodeList(data: ModelData): readonly string[] | undefined {
	const listed = data.listed("claude-code");
	if (listed === undefined || listed.length === 0 || !listed.every(isVersionedClaudeId)) return undefined;
	return listed.some((id) => (data.model("claude-code", id)?.aliases?.length ?? 0) > 0) ? listed : undefined;
}

/**
 * The versioned id a name stands for, so an alias finds the levels of its model: the one the subscription's list
 * keeps the alias with, else the code's; any other name is its own.
 */
export function claudeCodeIdOf(name: string): string {
	const data = currentModelData();
	const id = resolvedClaudeCodeList(data)?.find((model) => data.model("claude-code", model)?.aliases?.includes(name));
	if (id !== undefined) return id;
	return Object.keys(CODE_ALIASES).find((id) => CODE_ALIASES[id] === name) ?? name;
}

/**
 * The aliases that stand for `ids` now, each with the id it stands for, so a client marks the model an alias in use
 * runs: the subscription's list says them, else the code's.
 */
export function claudeCodeAliases(ids: readonly string[]): Record<string, string> {
	const data = currentModelData();
	const resolved = resolvedClaudeCodeList(data) !== undefined;
	const aliases: Record<string, string> = {};
	for (const id of ids) {
		const names = resolved ? (data.model("claude-code", id)?.aliases ?? []) : [CODE_ALIASES[id]];
		for (const name of names) if (name !== undefined && !Object.hasOwn(aliases, name)) aliases[name] = id;
	}
	return aliases;
}
