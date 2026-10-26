import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every `node:` module a file reaches through its relative imports, type-only imports excluded. */
function nodeImports(entry: string): string[] {
	const found = new Set<string>();
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const text = readFileSync(file, "utf8");
		for (const [, typeOnly, from] of text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
			if (typeOnly !== undefined || from === undefined) continue;
			if (from.startsWith("node:")) found.add(`${file.slice(src.length + 1)} → ${from}`);
			else if (from.startsWith(".")) visit(resolve(dirname(file), from));
		}
	};
	visit(join(src, entry));
	return [...found];
}

// The desktop renderer bundles these entries for the browser: they must not pull in Node's modules.
it.each(["protocol/index.ts", "text.ts"])("%s reaches no node: module", (entry) => {
	expect(nodeImports(entry)).toEqual([]);
});
