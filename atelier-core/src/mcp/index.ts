import { type LoadMcpOptions, loadMcpConfig } from "./config.ts";
import { McpManager } from "./manager.ts";

export {
	type HttpServerConfig,
	type LoadMcpOptions,
	loadMcpConfig,
	type McpConfig,
	type McpServerConfig,
	mcpConfigFile,
	redact,
	type StdioServerConfig,
} from "./config.ts";
export { McpManager, type McpServerState, type McpServerStatus } from "./manager.ts";
export { MCP_CALL_TOOL, MCP_SEARCH_TOOL } from "./tools.ts";

/** Reads the user's configuration and starts connecting its servers in the background. */
export function openMcp(options: LoadMcpOptions): McpManager {
	const manager = new McpManager(loadMcpConfig(options));
	manager.start();
	return manager;
}
