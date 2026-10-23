#!/usr/bin/env node
/**
 * Measures what delegating to a subagent does to the parent's context, on the
 * real API. It costs money: a few cents with the default model. Not part of
 * `pnpm check`.
 *
 * Asks the same code question twice on a throwaway copy of atelier-core/src:
 * once answered directly, once through the explorer subagent. Each session then
 * gets a one-line follow-up whose prompt size shows how much context the parent
 * kept. Prints a Markdown report and writes the raw numbers as JSON.
 *
 *   node atelier-core/scripts/measure-subagents.ts [--model <id>] [--json <file>]
 */
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { addCost, usd } from "./cost.ts";

const QUESTION =
	"How does Session make sure every turn ends with exactly one turn_finished event, even when the backend throws, the turn is interrupted or the backend never sends one? Answer with path:line references.";
const DELEGATED = `Use the explorer subagent to answer this question, then give me its answer: ${QUESTION}`;
const FOLLOW_UP = "In one sentence: which file holds that logic?";

interface Measure {
	usage: Usage;
	requests: number;
	/** Unknown as soon as one turn did not report its cost. */
	costUsd: number | undefined;
}

interface ModeReport {
	mode: "direct" | "delegated";
	parent: Measure;
	subagents: Measure;
	/** Prompt tokens of the follow-up's request: about the size of the parent's context. */
	followUpPrompt: number;
	followUpCostUsd: number | undefined;
	answer: string;
	errors: string[];
}

const { values } = parseArgs({ options: { model: { type: "string" }, json: { type: "string" } } });
const model = values.model ?? DEFAULT_API_MODEL;
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

async function measure(mode: ModeReport["mode"]): Promise<ModeReport> {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-subagents-"));
	await cp(source, join(cwd, "src"), { recursive: true });
	const backend = () => new AnthropicApiBackend({ apiKey, model });
	const session = await Session.start({
		backend: backend(),
		cwd,
		tools: coreTools,
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		...(mode === "delegated" ? { subagents: { agents: BUILTIN_AGENTS, createBackend: backend } } : {}),
	});
	const report: ModeReport = {
		mode,
		parent: empty(),
		subagents: empty(),
		followUpPrompt: 0,
		followUpCostUsd: 0,
		answer: "",
		errors: [],
	};
	try {
		for await (const event of session.send(mode === "direct" ? QUESTION : DELEGATED)) {
			if (event.type === "error") report.errors.push(`${event.agent ?? "parent"} ${event.code}: ${event.message}`);
			if (event.type === "text_delta" && event.parentCallId === undefined) report.answer += event.text;
			if (event.type === "tool_call_started" && event.parentCallId === undefined) report.answer = "";
			if (event.type === "turn_finished")
				add(event.parentCallId === undefined ? report.parent : report.subagents, event);
		}
		for await (const event of session.send(FOLLOW_UP)) {
			if (event.type === "turn_finished" && event.parentCallId === undefined) {
				report.followUpPrompt = prompt(event.usage);
				report.followUpCostUsd = event.costUsd;
			}
		}
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
	return report;
}

const reports = [await measure("direct"), await measure("delegated")];

const row = (r: ModeReport) =>
	`| ${r.mode} | ${r.parent.requests} | ${prompt(r.parent.usage)} | ${r.parent.usage.output} | ${usd(r.parent.costUsd)} | ${r.subagents.requests} | ${prompt(r.subagents.usage)} | ${usd(r.subagents.costUsd)} | ${usd(addCost(r.parent.costUsd, r.subagents.costUsd))} | ${r.followUpPrompt} | ${usd(r.followUpCostUsd)} |`;
const lines = [
	`Model: ${model} (subagent: explorer's model on this backend).`,
	"",
	"| Mode | Parent requests | Parent prompt tokens | Parent output | Parent cost | Subagent requests | Subagent prompt tokens | Subagent cost | Question total | Follow-up prompt tokens | Follow-up cost |",
	"|---|---|---|---|---|---|---|---|---|---|---|",
	...reports.map(row),
	"",
	...reports.flatMap((r) => [`### ${r.mode} answer`, "", r.answer.trim(), ""]),
];
const errors = reports.flatMap((r) => r.errors.map((e) => `${r.mode}: ${e}`));
if (errors.length > 0) lines.push("Errors:", ...errors.map((e) => `- ${e}`));
process.stdout.write(`${lines.join("\n")}\n`);
if (values.json) await writeFile(values.json, `${JSON.stringify({ model, reports }, null, 2)}\n`);
