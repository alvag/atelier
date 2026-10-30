/**
 * What the main agent did itself in a measured turn, from the turn's events: which tools it called, and how much it
 * read before and after its first task call.
 */
import type { AtelierEvent } from "../src/index.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

const READS = new Set(["read", "grep"]);

export interface ParentCalls {
	/** The parent's own tool calls, by tool. */
	tools: Record<string, number>;
	firstTool: string | undefined;
	/** The parent's read and grep calls before its first task call; all of them when it never delegated. */
	readsBeforeTask: number;
	readsAfterTask: number;
	/** Characters the parent's successful read and grep calls gave the model before its first task call. */
	readCharsBeforeTask: number;
}

/** Tallies the parent's calls; `chars` holds each call's output length by call id, as `measuredTools` records it. */
export function tallyParentCalls(events: Iterable<AtelierEvent>, chars: ReadonlyMap<string, number>): ParentCalls {
	const tally: ParentCalls = {
		tools: {},
		firstTool: undefined,
		readsBeforeTask: 0,
		readsAfterTask: 0,
		readCharsBeforeTask: 0,
	};
	const tools = new Map<string, string>();
	let delegated = false;
	for (const event of events) {
		if (event.parentCallId !== undefined) continue;
		if (event.type === "tool_call_started") {
			tools.set(event.callId, event.tool);
			tally.tools[event.tool] = (tally.tools[event.tool] ?? 0) + 1;
			tally.firstTool ??= event.tool;
			if (READS.has(event.tool)) {
				if (delegated) tally.readsAfterTask++;
				else tally.readsBeforeTask++;
			}
			if (event.tool === "task") delegated = true;
		} else if (
			event.type === "tool_call_finished" &&
			event.ok &&
			!delegated &&
			READS.has(tools.get(event.callId) ?? "")
		)
			tally.readCharsBeforeTask += chars.get(event.callId) ?? 0;
	}
	return tally;
}

/** The tools as they are, recording the length of each call's output in `chars` by call id. */
export function measuredTools(tools: readonly ToolDefinition[], chars: Map<string, number>): ToolDefinition[] {
	return tools.map((tool) => ({
		...tool,
		execute: async (input, context) => {
			const outcome = await tool.execute(input, context);
			if (context.callId !== undefined) chars.set(context.callId, outcome.output.length);
			return outcome;
		},
	}));
}
