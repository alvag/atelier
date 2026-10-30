/**
 * What the main agent did itself in a measured turn, from the turn's events: which tools it called, and how much it
 * read before and after its first task call.
 */
import type { ModelTransport } from "../src/backends/anthropic-api/transport.ts";
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

export interface BackgroundCalls {
	/** The parent's task calls with `background: true`, and those without it. */
	backgroundLaunches: number;
	foregroundTasks: number;
	/** The parent's requests whose response launched background tasks: 1 when they all went in one response. */
	launchResponses: number;
	/** Background launches with the prompt of an earlier one. */
	relaunches: number;
	/** job_list calls and bash commands that sleep. */
	polls: number;
	/** bash commands that run git apply, without --check. */
	applies: number;
	/** bash commands that run the checks (vitest), in all and after the last apply. */
	checkRuns: number;
	checksAfterLastApply: number;
}

/**
 * Tallies the parent's background work over all the turns of a session; `requests` holds, by call id, the parent's
 * request whose response made the call.
 */
export function tallyBackground(
	events: Iterable<AtelierEvent>,
	requests: ReadonlyMap<string, number>,
): BackgroundCalls {
	const tally: BackgroundCalls = {
		backgroundLaunches: 0,
		foregroundTasks: 0,
		launchResponses: 0,
		relaunches: 0,
		polls: 0,
		applies: 0,
		checkRuns: 0,
		checksAfterLastApply: 0,
	};
	const prompts = new Set<string>();
	const responses = new Set<number>();
	for (const event of events) {
		if (event.type !== "tool_call_started" || event.parentCallId !== undefined) continue;
		const input = (event.input ?? {}) as { prompt?: unknown; background?: unknown; command?: unknown };
		if (event.tool === "job_list") tally.polls++;
		if (event.tool === "task" && input.background !== true) tally.foregroundTasks++;
		if (event.tool === "task" && input.background === true) {
			tally.backgroundLaunches++;
			const prompt = String(input.prompt ?? "");
			if (prompts.has(prompt)) tally.relaunches++;
			prompts.add(prompt);
			const request = requests.get(event.callId);
			if (request !== undefined) responses.add(request);
		}
		if (event.tool !== "bash") continue;
		const command = String(input.command ?? "");
		if (/\bsleep\b/.test(command)) tally.polls++;
		if (/\bgit\b.*\bapply\b/.test(command) && !command.includes("--check")) {
			tally.applies++;
			tally.checksAfterLastApply = 0;
		}
		if (command.includes("vitest")) {
			tally.checkRuns++;
			tally.checksAfterLastApply++;
		}
	}
	tally.launchResponses = responses.size;
	return tally;
}

/**
 * The transport as it is, numbering its responses from 1 and noting in `requests` the response of each tool_use block
 * by its id, which is the call id the session's events carry.
 */
export function notingResponses(transport: ModelTransport, requests: Map<string, number>): ModelTransport {
	let responses = 0;
	return {
		...transport,
		async *request(params, signal) {
			const message = yield* transport.request(params, signal);
			responses++;
			for (const block of message.content) if (block.type === "tool_use") requests.set(block.id, responses);
			return message;
		},
	};
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
