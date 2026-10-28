import { AuthStore, authFile } from "../auth-store.ts";
import { CodexAccess, codexVariantFrom } from "../backends/openai-codex/access.ts";
import { openCodeGoKeySource, resolveApiKey } from "../credentials.ts";
import { modelsDevSource } from "./models-dev.ts";
import { anthropicModelsSource, codexModelsSource, openCodeGoModelsSource } from "./providers.ts";
import type { CatalogSource } from "./store.ts";

/** `ATELIER_MODEL_REFRESH=off`: the model lists come from the code and the cache, and nothing is asked. */
export function modelRefreshEnabled(env: Record<string, string | undefined>): boolean {
	return env.ATELIER_MODEL_REFRESH !== "off";
}

/**
 * What a refresh asks: models.dev, with no credential, and each provider the user is signed in to, with the credential
 * its backend already uses. A credential is read only when its source is due, and never leaves for another host.
 */
export function defaultCatalogSources(options: {
	home: string;
	env: Record<string, string | undefined>;
}): CatalogSource[] {
	const store = new AuthStore(authFile(options.home));
	const keys = { env: options.env, store };
	const variant = codexVariantFrom(options.env);
	return [
		modelsDevSource(),
		anthropicModelsSource({ apiKey: () => resolveApiKey(keys).catch(() => undefined) }),
		openCodeGoModelsSource({ signedIn: async () => openCodeGoKeySource(keys) !== undefined }),
		codexModelsSource({
			headers: () => new CodexAccess({ store, ...(variant === undefined ? {} : { variant }) }).catalogHeaders(),
		}),
	];
}
