import { type McpServerStatus, visibleText } from "@atelier/core";

/** The MCP servers as `atelier mcp list` and `/mcp` print them: state, tools, errors and stderr; server text with its control characters as markers. */
export function mcpReport(servers: readonly McpServerStatus[], problems: readonly string[]): string {
	const shown = (text: string) => visibleText(text).text;
	const lines: string[] = [];
	for (const { name, transport, state, tools, error, stderr } of servers) {
		const label = transport === undefined ? shown(name) : `${shown(name)} (${transport})`;
		if (state === "connected") {
			lines.push(`${label}: connected, ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`);
			if (tools.length > 0) lines.push(`  ${tools.map(shown).join(", ")}`);
		} else if (state === "needs_auth") lines.push(`${label}: needs sign-in: run atelier mcp login ${shown(name)}`);
		else if (state === "failed" || state === "invalid") {
			lines.push(`${label}: ${state}: ${shown(error ?? "unknown error")}`);
			if (stderr !== undefined)
				lines.push(
					"  stderr:",
					...shown(stderr)
						.split("\n")
						.map((line) => `    ${line}`),
				);
		} else lines.push(`${label}: ${state}`);
	}
	for (const problem of problems) lines.push(`problem: ${shown(problem)}`);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Whether `atelier mcp list` fails: an invalid entry, a problem of the file, or an enabled server that is not connected. */
export function mcpFailed(servers: readonly McpServerStatus[], problems: readonly string[]): boolean {
	return problems.length > 0 || servers.some(({ state }) => state !== "connected" && state !== "disabled");
}
