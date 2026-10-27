// A stdio MCP server for the tests. Its environment says how it behaves:
// MCP_PID_FILE gets its pid, MCP_STDERR is written to stderr at start, MCP_EXIT exits with that code at start,
// MCP_INSTRUCTIONS are its instructions. Tools: echo, big (MCP_BIG_CHARS of text), fail, image, slow.
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const env = process.env;
if (env.MCP_PID_FILE) writeFileSync(env.MCP_PID_FILE, String(process.pid));
if (env.MCP_STDERR) process.stderr.write(`${env.MCP_STDERR}\n`);
if (env.MCP_EXIT) process.exit(Number(env.MCP_EXIT));

const server = new McpServer(
	{ name: "fixture", version: "1.0.0" },
	env.MCP_INSTRUCTIONS ? { instructions: env.MCP_INSTRUCTIONS } : {},
);
server.registerTool(
	"echo",
	{ description: "Echo the text back", inputSchema: { text: z.string() } },
	async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool("big", { description: "Return a large text" }, async () => ({
	content: [{ type: "text", text: `start-${"x".repeat(Number(env.MCP_BIG_CHARS ?? 50_000))}-end` }],
}));
server.registerTool("fail", { description: "Always fail" }, async () => ({
	content: [{ type: "text", text: "it failed on purpose" }],
	isError: true,
}));
server.registerTool("image", { description: "Return a tiny image" }, async () => ({
	content: [{ type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }],
}));
server.registerTool("slow", { description: "Wait a long time" }, async () => {
	await new Promise((resolve) => setTimeout(resolve, 60_000));
	return { content: [{ type: "text", text: "late" }] };
});
await server.connect(new StdioServerTransport());
