import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryPromptsEnabled } from "../src/index.ts";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-memory-settings-"));
	await mkdir(join(home, ".atelier"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const settings = (content: string | Record<string, unknown>) =>
	writeFile(
		join(home, ".atelier", "settings.json"),
		typeof content === "string" ? content : JSON.stringify({ kind: "atelier.settings", version: 1, ...content }),
	);

describe("memoryPromptsEnabled", () => {
	it("saves prompts by default, also when settings.json says nothing about memory", async () => {
		expect(await memoryPromptsEnabled({}, home)).toEqual({ enabled: true });
		await settings({ tui: { fullscreen: false } });
		expect(await memoryPromptsEnabled({}, home)).toEqual({ enabled: true });
		await settings({ memory: { prompts: true } });
		expect(await memoryPromptsEnabled({}, home)).toEqual({ enabled: true });
	});

	it("is off with ATELIER_MEMORY_PROMPTS=off or memory.prompts false", async () => {
		expect(await memoryPromptsEnabled({ ATELIER_MEMORY_PROMPTS: "off" }, home)).toEqual({ enabled: false });
		await settings({ memory: { prompts: false } });
		expect(await memoryPromptsEnabled({}, home)).toEqual({ enabled: false });
	});

	it("is off when it cannot tell what the user chose, and says why", async () => {
		const path = join(home, ".atelier", "settings.json");
		const off = (reason: string) => ({
			enabled: false,
			warning: `${path}: ${reason}; your prompts are not saved to memory`,
		});
		await settings({ memory: { prompts: "no" } });
		expect(await memoryPromptsEnabled({}, home)).toEqual(off('"memory.prompts" must be true or false'));
		await settings({ memory: "off" });
		expect(await memoryPromptsEnabled({}, home)).toEqual(off('"memory" must be an object'));
		await settings("{ not json");
		expect(await memoryPromptsEnabled({}, home)).toEqual(off("not valid JSON"));
		await writeFile(path, JSON.stringify({ kind: "other", version: 1 }));
		expect(await memoryPromptsEnabled({}, home)).toEqual(off('expected kind "atelier.settings" and version 1'));
	});
});
