import type { McpServerStatus } from "@atelier/core/protocol";
import { visibleText } from "@atelier/core/text";
import type { ChatState } from "./reducer.ts";

const shown = (text: string) => visibleText(text).text;

/** The states that need the user: shown in the warning style. */
const TROUBLED: ReadonlySet<McpServerStatus["state"]> = new Set(["failed", "invalid", "needs_auth"]);

/** The status bar's MCP label: servers connected out of those enabled. */
export function mcpChipLabel(servers: readonly McpServerStatus[]): string {
	const enabled = servers.filter((server) => server.state !== "disabled" && server.state !== "invalid");
	return `MCP ${enabled.filter((server) => server.state === "connected").length}/${enabled.length}`;
}

/** Whether a server failed, an entry is invalid or the file has a problem. */
export function mcpTroubled(mcp: NonNullable<ChatState["mcp"]>): boolean {
	return mcp.problems.length > 0 || mcp.servers.some((server) => TROUBLED.has(server.state));
}

/** The session's MCP servers: state, tools, errors and the end of a failed server's stderr. Server text is plain text. */
export function McpPanel({
	mcp,
	onLogin,
}: {
	mcp: NonNullable<ChatState["mcp"]>;
	/** Signs a server that needs it in. */
	onLogin: (server: string) => void;
}) {
	return (
		<aside className="feature-panel mcp-panel" aria-label="MCP servers">
			<h2>MCP servers</h2>
			<ul className="mcp-servers">
				{mcp.servers.map(({ name, transport, state, tools, error, stderr }) => {
					const label = transport === undefined ? shown(name) : `${shown(name)} (${transport})`;
					const troubled = TROUBLED.has(state);
					return (
						<li key={name} className={troubled ? "mcp-server warning" : "mcp-server"}>
							<div>
								{state === "connected"
									? `${label}: connected, ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`
									: `${label}: ${state === "needs_auth" ? "needs sign-in" : state}`}
							</div>
							{state === "needs_auth" ? (
								<button type="button" aria-label={`Sign in to ${shown(name)}`} onClick={() => onLogin(name)}>
									Sign in
								</button>
							) : null}
							{tools.length > 0 ? <div className="mcp-tools">{tools.map(shown).join(", ")}</div> : null}
							{error === undefined ? null : <pre className="mcp-error">{shown(error)}</pre>}
							{stderr === undefined ? null : <pre className="mcp-stderr">{shown(stderr)}</pre>}
						</li>
					);
				})}
			</ul>
			{mcp.problems.map((problem) => (
				<pre key={problem} className="mcp-error warning">
					{shown(problem)}
				</pre>
			))}
		</aside>
	);
}
