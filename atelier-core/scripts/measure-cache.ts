#!/usr/bin/env node
/**
 * Measures the prompt cache of the anthropic-api backend against the real API.
 * It costs money: a few cents with the default model. Not part of `pnpm check`.
 *
 * Runs a scripted session of five turns on a throwaway copy of a small project,
 * then a sixth request whose system prompt is changed on the wire, to show the
 * API's cache miss report. Prints a Markdown report and writes the raw numbers
 * as JSON.
 *
 *   node atelier-core/scripts/measure-cache.ts [--model <id>] [--json <file>]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	AnthropicApiBackend,
	type AtelierEvent,
	cacheHitRate,
	coreTools,
	costOfRequest,
	DEFAULT_API_MODEL,
	resolveApiKey,
	Session,
	SYSTEM_PROMPT_APPEND,
	type Usage,
} from "../src/index.ts";
import { MEASURE_MAX_REQUESTS_PER_TURN, sumCosts, usd } from "./cost.ts";

const PROMPTS = [
	"Read src/slug.js and test/slug.test.js and explain in two sentences why the second test fails. Do not edit anything.",
	"Fix slugify in src/slug.js so both tests pass. Do not run anything.",
	"Add a test to test/slug.test.js: slugify('') returns ''. Do not run anything.",
	"Run npm test and report the result in one sentence.",
	"Summarize in three short bullets what changed in this session.",
];
const FORCED_MISS_PROMPT = "Reply with the single word OK.";

const PROJECT: Record<string, string> = {
	"package.json":
		'{ "name": "measure-demo", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
	"src/slug.js":
		'/** Turns a title into a URL slug. */\nexport function slugify(title) {\n\treturn title.toLowerCase().replace(/[^a-z0-9]/g, "-");\n}\n',
	"test/slug.test.js": [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { slugify } from "../src/slug.js";',
		"",
		'test("lowercases and joins words with dashes", () => {',
		'\tassert.equal(slugify("Hello World"), "hello-world");',
		"});",
		"",
		'test("collapses repeated separators and trims them", () => {',
		'\tassert.equal(slugify("  Hello,   World!  "), "hello-world");',
		"});",
		"",
	].join("\n"),
};

interface TurnReport {
	turn: number;
	prompt: string;
	stopReason: string;
	requests: number;
	usage: Usage;
	cacheRate: number | undefined;
	costUsd: number | undefined;
	/** The same tokens billed as plain input, as if nothing were cached. */
	costWithoutCacheUsd: number | undefined;
	cacheMisses: { reason: string; missedTokens: number }[];
	errors: string[];
}

const { values } = parseArgs({ options: { model: { type: "string" }, json: { type: "string" } } });
const model = values.model ?? DEFAULT_API_MODEL;

let breakPrefix = false;
/** Changes the system prompt of a request on the wire: what a bug that edits the prefix would do. */
const instrumentedFetch: typeof fetch = async (input, init) => {
	if (!breakPrefix || typeof init?.body !== "string") return fetch(input, init);
	const body = JSON.parse(init.body);
	body.system[0].text = `${body.system[0].text}\n\nToday is a different day.`;
	return fetch(input, { ...init, body: JSON.stringify(body) });
};

const cwd = await mkdtemp(join(tmpdir(), "atelier-measure-"));
const reports: TurnReport[] = [];
try {
	for (const [path, content] of Object.entries(PROJECT)) {
		await mkdir(join(cwd, path, ".."), { recursive: true });
		await writeFile(join(cwd, path), content);
	}
	const backend = new AnthropicApiBackend({ apiKey: await resolveApiKey(), model, fetch: instrumentedFetch });
	const session = await Session.start({
		backend,
		cwd,
		tools: coreTools,
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		maxRequestsPerTurn: MEASURE_MAX_REQUESTS_PER_TURN,
	});
	try {
		for (const [index, prompt] of [...PROMPTS, FORCED_MISS_PROMPT].entries()) {
			breakPrefix = index === PROMPTS.length;
			const events: AtelierEvent[] = [];
			for await (const event of session.send(prompt)) events.push(event);
			const finished = events.find((e) => e.type === "turn_finished");
			if (finished?.type !== "turn_finished") throw new Error(`Turn ${index + 1} did not finish.`);
			const all = finished.usage;
			const plain = costOfRequest(model, {
				input: all.input + all.cacheRead + all.cacheWrite,
				output: all.output,
				cacheRead: 0,
				cacheWrite: 0,
			});
			reports.push({
				turn: index + 1,
				prompt,
				stopReason: finished.stopReason,
				requests: finished.requests ?? 0,
				usage: all,
				cacheRate: cacheHitRate(all),
				costUsd: finished.costUsd,
				costWithoutCacheUsd: plain,
				cacheMisses: events.flatMap((e) =>
					e.type === "cache_miss" ? [{ reason: e.reason, missedTokens: e.missedTokens }] : [],
				),
				errors: events.flatMap((e) => (e.type === "error" ? [`${e.code}: ${e.message}`] : [])),
			});
		}
	} finally {
		await session.close();
	}
} finally {
	await rm(cwd, { recursive: true, force: true });
}

const pct = (value: number | undefined) => (value === undefined ? "—" : `${Math.round(value * 100)}%`);
const sum = (pick: (r: TurnReport) => number, rows: TurnReport[]) => rows.reduce((total, r) => total + pick(r), 0);
const measured = reports.slice(0, PROMPTS.length);

const lines = [
	`Model: ${model}. Turns 1-${PROMPTS.length} are the measured session; turn ${PROMPTS.length + 1} changes the system prompt on purpose.`,
	"",
	"| Turn | Requests | Input | Cache read | Cache write | Output | Cache | Cost | Cost without cache | Cache misses |",
	"|---|---|---|---|---|---|---|---|---|---|",
	...reports.map(
		(r) =>
			`| ${r.turn} | ${r.requests} | ${r.usage.input} | ${r.usage.cacheRead} | ${r.usage.cacheWrite} | ${r.usage.output} | ${pct(r.cacheRate)} | ${usd(r.costUsd)} | ${usd(r.costWithoutCacheUsd)} | ${r.cacheMisses.map((m) => `${m.reason} (${m.missedTokens})`).join(", ") || "—"} |`,
	),
	"",
	`Session (turns 1-${PROMPTS.length}): cost ${usd(sumCosts(measured.map((r) => r.costUsd)))}, without cache ${usd(sumCosts(measured.map((r) => r.costWithoutCacheUsd)))}, cache ${pct(
		cacheHitRate({
			input: sum((r) => r.usage.input, measured),
			output: 0,
			cacheRead: sum((r) => r.usage.cacheRead, measured),
			cacheWrite: sum((r) => r.usage.cacheWrite, measured),
		}),
	)}.`,
];
const errors = reports.flatMap((r) => r.errors.map((e) => `turn ${r.turn}: ${e}`));
if (errors.length > 0) lines.push("", "Errors:", ...errors.map((e) => `- ${e}`));
process.stdout.write(`${lines.join("\n")}\n`);
if (values.json) await writeFile(values.json, `${JSON.stringify({ model, reports }, null, 2)}\n`);
