import {
	catalogFile,
	DynamicModelCatalog,
	defaultCatalogSources,
	modelDetail,
	modelRefreshOff,
	readCatalog,
} from "@atelier/core";
import { BACKEND_MODELS, BACKEND_NAMES } from "@atelier/core/protocol";

export interface ModelsIO {
	home: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
}

/**
 * `atelier models [--refresh]`: each backend's models as `/model` offers them, newest first, the ones only its provider
 * listed marked `(new)`, with when that list was checked, and what the catalog knows of each: its long name, its window
 * and whether it takes images (`Claude Opus 5.5 · 1M context · images`). Without --refresh it reads the cache and asks
 * nothing; --refresh asks every source now, Claude Code aside, whose sessions list its models.
 */
export async function runModels(options: { refresh?: true }, io: ModelsIO): Promise<number> {
	const file = catalogFile(io.home);
	const off = modelRefreshOff(io.env);
	const network = off === undefined;
	const catalog = new DynamicModelCatalog({
		file,
		// Asked for by the user: a key in the Keychain may be read for --refresh.
		sources: defaultCatalogSources({ home: io.home, env: io.env, interactive: options.refresh === true }),
		network,
	});
	if (options.refresh) {
		if (!network) io.stdout(`${off}: nothing was asked.\n`);
		else {
			const outcomes = await catalog.refresh({ force: true });
			const said = Object.entries(outcomes).map(([source, outcome]) => `${source} ${outcome}`);
			io.stdout(`Refreshed: ${said.join(", ")}.\n`);
		}
	}
	const { sources } = await readCatalog(file);
	const lines: string[] = [];
	for (const backend of BACKEND_NAMES) {
		const checkedAt = sources[backend]?.checkedAt;
		const origin = checkedAt === undefined ? "the code's list" : `listed ${new Date(checkedAt).toISOString()}`;
		lines.push(`${backend} · ${origin}`);
		const own: readonly string[] = BACKEND_MODELS[backend];
		for (const model of await catalog.models(backend)) {
			const known = await catalog.model(backend, model);
			const detail = known === undefined ? undefined : modelDetail(known);
			const marks = [...(own.includes(model) ? [] : ["(new)"]), ...(detail === undefined ? [] : [detail])];
			lines.push(`  ${[model, ...marks].join("  ")}`);
		}
	}
	io.stdout(`${lines.join("\n")}\n`);
	return 0;
}
