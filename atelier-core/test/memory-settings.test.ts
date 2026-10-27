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
		expect(await memoryPromptsEnabled({}, home)).toBe(true);
		await settings({ tui: { fullscreen: false } });
		expect(await memoryPromptsEnabled({}, home)).toBe(true);
		await settings({ memory: { prompts: true } });
		expect(await memoryPromptsEnabled({}, home)).toBe(true);
	});

	it("is off with ATELIER_MEMORY_PROMPTS=off or memory.prompts false", async () => {
		expect(await memoryPromptsEnabled({ ATELIER_MEMORY_PROMPTS: "off" }, home)).toBe(false);
		await settings({ memory: { prompts: false } });
		expect(await memoryPromptsEnabled({}, home)).toBe(false);
	});

	it("is off when it cannot tell what the user chose", async () => {
		await settings({ memory: { prompts: "no" } });
		expect(await memoryPromptsEnabled({}, home)).toBe(false);
		await settings({ memory: "off" });
		expect(await memoryPromptsEnabled({}, home)).toBe(false);
		await settings("{ not json");
		expect(await memoryPromptsEnabled({}, home)).toBe(false);
	});
});
