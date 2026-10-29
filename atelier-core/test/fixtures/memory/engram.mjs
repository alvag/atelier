#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.argv[2] === "version") {
	console.log("engram 3.6.0");
	process.exit(0);
}

const support = process.env.TEST_MATCH_MODE;
const properties = support === "supported" ? { match_mode: { type: "string" } } : {};
const server = new Server({ name: "engram", version: "3.6.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		"mem_current_project", "mem_context", "mem_search", "mem_get_observation", "mem_save", "mem_session_summary",
	].map((name) => ({
		name,
		inputSchema: support === "no-properties" ? { type: "object" } : { type: "object", properties },
	})),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
	appendFileSync(process.env.TEST_CALL_LOG, `${JSON.stringify(params)}\n`);
	const args = params.arguments ?? {};
	let answer = {};
	let isError = false;
	if (params.name === "mem_current_project") answer = { project: "proj" };
	if (params.name === "mem_search") {
		if (args.query === "failure") {
			answer = { error: "search unavailable" };
			isError = true;
		} else if (support !== "supported" && "match_mode" in args) {
			answer = { error: "unknown argument match_mode" };
			isError = true;
		} else {
			const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
			const matches = words.map((word) => "MCP transport".toLowerCase().includes(word));
			const found = args.match_mode === "any" ? matches.some(Boolean) : matches.every(Boolean);
			answer = { results: found ? [{ id: 7, type: "decision", title: "MCP transport", preview: "Use stdio" }] : [] };
		}
	}
	return { content: [{ type: "text", text: JSON.stringify(answer) }], isError };
});
await server.connect(new StdioServerTransport());
