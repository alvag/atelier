import { openCodeGoModel } from "./backends/opencode-go/models.ts";
import { currentModelData } from "./model-catalog/current.ts";
import { BACKEND_DEFAULTS, BACKEND_MODELS } from "./options.ts";
import { BACKEND_NAMES } from "./protocol/types.ts";

/** Explicit offline fallbacks, never a guess from a model name's prefix. Catalog false always wins. */
export function imageInputProblem(backend: string, requested?: string): string | undefined {
	const id = BACKEND_NAMES.find((name) => name === backend);
	const model = requested ?? (id === undefined ? "default" : BACKEND_DEFAULTS[id]);
	const unsupported = `Image input is not supported by ${backend}/${model}.`;
	if (id === undefined) return unsupported;
	// These transports are enabled only once their image conversion is implemented.
	if (id === "openai-codex" || (id === "opencode-go" && openCodeGoModel(model).protocol !== "anthropic-messages"))
		return unsupported;
	const data = currentModelData();
	const alias = data
		.listed(id)
		?.map((name) => data.model(id, name))
		.find((entry) => entry?.aliases?.includes(model));
	const known = data.model(id, model) ?? alias;
	const fallback =
		((id === "anthropic-api" || id === "claude-code") && BACKEND_MODELS[id].includes(model)) ||
		(id === "claude-code" && ["opus", "sonnet", "haiku"].includes(model)) ||
		(id === "opencode-go" && model === "claude-haiku-5-5");
	const supported = known?.images ?? (fallback ? true : undefined);
	if (supported === true) return undefined;
	return supported === false ? unsupported : `Image input support is unknown for ${backend}/${model}.`;
}
