import { MCP_SEARCH_TOOL } from "../mcp/tools.ts";
import { MEMORY_TOOL } from "../memory/tool.ts";
import { PHASE_TOOL } from "../odd/tracker.ts";
import { type SubagentDefinition, TASK_TOOL } from "../subagents/definitions.ts";
import { ASK_USER_TOOL } from "../tools/ask-user.ts";
import { JOB_LIST_TOOL } from "../tools/background.ts";
import { RISK_TOOL } from "./tool.ts";

/**
 * The tools that never change the session's worktree themselves. A turn that ran only these, or none, made no change of
 * its own: its end assesses nothing, whatever else changed the worktree meanwhile. `feature` is not one: it writes the
 * feature document in the worktree.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"web_fetch",
	"web_search",
	ASK_USER_TOOL,
	MEMORY_TOOL,
	PHASE_TOOL,
	RISK_TOOL,
	JOB_LIST_TOOL,
	MCP_SEARCH_TOOL,
]);

/**
 * Whether a call of `tool` that runs may change the session's worktree: any tool outside READ_ONLY_TOOLS does, an unknown
 * one included. A task does when its subagent works in the session's folder with a tool outside them; a worker in the
 * background writes only in a worktree of its own, whose patch the agent applies with a call of its own.
 */
export function changesFiles(tool: string, input: unknown, agents: readonly SubagentDefinition[]): boolean {
	if (READ_ONLY_TOOLS.has(tool)) return false;
	if (tool !== TASK_TOOL) return true;
	const { agent, background } = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	if (background === true && agent === "worker") return false;
	const definition = agents.find((candidate) => candidate.name === agent);
	return definition === undefined || definition.tools.some((name) => !READ_ONLY_TOOLS.has(name));
}
