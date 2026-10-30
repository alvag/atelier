#!/usr/bin/env node
/**
 * Measures how the main agent delegates, on the real API, so a change to the
 * delegation rules can be compared before and after. It costs money: a few
 * dollars with the default model. Not part of `pnpm check`.
 *
 * Runs its tasks on a throwaway copy of atelier-core/src, with ODD and the
 * built-in subagents as `atelier-core serve` gives them: two wide questions, two
 * narrow ones and a change handed to a worker; --tasks picks some by id. Each
 * session then gets a one-line follow-up whose prompt size shows how much context
 * the parent kept. Starts no session that could take the cost over --max-usd (6
 * by default), judged by the dearest session so far; an unreported cost stops it
 * too. --fake-backend plays every turn with a scripted backend that only
 * answers, for the script's own test: no API, no cost.
 *
 * Run it at the commit before the prompt change with --json, then at the one
 * after with --compare on that file. The JSON keeps the variant measured and the
 * commit it ran at:
 *
 *   node atelier-core/scripts/measure-delegation.ts [--model <id>] [--runs <n>] [--tasks <id,...>] [--max-usd <n>] [--json <file>] [--compare <file>]
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
	FakeBackend,
	resolveApiKey,
	Session,
	SYSTEM_PROMPT_APPEND,
	type Usage,
} from "../src/index.ts";
import { sandbox } from "../src/tools/sandbox.ts";
import { addCost, sumCosts, usd } from "./cost.ts";
import { measuredTools, tallyParentCalls } from "./delegation-calls.ts";
import { type Commit, commitAt, firstTools, fmt, mean } from "./delegation-report.ts";
import { pastedLines, sourceLines } from "./pasted.ts";

const TASKS = [
	{
		id: "wide",
		prompt:
			"How does Session make sure every turn ends with exactly one turn_finished event, even when the backend throws, the turn is interrupted or the backend never sends one? Answer with path:line references.",
	},
	{
		id: "wide2",
		prompt:
			"How is it decided whether a bash call asks the user, runs in the sandbox, runs outside it or is refused, in the normal, auto and yolo permission modes? Answer with path:line references.",
	},
	{
		id: "narrow",
		prompt: "What is REPORT_LIMIT and where in src is it enforced? Answer with path:line references.",
	},
	{
		id: "narrow2",
		prompt: "Where is WAKE_GATHER_MS defined and where is it used in src? Answer with path:line references.",
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
	/** The parent's first tool call, `none` when it called none; absent from a JSON from before the field. */
	firstTool: string;
	/** The parent's read and grep calls before its first task call; all of them when it never delegated. */
	readsBeforeTask: number;
	readsAfterTask: number;
	/** Characters the parent's successful reads gave the model before its first task call. */
	readCharsBeforeTask: number;
	/** Whether the parent read past the in-turn notice's threshold, before any task, edit or write. */
	noticeDue: boolean;
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
		tasks: { type: "string" },
		"fake-backend": { type: "boolean" },
		"max-usd": { type: "string" },
		json: { type: "string" },
		compare: { type: "string" },
	},
});
const model = values.model ?? DEFAULT_API_MODEL;
const runs = Number(values.runs ?? 2);
const maxUsd = Number(values["max-usd"] ?? 6);
const picked = values.tasks?.split(",").map((id) => id.trim());
const unknown = picked?.filter((id) => !TASKS.some((task) => task.id === id)) ?? [];
if (unknown.length > 0) {
	process.stderr.write(
		`Unknown task ${unknown.join(", ")}; the tasks are ${TASKS.map((task) => task.id).join(", ")}.\n`,
	);
	process.exit(2);
}
const tasks = picked === undefined ? TASKS : TASKS.filter((task) => picked.includes(task.id));
/** Only main's rules for now: the variants of #124 come with the session option that picks them. */
const variant = "baseline";
const here = dirname(fileURLToPath(import.meta.url));
const commit = commitAt(here);
const source = join(here, "../src");
const fake = values["fake-backend"] === true;
const apiKey = fake ? "" : await resolveApiKey();

/** A turn of the scripted backend: an answer, with its cost, so the spend stays known. */
const answer = () => [
	{ event: { type: "text_delta" as const, text: "src/session.ts" } },
	{
		event: {
			type: "turn_finished" as const,
			stopReason: "end_turn",
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
			costUsd: 0,
			requests: 1,
		},
	},
];

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
	/** Output characters of every call, the subagents' too, by call id. */
	const chars = new Map<string, number>();
	const backend = () => (fake ? new FakeBackend([answer(), answer()]) : new AnthropicApiBackend({ apiKey, model }));
	const session = await Session.start({
		backend: backend(),
		cwd,
		tools: measuredTools(coreTools, chars),
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
		firstTool: "none",
		readsBeforeTask: 0,
		readsAfterTask: 0,
		readCharsBeforeTask: 0,
		noticeDue: false,
		taskCalls: 0,
		taskPromptChars: 0,
		pastedLines: 0,
		followUpPrompt: 0,
		followUpCostUsd: 0,
		errors: [],
	};
	try {
		const events: AtelierEvent[] = [];
		for await (const event of session.send(task.prompt)) {
			events.push(event);
			if (event.type === "error") run.errors.push(`${event.agent ?? "parent"} ${event.code}: ${event.message}`);
			if (event.type === "turn_finished") add(event.parentCallId === undefined ? run.parent : run.subagents, event);
			if (event.type !== "tool_call_started" || event.parentCallId !== undefined || event.tool !== "task") continue;
			const text = String((event.input as { prompt?: unknown }).prompt ?? "");
			run.taskCalls++;
			run.taskPromptChars += text.length;
			run.pastedLines += pastedLines(text, known);
		}
		const tally = tallyParentCalls(events, chars);
		Object.assign(run, tally, { firstTool: tally.firstTool ?? "none" });
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
	for (const task of tasks) {
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
// The sessions share the process's sandbox, which no session's close stops: its log monitor would keep the script
// alive. The script owns the process, as the CLI does when it exits.
await sandbox.reset();

const COLUMNS: [string, (run: Run) => number][] = [
	["parent requests", (r) => r.parent.requests],
	["parent prompt tokens", (r) => prompt(r.parent.usage)],
	["parent output", (r) => r.parent.usage.output],
	["reads before task", (r) => r.readsBeforeTask],
	["read chars before task", (r) => r.readCharsBeforeTask],
	["reads after task", (r) => r.readsAfterTask],
	["notice due (share of runs)", (r) => (r.noticeDue === undefined ? Number.NaN : Number(r.noticeDue))],
	["task calls", (r) => r.taskCalls],
	["task prompt chars", (r) => r.taskPromptChars],
	["pasted lines", (r) => r.pastedLines],
	["subagent requests", (r) => r.subagents.requests],
	["subagent prompt tokens", (r) => prompt(r.subagents.usage)],
	["follow-up prompt tokens", (r) => r.followUpPrompt],
	["cost USD", (r) => total(r) ?? Number.NaN],
];

const compared = values.compare
	? (JSON.parse(await readFile(values.compare, "utf8")) as {
			variant?: string;
			commit?: Commit;
			results: Run[];
		})
	: undefined;
const before = compared?.results;
const at = (c: Commit | undefined) =>
	c === undefined ? "unknown commit" : `${c.sha.slice(0, 7)}${c.dirty ? " (uncommitted changes)" : ""}`;
const lines = [
	`Model: ${model}. Variant: ${variant} at ${at(commit)}. Runs per task: ${runs}. Spent: ${usd(spent)}${stopped ? ` (stopped: the next session could pass $${maxUsd})` : ""}.`,
	...(compared ? [`Before: ${compared.variant ?? "baseline"} at ${at(compared.commit)}.`] : []),
	"",
];
for (const task of tasks) {
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
	lines.push("", `First tool: ${firstTools(now)}${then ? ` (before: ${firstTools(then)})` : ""}.`, "");
}
const errors = results.flatMap((run) => run.errors.map((error) => `${run.task}: ${error}`));
if (errors.length > 0) lines.push("Errors:", ...errors.map((error) => `- ${error}`));
process.stdout.write(`${lines.join("\n")}\n`);
if (values.json)
	await writeFile(
		values.json,
		`${JSON.stringify({ model, variant, commit, runs, spent, stopped, results }, null, 2)}\n`,
	);
