/**
 * What the main agent did itself in a measured turn, from the turn's events: which tools it called, and how much it
 * read before and after its first task call.
 */
import type { ModelTransport } from "../src/backends/anthropic-api/transport.ts";
import type { AtelierEvent } from "../src/index.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { sumCosts } from "./cost.ts";

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
		for (const words of commandSegments(String(input.command ?? ""))) {
			if (runs(words, "sleep")) tally.polls++;
			if (appliesPatch(words)) {
				tally.applies++;
				tally.checksAfterLastApply = 0;
			}
			if (runs(words, "vitest")) {
				tally.checkRuns++;
				tally.checksAfterLastApply++;
			}
		}
	}
	tally.launchResponses = responses.size;
	return tally;
}

/**
 * What the background tasks of a session cost, from their `task_finished` events: their turns are not among the
 * parent's events. Unknown as soon as one did not say its cost, a stopped one included: it may have spent.
 */
export function backgroundTaskCost(events: Iterable<AtelierEvent>): number | undefined {
	return sumCosts(
		[...events].flatMap((event) =>
			event.type === "task_finished" && event.parentCallId === undefined ? [event.costUsd] : [],
		),
	);
}

/**
 * The simple commands of a shell line, each as its words without quotes or leading variable assignments: split at
 * `&&`, `||`, `;`, `|` and line ends. Enough for what a model writes; not a shell parser.
 */
function commandSegments(command: string): string[][] {
	return command.split(/&&|\|\||;|\||\n/).map((segment) => {
		const words = (segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
		while (words.length > 0 && /^\w+=/.test(words[0] as string)) words.shift();
		return words;
	});
}

/** Whether the command runs `program`, by path or through npx, pnpm (exec), yarn or bunx; not one that only names it. */
function runs(words: readonly string[], program: string): boolean {
	const [first, second, third] = words.map((word) => word.split("/").at(-1));
	if (first === program) return true;
	if (first === undefined || !["npx", "pnpm", "yarn", "bunx"].includes(first)) return false;
	return second === program || (second === "exec" && third === program);
}

/** Whether the command is a `git apply` that changes files: git's global options skipped, `--check` left out. */
function appliesPatch(words: readonly string[]): boolean {
	if (words[0]?.split("/").at(-1) !== "git") return false;
	let at = 1;
	while (words[at]?.startsWith("-")) at += words[at] === "-C" || words[at] === "-c" ? 2 : 1;
	return words[at] === "apply" && !words.slice(at + 1).includes("--check");
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
