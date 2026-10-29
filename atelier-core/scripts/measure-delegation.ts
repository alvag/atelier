#!/usr/bin/env node
/**
 * Measures how the main agent delegates, on the real API, so a change to the
 * delegation rules can be compared before and after. It costs money: a few
 * dollars with the default model. Not part of `pnpm check`.
 *
 * Runs three tasks on a throwaway copy of atelier-core/src, with ODD and the
 * built-in subagents as `atelier-core serve` gives them: a wide question, a
 * narrow one and a change handed to a worker. Each session then gets a one-line
 * follow-up whose prompt size shows how much context the parent kept. Starts no
 * session that could take the cost over --max-usd (6 by default), judged by the
 * dearest session so far; an unreported cost stops it too.
 *
 * Run it at the commit before the prompt change with --json, then at the one
 * after with --compare on that file:
 *
 *   node atelier-core/scripts/measure-delegation.ts [--model <id>] [--runs <n>] [--max-usd <n>] [--json <file>] [--compare <file>]
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	AnthropicApiBackend,
	type AtelierEvent,
	BUILTIN_AGENTS,
	coreTools,
	DEFAULT_API_MODEL,
	resolveApiKey,
	Session,
	SYSTEM_PROMPT_APPEND,
	type Usage,
} from "../src/index.ts";
import { addCost, sumCosts, usd } from "./cost.ts";
import { pastedLines, sourceLines } from "./pasted.ts";

const TASKS = [
	{
		id: "wide",
		prompt:
			"How does Session make sure every turn ends with exactly one turn_finished event, even when the backend throws, the turn is interrupted or the backend never sends one? Answer with path:line references.",
	},
	{
		id: "narrow",
		prompt: "What is REPORT_LIMIT and where in src is it enforced? Answer with path:line references.",
	},
	{
		id: "worker",
		prompt:
			"Use a worker to rename the function boundReport to capReport in src/subagents/definitions.ts and everywhere it is used.",
	},
] as const;
const FOLLOW_UP = "In one sentence: which file mattered most for that?";

interface Measure {
	usage: Usage;
	requests: number;
	/** Unknown as soon as one turn did not report its cost. */
	costUsd: number | undefined;
}

interface Run {
	task: string;
	parent: Measure;
	subagents: Measure;
	/** The parent's own tool calls, by tool. */
	tools: Record<string, number>;
	/** The parent's read and grep calls before its first task call; all of them when it never delegated. */
	readsBeforeTask: number;
	taskCalls: number;
	taskPromptChars: number;
	/** Lines of the task prompts that repeat a line of the source: pasted code. */
	pastedLines: number;
	/** Prompt tokens of the follow-up's request: about the size of the parent's context. */
	followUpPrompt: number;
	followUpCostUsd: number | undefined;
	errors: string[];
}

const { values } = parseArgs({
	options: {
		model: { type: "string" },
		runs: { type: "string" },
		"max-usd": { type: "string" },
		json: { type: "string" },
		compare: { type: "string" },
	},
});
const model = values.model ?? DEFAULT_API_MODEL;
const runs = Number(values.runs ?? 2);
const maxUsd = Number(values["max-usd"] ?? 6);
const source = join(dirname(fileURLToPath(import.meta.url)), "../src");
const apiKey = await resolveApiKey();

const empty = (): Measure => ({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0, costUsd: 0 });
function add(measure: Measure, event: Extract<AtelierEvent, { type: "turn_finished" }>): void {
	measure.usage.input += event.usage.input;
	measure.usage.output += event.usage.output;
	measure.usage.cacheRead += event.usage.cacheRead;
	measure.usage.cacheWrite += event.usage.cacheWrite;
	measure.requests += event.requests ?? 0;
	measure.costUsd = addCost(measure.costUsd, event.costUsd);
}
const prompt = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
const total = (run: Run) => sumCosts([run.parent.costUsd, run.subagents.costUsd, run.followUpCostUsd]);

async function readSource(cwd: string): Promise<Set<string>> {
	const files = (await readdir(cwd, { recursive: true })).filter((file) => file.endsWith(".ts"));
	return sourceLines(await Promise.all(files.map((file) => readFile(join(cwd, file), "utf8"))));
}

async function measure(task: (typeof TASKS)[number]): Promise<Run> {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-delegation-"));
	await cp(source, join(cwd, "src"), { recursive: true });
	const known = await readSource(cwd);
	const backend = () => new AnthropicApiBackend({ apiKey, model });
	const session = await Session.start({
		backend: backend(),
		cwd,
		tools: coreTools,
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		odd: true,
		maxRequestsPerTurn: 40,
		subagents: { agents: BUILTIN_AGENTS, createBackend: backend },
	});
	const run: Run = {
		task: task.id,
		parent: empty(),
		subagents: empty(),
		tools: {},
		readsBeforeTask: 0,
		taskCalls: 0,
		taskPromptChars: 0,
		pastedLines: 0,
		followUpPrompt: 0,
		followUpCostUsd: 0,
		errors: [],
	};
	try {
		for await (const event of session.send(task.prompt)) {
			if (event.type === "error") run.errors.push(`${event.agent ?? "parent"} ${event.code}: ${event.message}`);
			if (event.type === "turn_finished") add(event.parentCallId === undefined ? run.parent : run.subagents, event);
			if (event.type !== "tool_call_started" || event.parentCallId !== undefined) continue;
			run.tools[event.tool] = (run.tools[event.tool] ?? 0) + 1;
			if (event.tool === "task") {
				const text = String((event.input as { prompt?: unknown }).prompt ?? "");
				run.taskCalls++;
				run.taskPromptChars += text.length;
				run.pastedLines += pastedLines(text, known);
			} else if (run.taskCalls === 0 && (event.tool === "read" || event.tool === "grep")) run.readsBeforeTask++;
		}
		for await (const event of session.send(FOLLOW_UP)) {
			if (event.type === "turn_finished" && event.parentCallId === undefined) {
				run.followUpPrompt = prompt(event.usage);
				run.followUpCostUsd = event.costUsd;
			}
		}
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
	return run;
}

const results: Run[] = [];
let spent: number | undefined = 0;
/** The dearest session so far: the next one is not started when it could take the total over --max-usd. */
let dearest = 0;
let stopped = false;
for (let round = 0; round < runs && !stopped; round++)
	for (const task of TASKS) {
		if (spent === undefined || spent + dearest > maxUsd) {
			stopped = true;
			break;
		}
		const run = await measure(task);
		results.push(run);
		spent = addCost(spent, total(run));
		dearest = Math.max(dearest, total(run) ?? 0);
		process.stderr.write(`${task.id} #${round + 1}: ${usd(total(run))} (so far ${usd(spent)})\n`);
	}

/** The mean of one number over the runs of a task. */
const mean = (of: readonly Run[], pick: (run: Run) => number) =>
	of.length === 0 ? 0 : of.reduce((sum, run) => sum + pick(run), 0) / of.length;
const COLUMNS: [string, (run: Run) => number][] = [
	["parent requests", (r) => r.parent.requests],
	["parent prompt tokens", (r) => prompt(r.parent.usage)],
	["parent output", (r) => r.parent.usage.output],
	["reads before task", (r) => r.readsBeforeTask],
	["task calls", (r) => r.taskCalls],
	["task prompt chars", (r) => r.taskPromptChars],
	["pasted lines", (r) => r.pastedLines],
	["subagent requests", (r) => r.subagents.requests],
	["subagent prompt tokens", (r) => prompt(r.subagents.usage)],
	["follow-up prompt tokens", (r) => r.followUpPrompt],
	["cost USD", (r) => total(r) ?? Number.NaN],
];
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 3 : 0));

const before: Run[] | undefined = values.compare
	? (JSON.parse(await readFile(values.compare, "utf8")) as { results: Run[] }).results
	: undefined;
const lines = [
	`Model: ${model}. Runs per task: ${runs}. Spent: ${usd(spent)}${stopped ? ` (stopped: the next session could pass $${maxUsd})` : ""}.`,
	"",
];
for (const task of TASKS) {
	const now = results.filter((run) => run.task === task.id);
	const then = before?.filter((run) => run.task === task.id);
	lines.push(`### ${task.id} (${now.length} runs${then ? `, before: ${then.length}` : ""})`, "");
	lines.push(then ? "| Measure | Before | After |" : "| Measure | Mean |", then ? "|---|---|---|" : "|---|---|");
	for (const [name, pick] of COLUMNS)
		lines.push(
			then
				? `| ${name} | ${fmt(mean(then, pick))} | ${fmt(mean(now, pick))} |`
				: `| ${name} | ${fmt(mean(now, pick))} |`,
		);
	lines.push("");
}
const errors = results.flatMap((run) => run.errors.map((error) => `${run.task}: ${error}`));
if (errors.length > 0) lines.push("Errors:", ...errors.map((error) => `- ${error}`));
process.stdout.write(`${lines.join("\n")}\n`);
if (values.json) await writeFile(values.json, `${JSON.stringify({ model, runs, spent, stopped, results }, null, 2)}\n`);
