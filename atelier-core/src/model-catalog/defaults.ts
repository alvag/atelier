import { AuthStore, authFile } from "../auth-store.ts";
import { CodexAccess, codexVariantFrom } from "../backends/openai-codex/access.ts";
import { apiKeySource, openCodeGoKeySource, resolveApiKey, type SecurityRunner } from "../credentials.ts";
import { modelsDevSource } from "./models-dev.ts";
import { anthropicModelsSource, codexModelsSource, openCodeGoModelsSource } from "./providers.ts";
import type { CatalogSource } from "./store.ts";

/** `ATELIER_MODEL_REFRESH=off`: the model lists come from the code and the cache, and nothing is asked. */
export function modelRefreshEnabled(env: Record<string, string | undefined>): boolean {
	return env.ATELIER_MODEL_REFRESH !== "off";
}

export interface CatalogSourcesOptions {
	home: string;
	env: Record<string, string | undefined>;
	/**
	 * The user asked for this refresh (`atelier models --refresh`): a key in the macOS Keychain may be read, which can
	 * show the Keychain's dialog. A background refresh never reads one.
	 */
	interactive?: boolean;
	/** Injected in tests. */
	platform?: NodeJS.Platform;
	runSecurity?: SecurityRunner;
	urls?: { modelsDev?: string; anthropic?: string; openCodeGo?: string; codex?: string };
}

const withSignIn = (source: CatalogSource, available: () => Promise<boolean>): CatalogSource => ({
	...source,
	available,
});

/**
 * What a refresh asks: models.dev, with no credential, and each provider the user is signed in to, as `/model` finds
 * them: the Keychain is asked only whether it holds a key, never for it, unless the user asked for the refresh. A
 * provider's credential is read only once it is due and signed in to, and never leaves for another host. With
 * `ATELIER_LOGIN_CHECK=off` no credential is read, so only models.dev is asked.
 */
export function defaultCatalogSources(options: CatalogSourcesOptions): CatalogSource[] {
	const { urls = {} } = options;
	const modelsDev = modelsDevSource(urls.modelsDev === undefined ? {} : { url: urls.modelsDev });
	if (options.env.ATELIER_LOGIN_CHECK === "off") return [modelsDev];
	const store = new AuthStore(authFile(options.home));
	const keys = {
		env: options.env,
		store,
		...(options.platform === undefined ? {} : { platform: options.platform }),
		...(options.runSecurity === undefined ? {} : { runSecurity: options.runSecurity }),
	};
	// A background refresh takes the key from the environment or auth.json only: a Keychain read may show a dialog.
	const usableKey = async () => {
		const source = await apiKeySource(keys);
		return source !== undefined && (source !== "keychain" || options.interactive === true);
	};
	const variant = codexVariantFrom(options.env);
	const codex = () => new CodexAccess({ store, ...(variant === undefined ? {} : { variant }) });
	return [
		modelsDev,
		withSignIn(
			anthropicModelsSource({
				// Another platform than darwin makes resolveApiKey skip the Keychain: a background read never runs `security -w`.
				apiKey: () =>
					resolveApiKey(options.interactive === true ? keys : { ...keys, platform: "linux" }).catch(() => undefined),
				...(urls.anthropic === undefined ? {} : { baseUrl: urls.anthropic }),
			}),
			usableKey,
		),
		withSignIn(
			openCodeGoModelsSource(urls.openCodeGo === undefined ? {} : { baseUrl: urls.openCodeGo }),
			async () => openCodeGoKeySource(keys) !== undefined,
		),
		withSignIn(
			codexModelsSource({
				headers: () => codex().catalogHeaders(),
				...(urls.codex === undefined ? {} : { baseUrl: urls.codex }),
			}),
			async () => codex().catalogSignedIn(),
		),
	];
}
