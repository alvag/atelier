import { z } from "zod";
import { type DelegationVariant, WHY_DELEGATE, withWhyDelegate } from "../delegation.ts";
import { defineTool, type ToolContext, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";

export const TASK_TOOL = "task";
/** Characters of a subagent report that reach the parent; enforced in code, not asked for in a prompt. */
export const REPORT_LIMIT = 8000;
/** Subagents that may run in the background at once in one session: each one is a model spending tokens. */
export const MAX_BACKGROUND_TASKS = 4;

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

/**
 * When the main agent delegates, in the task tool's description: it exists only when there are subagents. A rule that
 * names an agent the session lacks is left out, so the model is never told to call one it cannot. The `why` variant of
 * #124 says, after the explorer's rule, why delegating keeps the context small.
 */
function delegationRules(names: readonly string[], variant?: DelegationVariant): string[] {
	return [
		"When to delegate:",
		...(names.includes("explorer")
			? [
					"- Read inline when it takes up to about 3 parallel calls or 10k tokens; beyond that, send one explorer and ask for an answer of at most about 2k tokens with path:line evidence.",
					...(withWhyDelegate(variant) ? [WHY_DELEGATE] : []),
				]
			: []),
		"- Pass paths, the spec reference and what to change, never file contents: the subagent reads them itself.",
		...(names.includes("worker")
			? ["- Reading that prepares a delegated change belongs to the worker: do not read it first yourself."]
			: []),
	];
}

const REPORT_FORMAT =
	"Your final message is the only thing the agent that delegated to you will see, so make it a self-contained report: answer first, then the evidence as path:line references. Do not paste whole files. Keep it under 1,500 words.";

export const BUILTIN_AGENTS: readonly SubagentDefinition[] = Object.freeze([
	{
		name: "explorer",
		description:
			"Reads and searches the code to answer a specific question, without changing anything. Use it when answering needs many reads.",
		tools: ["read", "grep", "web_fetch", "web_search"],
		prompt: `You are an explorer working for another coding agent. Answer the question you are given by reading and searching the code; you cannot change anything. ${REPORT_FORMAT}`,
		models: {},
		maxRequests: 30,
	},
	{
		name: "worker",
		description:
			"Makes a well-specified, bounded change and checks it. Give it the paths, the spec and what to change: it does not see this conversation.",
		tools: ["read", "edit", "write", "grep", "bash", "web_fetch", "web_search"],
		prompt: `You are a worker for another coding agent. Make exactly the change you are given, keep it as small as it allows, and check it. ${REPORT_FORMAT} Say what changed and how you checked it.`,
		models: {},
		maxRequests: 50,
	},
]);

/** How a subagent's turn ended: its report, or why there is none; with what it cost when its backend says. */
export type SubagentResult =
	| { ok: true; report: string; costUsd?: number }
	| { ok: false; error: string; costUsd?: number };

export type RunSubagent = (agent: SubagentDefinition, prompt: string, context: ToolContext) => Promise<ToolOutcome>;
/** Starts the subagent in the background and answers at once; `undefined` runs it as `task` without background. */
export type StartSubagent = (
	agent: SubagentDefinition,
	prompt: string,
	label: string | undefined,
	context: ToolContext,
) => Promise<ToolOutcome>;

/** What the task tool says about `background`, depending on whether the session can receive a background result. */
function backgroundDescription(available: boolean): string {
	return available
		? "Run it in the background while you keep working: you get its task id at once and its report in one notice when it ends."
		: "Not available in this session: it cannot receive a background result.";
}

/**
 * The task tool the parent sees. Its execution belongs to the session, which owns backends and events. `start` runs a
 * call with `background` set; without it the session cannot receive a background result, and such a call is refused.
 */
export function createTaskTool(
	agents: readonly SubagentDefinition[],
	run: RunSubagent,
	start?: StartSubagent,
	variant?: DelegationVariant,
): ToolDefinition {
	const names = agents.map((agent) => agent.name) as [string, ...string[]];
	return defineTool({
		name: TASK_TOOL,
		description: [
			"Delegates work to a subagent with its own, empty context; only its final report comes back to you.",
			"The prompt must be self-contained: the subagent does not see this conversation.",
			...delegationRules(names, variant),
			...(start === undefined
				? []
				: [
						`With background: true at most ${MAX_BACKGROUND_TASKS} run at once; job_list lists them and job_stop stops one.`,
					]),
			"Agents:",
			...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
		].join("\n"),
		inputShape: {
			agent: z.enum(names).describe("Which subagent to run"),
			prompt: z.string().min(1).describe("Everything the subagent needs to do the work"),
			background: z
				.boolean()
				.optional()
				.describe(backgroundDescription(start !== undefined)),
			label: z
				.string()
				.optional()
				.describe("With background: a short name for the task; the prompt's first line without it"),
		},
		execute: async ({ agent, prompt, background, label }, context) => {
			const definition = agents.find((candidate) => candidate.name === agent) as SubagentDefinition;
			if (background !== true) return run(definition, prompt, context);
			if (start === undefined) {
				const output = "Refused: this session cannot receive a background result; run the task without background.";
				return { ok: false, output, summary: output, truncated: false };
			}
			return start(definition, prompt, label, context);
		},
	});
}

/** The report the parent sees: at most REPORT_LIMIT characters, with a marker when cut. */
export function boundReport(text: string): { text: string; truncated: boolean } {
	if (text.length <= REPORT_LIMIT) return { text, truncated: false };
	return { text: `${text.slice(0, REPORT_LIMIT)}\n[report truncated at ${REPORT_LIMIT} characters]`, truncated: true };
}
