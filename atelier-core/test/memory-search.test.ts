import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { connectEngram, type EngramMemory } from "../src/memory/engram.ts";
import { FakeMemory } from "../src/memory/port.ts";
import { createMemoryTool } from "../src/memory/tool.ts";
import { ToolInputError } from "../src/tools/types.ts";

let root: string;
let memory: EngramMemory | undefined;
beforeEach(async () => {
	root = await mkdtemp(new URL(".memory-search-", import.meta.url).pathname);
	await writeFile(join(root, "calls.jsonl"), "");
});
afterEach(async () => {
	await memory?.close();
	memory = undefined;
	await rm(root, { recursive: true, force: true });
});

async function tool(support = "supported") {
	memory = await connectEngram({
		cwd: root,
		command: new URL("fixtures/memory/engram.mjs", import.meta.url).pathname,
		env: { ...process.env, TEST_MATCH_MODE: support, TEST_CALL_LOG: join(root, "calls.jsonl") },
	});
	return createMemoryTool(memory);
}

async function searches() {
	const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });
	return calls.filter((call) => call.name === "mem_search").map((call) => call.arguments);
}

const context = { cwd: process.cwd() };
const found = "#7 [decision] MCP transport — Use stdio";

describe("memory search against fake Engram", () => {
	it("offers the match modes and the exact one-retry rule to the model", async () => {
		const offered = await tool();
		expect(offered.description).toBe(
			[
				"Long-term memory of project proj, shared across sessions.",
				"search (query, match_mode?): find earlier decisions, fixes and discoveries. match_mode is all by default (every word must match); any matches any word. If a search with all finds no results, retry once with the same query and match_mode: any before concluding there is no memory. Do not retry an empty any search or a failed search. get (id): read one in full.",
				"save (title, type, content, topicKey?): keep verified knowledge worth knowing next time, one memory per topic, as **What** / **Why** / **Where** / **Learned**. The same topicKey replaces that memory, so keep its still-valid facts. Never save secrets.",
			].join("\n"),
		);
		const schema = z.toJSONSchema(z.object(offered.inputShape), { io: "input" });
		expect(schema.properties?.match_mode).toMatchObject({
			type: "string",
			enum: ["all", "any"],
			description: "search: all (default) requires every word; any matches any word",
		});
		expect(schema.required).not.toContain("match_mode");
		await expect(
			offered.execute({ action: "search", query: "MCP", match_mode: "neither" }, context),
		).rejects.toBeInstanceOf(ToolInputError);
		expect(await searches()).toEqual([]);
	});

	it.each([undefined, "all"])("uses strict matching for %s, preserving defaults and explicit limits", async (mode) => {
		const offered = await tool();
		const result = await offered.execute({ action: "search", query: "MCP unrelated", match_mode: mode }, context);
		expect(result).toMatchObject({ ok: true, output: 'No memories match "MCP unrelated".', summary: "no results" });
		expect(
			await offered.execute({ action: "search", query: "MCP", match_mode: mode, limit: 2 }, context),
		).toMatchObject({ ok: true, output: found, summary: "1 result" });
		expect(await searches()).toEqual([
			{ query: "MCP unrelated", limit: 10, match_mode: "all", response_format: "compact" },
			{ query: "MCP", limit: 2, match_mode: "all", response_format: "compact" },
		]);
	});

	it("returns the memory on a second, explicitly broader call, without retrying inside the adapter", async () => {
		const offered = await tool();
		const input = { action: "search", query: "MCP unrelated", limit: 3 };
		expect(await offered.execute(input, context)).toMatchObject({
			ok: true,
			output: 'No memories match "MCP unrelated".',
		});
		expect(await searches()).toHaveLength(1);
		expect(await offered.execute({ ...input, match_mode: "any" }, context)).toMatchObject({
			ok: true,
			output: found,
			summary: "1 result",
		});
		expect(await searches()).toEqual([
			{ query: input.query, limit: 3, match_mode: "all", response_format: "compact" },
			{ query: input.query, limit: 3, match_mode: "any", response_format: "compact" },
		]);
	});

	it("does not retry an empty any search", async () => {
		const offered = await tool();
		expect(
			await offered.execute({ action: "search", query: "absent missing", match_mode: "any" }, context),
		).toMatchObject({ ok: true, output: 'No memories match "absent missing".', summary: "no results" });
		expect(await searches()).toEqual([
			{ query: "absent missing", limit: 10, match_mode: "any", response_format: "compact" },
		]);
	});

	it.each(["absent", "no-properties"])(
		"detects %s support from tools/list, not the version number",
		async (support) => {
			const offered = await tool(support);
			for (const mode of [undefined, "all"]) {
				expect(await offered.execute({ action: "search", query: "MCP", match_mode: mode }, context)).toMatchObject({
					ok: true,
					output: found,
				});
			}
			expect(
				await offered.execute({ action: "search", query: "MCP unrelated", match_mode: "any" }, context),
			).toMatchObject({
				ok: false,
				output: "Memory failed: This Engram does not support match_mode: any; update it to use broader search.",
			});
			expect(await searches()).toEqual([
				{ query: "MCP", limit: 10, response_format: "compact" },
				{ query: "MCP", limit: 10, response_format: "compact" },
			]);
		},
	);

	it("reports a service failure rather than no memory, without retrying", async () => {
		const offered = await tool();
		expect(await offered.execute({ action: "search", query: "failure" }, context)).toMatchObject({
			ok: false,
			output: 'Memory failed: Engram mem_search: {"error":"search unavailable"}',
		});
		expect(await searches()).toHaveLength(1);
	});
});

it("keeps FakeMemory's public search results consistent with both match modes", async () => {
	const memory = new FakeMemory("proj");
	await memory.save({ title: "MCP transport", type: "decision", content: "Use stdio" });
	const offered = createMemoryTool(memory);
	expect(await offered.execute({ action: "search", query: "stdio MCP" }, context)).toMatchObject({
		ok: true,
		output: "#1 [decision] MCP transport — Use stdio",
	});
	expect(await offered.execute({ action: "search", query: "MCP unrelated" }, context)).toMatchObject({
		ok: true,
		summary: "no results",
	});
	expect(await offered.execute({ action: "search", query: "MCP unrelated", match_mode: "any" }, context)).toMatchObject(
		{ ok: true, output: "#1 [decision] MCP transport — Use stdio" },
	);
});
