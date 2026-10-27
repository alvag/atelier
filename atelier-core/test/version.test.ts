import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";

const manifests = [
	"package.json",
	"atelier-core/package.json",
	"atelier-cli/package.json",
	"atelier-desktop/package.json",
];
const root = new URL("../../", import.meta.url);

describe("VERSION", () => {
	it("is a semantic version", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("is the version of the repository and of every package", async () => {
		for (const manifest of manifests) {
			const { version } = JSON.parse(await readFile(new URL(manifest, root), "utf8"));
			expect(version, manifest).toBe(VERSION);
		}
	});
});
