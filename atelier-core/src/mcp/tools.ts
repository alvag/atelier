import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeError } from "../events.ts";
import { defineTool, type ToolDefinition } from "../tools/types.ts";
import type { McpManager } from "./manager.ts";

export const MCP_SEARCH_TOOL = "mcp_search";
export const MCP_CALL_TOOL = "mcp_call";

const DEFAULT_LIMIT = 5;

/**
 * The two fixed tools that reach every MCP server: the declared tools never change while servers connect, so the
 * prompt stays cached and every backend sees the same list.
 */
export function createMcpTools(manager: McpManager): ToolDefinition[] {
	const search = defineTool({
		name: MCP_SEARCH_TOOL,
		description:
			"Finds tools of the user's MCP servers by words of their name or description, and returns each match as server/tool, its description and its JSON input schema. Run one with mcp_call.",
		inputShape: {
			query: z.string().describe('Words to look for; "*" lists every tool'),
			server: z.string().optional().describe("Only this server's tools"),
			limit: z.number().int().min(1).max(20).optional().describe(`How many tools, ${DEFAULT_LIMIT} by default`),
		},
		async execute({ query, server, limit }) {
			await manager.ready(server);
			const statuses = manager.status().filter((status) => server === undefined || status.name === server);
			if (server !== undefined && statuses.length === 0) {
				const output = `No MCP server named "${server}".`;
				return { ok: false, output, summary: output, truncated: false };
			}
			const matches = rank(
				manager,
				statuses.map((status) => status.name),
				query,
			).slice(0, limit ?? DEFAULT_LIMIT);
			const unreachable = statuses
				.filter((status) => status.state !== "connected")
				.map(
					(status) =>
						`${status.name} (${status.state}${status.error === undefined ? "" : `: ${firstLine(status.error)}`})`,
				);
			const parts = matches.map(({ server: name, tool }) => describeTool(name, tool));
			if (parts.length === 0) parts.push(`No MCP tool matches "${query}".`);
			if (unreachable.length > 0) parts.push(`Not reachable: ${unreachable.join(", ")}`);
			return {
				ok: true,
				output: parts.join("\n\n"),
				summary: `"${query}" (${matches.length} tools)`,
				truncated: false,
			};
		},
	});
	const call = defineTool({
		name: MCP_CALL_TOOL,
		description:
			"Runs a tool of the user's MCP servers: server and tool as mcp_search names them, and arguments that follow its input schema.",
		inputShape: {
			server: z.string(),
			tool: z.string(),
			arguments: z.record(z.string(), z.unknown()).optional(),
		},
		async execute({ server, tool, arguments: args }, context) {
			const summary = `${server} › ${tool}`;
			let result: CallToolResult;
			try {
				result = await manager.call(server, tool, args ?? {}, context.signal);
			} catch (error) {
				return { ok: false, output: `MCP call failed: ${describeError(error)}`, summary, truncated: false };
			}
			return { ok: result.isError !== true, output: resultText(result), summary, truncated: false };
		},
	});
	return [search, call];
}

/** The tools of these servers that match the query's words, best first; every tool for an empty query or `*`. */
function rank(manager: McpManager, servers: readonly string[], query: string): { server: string; tool: Tool }[] {
	const words = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word !== "");
	const scored: { server: string; tool: Tool; score: number }[] = [];
	for (const server of servers) {
		for (const tool of manager.tools(server)) {
			const name = tool.name.toLowerCase();
			const description = (tool.description ?? "").toLowerCase();
			let score = words.length === 0 ? 1 : 0;
			for (const word of words) {
				if (name.includes(word)) score += 3;
				if (description.includes(word)) score += 1;
				if (server.toLowerCase().includes(word)) score += 1;
			}
			if (score > 0) scored.push({ server, tool, score });
		}
	}
	return scored.sort((a, b) => b.score - a.score);
}

function describeTool(server: string, tool: Tool): string {
	const description = tool.description?.trim();
	return [
		`${server}/${tool.name}${description ? ` — ${description}` : ""}`,
		`input: ${JSON.stringify(tool.inputSchema)}`,
	].join("\n");
}

/** What the model reads of a result: its text, or its structured content when it has no text. */
function resultText(result: CallToolResult): string {
	const parts = result.content.map((block) => (block.type === "text" ? block.text : `[${block.type} content omitted]`));
	if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
	return parts.join("\n");
}

/** The servers in the system prompt: byte-stable, from the configuration only. Empty without servers. */
export function mcpPromptBlock(manager: McpManager): string {
	const listed = manager.status().filter((status) => status.state !== "disabled" && status.state !== "invalid");
	if (listed.length === 0) return "";
	return [
		`MCP servers the user configured. Their tools are not declared: find them with ${MCP_SEARCH_TOOL} and run them with ${MCP_CALL_TOOL}.`,
		...listed.map(
			({ name, description }) =>
				`- ${name}: ${description ?? `no description yet; ${MCP_SEARCH_TOOL} lists its tools`}`,
		),
	].join("\n");
}

/**
 * The first line of the instructions of servers without a description that connected since the last call, for the
 * next prompt; undefined when there is none. `given` keeps the servers already told, so each is told once.
 */
export function mcpInstructionsNote(manager: McpManager, given: Set<string>): string | undefined {
	const lines: string[] = [];
	for (const { name, description } of manager.status()) {
		if (description !== undefined || given.has(name)) continue;
		const instructions = manager.instructions(name);
		if (instructions === undefined) continue;
		given.add(name);
		lines.push(`- ${name}: ${firstLine(instructions)}`);
	}
	if (lines.length === 0) return undefined;
	return [
		"<mcp_servers>",
		"First lines of the instructions of MCP servers that connected:",
		...lines,
		"</mcp_servers>",
	].join("\n");
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}
