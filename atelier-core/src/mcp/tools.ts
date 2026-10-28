import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeError } from "../events.ts";
import { createScratchDir } from "../scratch.ts";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import type { McpManager } from "./manager.ts";

export const MCP_SEARCH_TOOL = "mcp_search";
export const MCP_CALL_TOOL = "mcp_call";

const DEFAULT_LIMIT = 5;
/** Text results longer than this reach the model with their middle cut out; the whole text goes to a file. */
export const MAX_RESULT_CHARS = 20_000;

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
			// Names and descriptions come from the servers: a secret in them is hidden like anywhere else.
			return {
				ok: true,
				output: manager.hide(parts.join("\n\n")),
				summary: manager.hide(`"${query}" (${matches.length} tools)`),
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
		// Only `auto` judges an MCP call, through the classifier; `normal` and `yolo` run it.
		async gate({ server, tool, arguments: args }) {
			if (!manager.status().some((status) => status.name === server)) return {};
			await manager.ready(server);
			const found = manager.tools(server).find((candidate) => candidate.name === tool);
			return {
				approval: {
					command: manager.hide(`${server} › ${tool} ${JSON.stringify(args ?? {})}`),
					tool: MCP_CALL_TOOL,
					classifyOnly: true,
					classifierTool: manager.hide(classifierText(server, tool, found)),
					denial: "The user denied this MCP call.",
				},
			};
		},
		async execute({ server, tool, arguments: args }, { signal, scratchDir }) {
			const summary = manager.hide(`${server} › ${tool}`);
			let result: CallToolResult;
			try {
				result = await manager.call(server, tool, args ?? {}, signal);
			} catch (error) {
				return { ok: false, output: `MCP call failed: ${describeError(error)}`, summary, truncated: false };
			}
			const files = filesDir(scratchDir);
			// The result comes from the server: a secret in it is hidden, in the file of a long one too.
			const text = manager.hide(await resultText(result, files));
			return { ok: result.isError !== true, summary, ...(await cut(text, files)) };
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

/** What the classifier reads about the tool: an MCP tool of a server, what it says it does and its input. */
function classifierText(server: string, tool: string, found: Tool | undefined): string {
	return [
		`${MCP_CALL_TOOL}: the tool "${tool}" of the user's MCP server "${server}", which runs outside the sandbox`,
		...(found?.description ? [`Description: ${found.description.trim()}`] : []),
		...(found ? [`Input schema: ${JSON.stringify(found.inputSchema)}`] : ["The server did not list this tool."]),
	].join("\n");
}

/** Where a call's files go, made on first use. */
type FilesDir = () => Promise<string>;

/**
 * The session scratch directory, or else one directory of the call's own that outlives this process until a sweep,
 * created only when a file is saved.
 */
function filesDir(scratchDir: string | undefined): FilesDir {
	if (scratchDir !== undefined) return async () => scratchDir;
	let own: Promise<string> | undefined;
	return () => {
		own ??= createScratchDir("mcp").then((scratch) => scratch.path);
		return own;
	};
}

/**
 * What the model reads of a result: its text blocks, or its structured content when it has no content. Images, audio
 * and binary resources are saved to the scratch directory, and the model is told where.
 */
async function resultText(result: CallToolResult, files: FilesDir): Promise<string> {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image" || block.type === "audio")
			parts.push(await saved(block.type, block.mimeType, block.data, files));
		else if (block.type === "resource_link") parts.push(`[resource link: ${block.uri}]`);
		else if (block.type === "resource") {
			const { resource } = block;
			if ("text" in resource && typeof resource.text === "string") parts.push(resource.text);
			else if ("blob" in resource && typeof resource.blob === "string")
				parts.push(await saved("resource", resource.mimeType ?? "application/octet-stream", resource.blob, files));
		}
	}
	if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
	return parts.join("\n");
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"audio/wav": "wav",
	"audio/mpeg": "mp3",
};

async function saved(kind: string, mimeType: string, base64: string, files: FilesDir): Promise<string> {
	const bytes = Buffer.from(base64, "base64");
	const path = join(await files(), `mcp-${randomBytes(6).toString("hex")}.${EXTENSIONS[mimeType] ?? "bin"}`);
	await writeFile(path, bytes);
	return `[${kind} ${mimeType}, ${bytes.length} bytes, saved to ${path}]`;
}

/** The text as the model gets it: whole when short, else its start and end around a marker, the whole text in a file. */
async function cut(
	text: string,
	files: FilesDir,
): Promise<Pick<ToolOutcome, "output" | "truncated" | "fullOutputPath">> {
	if (text.length <= MAX_RESULT_CHARS) return { output: text, truncated: false };
	const path = join(await files(), `mcp-${randomBytes(6).toString("hex")}.txt`);
	await writeFile(path, text);
	const half = MAX_RESULT_CHARS / 2;
	const removed = text.length - 2 * half;
	return {
		output: `${text.slice(0, half)}\n…${removed} chars truncated…\n${text.slice(-half)}\n\nThe full result is in ${path}; read it with read.`,
		truncated: true,
		fullOutputPath: path,
	};
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
