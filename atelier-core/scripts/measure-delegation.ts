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
 * after with --compare on that file. The JSON keeps the explorer's model and the
 * commit it ran at:
 *
 * --explorer-model gives the explorer its own model, to see whether a cheaper one
 * changes how often the parent delegates.
 *
 * --background gives the session a wake, so `task` runs subagents in the
 * background, and runs the turns their notices wake until none runs. The copy of
 * src is then a git repository with tests and checks (background-repo.ts), and
 * two more tasks run: two independent changes with their tests, and a question
 * whose answer a change needs. It counts the background launches and the
 * responses that made them, the tasks run without background, polls, git apply
 * calls and the checks run after the last one, and, after the session, how many
 * of the asked test files exist and whether the checks pass. With it, --variant
 * picks the background rules of #154 the main agent gets (baseline by default).
 *
 *   node atelier-core/scripts/measure-delegation.ts [--model <id>] [--explorer-model <id>] [--background] [--variant <name>] [--runs <n>] [--tasks <id,...>] [--max-usd <n>] [--json <file>] [--compare <file>]
 */
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { BACKEND_ID } from "../src/backends/anthropic-api/backend.ts";
import { anthropicTransport } from "../src/backends/anthropic-api/transport.ts";
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
import { BACKGROUND_RULES_VARIANTS, type BackgroundRulesVariant } from "../src/prompt.ts";
import { sandbox } from "../src/tools/sandbox.ts";
import { CHECKS, checksPass, makeBackgroundRepo } from "./background-repo.ts";
import { addCost, sumCosts, usd } from "./cost.ts";
import {
	type BackgroundCalls,
	backgroundTaskCost,
	measuredTools,
	notingResponses,
	tallyBackground,
	tallyParentCalls,
} from "./delegation-calls.ts";
import { type Commit, commitAt, firstTools, fmt, mean } from "./delegation-report.ts";
import { pastedLines, sourceLines } from "./pasted.ts";

interface Task {
	id: string;
	prompt: string;
	/** Runs only with --background. */
	background?: true;
	/** Test files the task asks for: their count after the session says how many changes reached the repository. */
	files?: readonly string[];
}

const TASKS: readonly Task[] = [
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
	{
		id: "parallel",
		background: true,
		files: ["test/context-gauge.test.ts", "test/limits.test.ts"],
		prompt: [
			`Make two independent changes in this repository, each with its tests in test/, then run the checks once at the end: \`${CHECKS}\`.`,
			"1. contextGauge in src/context-gauge.ts takes an optional second argument, { cells?: number }: the number of cells of the bar, 8 by default; the bar and the text use it. A cells that is not an integer from 1 to 32 throws a RangeError that names the value. Test it in test/context-gauge.test.ts.",
			"2. In src/tools/limits.ts, headBytes and tailBytes throw a RangeError that names the value when maxBytes is negative or not an integer, and takeHead does the same for its maxBytes. Test it in test/limits.test.ts.",
		].join("\n"),
	},
	{
		id: "needed-first",
		background: true,
		prompt:
			"Find how it is decided whether a bash call asks the user, runs in the sandbox, runs outside it or is refused, in the normal, auto and yolo permission modes. Then, above the function that makes that final decision, add a one-line comment that names the three modes and what each of them asks. Answer with path:line references.",
	},
];
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
	/** Background subagents add only their cost: their usage and requests are not reported to the parent. */
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
	taskCalls: number;
	taskPromptChars: number;
	/** Lines of the task prompts that repeat a line of the source: pasted code. */
	pastedLines: number;
	/** Prompt tokens of the follow-up's request: about the size of the parent's context. */
	followUpPrompt: number;
	followUpCostUsd: number | undefined;
	errors: string[];
	/** With --background: the parent's background work, the asked test files that exist, and whether the checks pass. */
	background?: BackgroundCalls & { changesMade: number; checksPass: boolean };
}

const { values } = parseArgs({
	options: {
		model: { type: "string" },
		runs: { type: "string" },
		tasks: { type: "string" },
		"fake-backend": { type: "boolean" },
		background: { type: "boolean" },
		variant: { type: "string" },
		"explorer-model": { type: "string" },
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
const background = values.background === true;
const tasks = TASKS.filter((task) =>
	picked === undefined ? background || !task.background : picked.includes(task.id),
);
const variant = (values.variant ?? "baseline") as BackgroundRulesVariant;
if (!BACKGROUND_RULES_VARIANTS.includes(variant)) {
	process.stderr.write(`Unknown variant ${variant}; the variants are ${BACKGROUND_RULES_VARIANTS.join(", ")}.\n`);
	process.exit(2);
}
if (variant !== "baseline" && !background) {
	process.stderr.write(`--variant ${variant} needs --background: its rules speak of background subagents.\n`);
	process.exit(2);
}
const needBackground = background ? [] : tasks.filter((task) => task.background);
if (needBackground.length > 0) {
	process.stderr.write(`${needBackground.map((task) => task.id).join(", ")} runs only with --background.\n`);
	process.exit(2);
}
const explorerModel = values["explorer-model"];
const here = dirname(fileURLToPath(import.meta.url));
const commit = commitAt(here);
const source = join(here, "../src");
/** How long the background work of one session may run before the session is closed under it. */
const BACKGROUND_LIMIT_MS = 30 * 60_000;
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

/** The built-in subagents, the explorer on --explorer-model when it is given. */
const agents = BUILTIN_AGENTS.map((agent) =>
	agent.name === "explorer" && explorerModel !== undefined
		? { ...agent, models: { ...agent.models, [fake ? "fake" : BACKEND_ID]: explorerModel } }
		: agent,
);

async function measure(task: Task): Promise<Run> {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-delegation-"));
	await cp(source, join(cwd, "src"), { recursive: true });
	const known = await readSource(cwd);
	if (background)
		await makeBackgroundRepo(cwd, join(here, "../../tsconfig.base.json"), [
			join(here, "../node_modules"),
			join(here, "../../node_modules"),
		]);
	/** Output characters of every call, the subagents' too, by call id. */
	const chars = new Map<string, number>();
	/** The parent's response that made each of its tool calls, by call id. */
	const requests = new Map<string, number>();
	const backend = () => (fake ? new FakeBackend([answer(), answer()]) : new AnthropicApiBackend({ apiKey, model }));
	const parentBackend = () => {
		if (fake) return backend();
		const transport = notingResponses(anthropicTransport(new Anthropic({ apiKey })), requests);
		return new AnthropicApiBackend({ apiKey, model, connect: () => () => transport });
	};
	/** Settles when a notice asks for a turn; renewed once taken. */
	let woken = Promise.withResolvers<void>();
	const session = await Session.start({
		backend: parentBackend(),
		cwd,
		tools: measuredTools(coreTools, chars),
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		odd: true,
		maxRequestsPerTurn: 40,
		subagents: { agents, createBackend: backend },
		...(background ? { wake: () => woken.resolve(), backgroundRules: variant } : {}),
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
		taskCalls: 0,
		taskPromptChars: 0,
		pastedLines: 0,
		followUpPrompt: 0,
		followUpCostUsd: 0,
		errors: [],
	};
	try {
		const events: AtelierEvent[] = [];
		const take = (event: AtelierEvent) => {
			events.push(event);
			if (event.type === "error") run.errors.push(`${event.agent ?? "parent"} ${event.code}: ${event.message}`);
			if (event.type === "turn_finished") add(event.parentCallId === undefined ? run.parent : run.subagents, event);
			if (event.type !== "tool_call_started" || event.parentCallId !== undefined || event.tool !== "task") return;
			const text = String((event.input as { prompt?: unknown }).prompt ?? "");
			run.taskCalls++;
			run.taskPromptChars += text.length;
			run.pastedLines += pastedLines(text, known);
		};
		for await (const event of session.send(task.prompt)) take(event);
		// The turns the notices of background work wake, until none runs or waits.
		const deadline = Date.now() + BACKGROUND_LIMIT_MS;
		while (background && (session.jobs.running > 0 || session.jobs.waiting > 0)) {
			const left = deadline - Date.now();
			if (left <= 0) {
				run.errors.push(`background work still ran after ${BACKGROUND_LIMIT_MS / 60_000} minutes`);
				break;
			}
			await Promise.race([woken.promise, new Promise((resolve) => setTimeout(resolve, Math.min(left, 1000)))]);
			woken = Promise.withResolvers<void>();
			const next = session.nextQueued();
			if (next !== undefined) for await (const event of next) take(event);
		}
		const tally = tallyParentCalls(events, chars);
		Object.assign(run, tally, { firstTool: tally.firstTool ?? "none" });
		for await (const event of session.send(FOLLOW_UP)) {
			// A task's end said while no turn ran comes first in the next turn: its cost counts too.
			if (event.type === "task_finished") events.push(event);
			if (event.type === "turn_finished" && event.parentCallId === undefined) {
				run.followUpPrompt = prompt(event.usage);
				run.followUpCostUsd = event.costUsd;
			}
		}
		if (background) {
			// Background subagents are not among the parent's events: only their ends say what they cost. One still
			// running when the session closes has spent what nobody reports: the cost is unknown, and the measure stops.
			const cost = session.jobs.running > 0 ? undefined : backgroundTaskCost(events);
			run.subagents.costUsd = addCost(run.subagents.costUsd, cost);
			const made = await Promise.all((task.files ?? []).map((file) => exists(join(cwd, file))));
			run.background = {
				...tallyBackground(events, requests),
				changesMade: made.filter(Boolean).length,
				checksPass: await checksPass(cwd),
			};
		}
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
	return run;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
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
	["task calls", (r) => r.taskCalls],
	["task prompt chars", (r) => r.taskPromptChars],
	["pasted lines", (r) => r.pastedLines],
	["subagent requests", (r) => r.subagents.requests],
	["subagent prompt tokens", (r) => prompt(r.subagents.usage)],
	["follow-up prompt tokens", (r) => r.followUpPrompt],
	["cost USD", (r) => total(r) ?? Number.NaN],
];
/** Not measured (a run without --background) is NaN, shown as n/a. */
const bg = (pick: (b: NonNullable<Run["background"]>) => number) => (r: Run) =>
	r.background === undefined ? Number.NaN : pick(r.background);
const BACKGROUND_COLUMNS: [string, (run: Run) => number][] = [
	["background launches", bg((b) => b.backgroundLaunches)],
	["responses that launched", bg((b) => b.launchResponses)],
	["tasks without background", bg((b) => b.foregroundTasks)],
	["relaunches", bg((b) => b.relaunches)],
	["polls", bg((b) => b.polls)],
	["git applies", bg((b) => b.applies)],
	["check runs", bg((b) => b.checkRuns)],
	["checks after the last apply", bg((b) => b.checksAfterLastApply)],
	["asked test files made", bg((b) => b.changesMade)],
	["checks pass", bg((b) => (b.checksPass ? 1 : 0))],
];

const compared = values.compare
	? (JSON.parse(await readFile(values.compare, "utf8")) as {
			commit?: Commit;
			results: Run[];
		})
	: undefined;
const before = compared?.results;
const at = (c: Commit | undefined) =>
	c === undefined ? "unknown commit" : `${c.sha.slice(0, 7)}${c.dirty ? " (uncommitted changes)" : ""}`;
const lines = [
	`Model: ${model}, at ${at(commit)}.${explorerModel === undefined ? "" : ` Explorer model: ${explorerModel}.`}${background ? ` With background subagents. Variant: ${variant}.` : ""} Runs per task: ${runs}. Spent: ${usd(spent)}${stopped ? ` (stopped: the next session could pass $${maxUsd})` : ""}.`,
	...(compared ? [`Before: at ${at(compared.commit)}.`] : []),
	"",
];
for (const task of tasks) {
	const now = results.filter((run) => run.task === task.id);
	const then = before?.filter((run) => run.task === task.id);
	lines.push(`### ${task.id} (${now.length} runs${then ? `, before: ${then.length}` : ""})`, "");
	lines.push(then ? "| Measure | Before | After |" : "| Measure | Mean |", then ? "|---|---|---|" : "|---|---|");
	for (const [name, pick] of background ? [...COLUMNS, ...BACKGROUND_COLUMNS] : COLUMNS)
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
		`${JSON.stringify({ model, variant, explorerModel, background, commit, runs, spent, stopped, results }, null, 2)}\n`,
	);
