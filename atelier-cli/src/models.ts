import { catalogFile, DynamicModelCatalog, defaultCatalogSources, modelRefreshOff, readCatalog } from "@atelier/core";
import { BACKEND_MODELS, BACKEND_NAMES } from "@atelier/core/protocol";

export interface ModelsIO {
	home: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
}

/**
 * `atelier models [--refresh]`: each backend's models as `/model` offers them, the code's list first, then the ones
 * its provider listed (`(new)`), with when that list was checked, and whether each takes images where the catalog
 * knows it (`images`, `text only`). Without --refresh it reads the cache and asks
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
			const images = (await catalog.model(backend, model))?.images;
			const marks = [
				...(own.includes(model) ? [] : ["(new)"]),
				...(images === undefined ? [] : [images ? "images" : "text only"]),
			];
			lines.push(`  ${[model, ...marks].join("  ")}`);
		}
	}
	io.stdout(`${lines.join("\n")}\n`);
	return 0;
}
