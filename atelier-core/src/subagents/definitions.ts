import { z } from "zod";
import type { ToolOutcome } from "../tools/types.ts";
import { defineTool, type ToolDefinition } from "../tools/types.ts";

export const TASK_TOOL = "task";
/** Characters of a subagent report that reach the parent; enforced in code, not asked for in a prompt. */
export const REPORT_LIMIT = 8000;

export interface SubagentDefinition {
	name: string;
	/** Shown to the parent model in the task tool's description. */
	description: string;
	/** Names of the parent's tools the child gets. Never includes task: subagents do not delegate. */
	tools: readonly string[];
	/** The child's whole instruction set: it sees nothing of the parent's prompt or history. */
	prompt: string;
	/** Model by backend id; a backend missing here uses the parent's model. */
	models: Readonly<Record<string, string>>;
	maxRequests: number;
}

const REPORT_FORMAT =
	"Your final message is the only thing the agent that delegated to you will see, so make it a self-contained report: answer first, then the evidence as path:line references. Do not paste whole files. Keep it under 1,500 words.";

export const BUILTIN_AGENTS: readonly SubagentDefinition[] = Object.freeze([
	{
		name: "explorer",
		description:
			"Reads and searches the code to answer a specific question, without changing anything. Use it when answering needs many reads.",
		tools: ["read", "grep"],
		prompt: `You are an explorer working for another coding agent. Answer the question you are given by reading and searching the code; you cannot change anything. ${REPORT_FORMAT}`,
		models: { "claude-code": "haiku", "anthropic-api": "claude-haiku-5-5" },
		maxRequests: 30,
	},
	{
		name: "worker",
		description:
			"Makes a well-specified, bounded change and checks it. Give it everything it needs: it does not see this conversation.",
		tools: ["read", "edit", "grep", "bash"],
		prompt: `You are a worker for another coding agent. Make exactly the change you are given, keep it as small as it allows, and check it. ${REPORT_FORMAT} Say what changed and how you checked it.`,
		models: {},
		maxRequests: 50,
	},
]);

export type RunSubagent = (agent: SubagentDefinition, prompt: string, signal?: AbortSignal) => Promise<ToolOutcome>;

/** The task tool the parent sees. Its execution belongs to the session, which owns backends and events. */
export function createTaskTool(agents: readonly SubagentDefinition[], run: RunSubagent): ToolDefinition {
	const names = agents.map((agent) => agent.name) as [string, ...string[]];
	return defineTool({
		name: TASK_TOOL,
		description: [
			"Delegates work to a subagent with its own, empty context; only its final report comes back to you.",
			"The prompt must be self-contained: the subagent does not see this conversation.",
			"Agents:",
			...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
		].join("\n"),
		inputShape: {
			agent: z.enum(names).describe("Which subagent to run"),
			prompt: z.string().min(1).describe("Everything the subagent needs to do the work"),
		},
		execute: async ({ agent, prompt }, { signal }) => {
			const definition = agents.find((candidate) => candidate.name === agent) as SubagentDefinition;
			return run(definition, prompt, signal);
		},
	});
}

/** The report the parent sees: at most REPORT_LIMIT characters, with a marker when cut. */
export function boundReport(text: string): { text: string; truncated: boolean } {
	if (text.length <= REPORT_LIMIT) return { text, truncated: false };
	return { text: `${text.slice(0, REPORT_LIMIT)}\n[report truncated at ${REPORT_LIMIT} characters]`, truncated: true };
}
