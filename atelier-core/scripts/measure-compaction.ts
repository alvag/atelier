#!/usr/bin/env node
/**
 * Measures context compaction (M8) on a real backend. It costs money or
 * subscription usage. Not part of `pnpm check`.
 *
 * One session in a throwaway directory under the system temp dir, with three
 * large source files whose exported function names the agent must remember:
 *   anthropic-api  a low threshold (--compact-at, default 12000) and a short
 *                  verbatim tail (--keep, default 3000) force a compaction in
 *                  the middle of the first turn; a second turn asks for the
 *                  names without reading; then /compact with instructions and
 *                  a third turn asks again.
 *   claude-code    Claude Code compacts on its own near its window, which a
 *                  short run cannot reach: one turn reads the files, /compact
 *                  with instructions, then a turn asks for the names.
 * Prints a summary and writes the full event log to the scratch directory.
 *
 *   node atelier-core/scripts/measure-compaction.ts --backend claude-code|anthropic-api [--model <id>]
 *     [--compact-at <tokens>] [--keep <tokens>] [--json <file>]
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	type AtelierEvent,
	type BackendName,
	coreTools,
	createBackend,
	Session,
	SYSTEM_PROMPT_APPEND,
} from "../src/index.ts";

const NAMES = { alpha: "computeAlphaChecksum", beta: "normalizeBetaRecords", gamma: "scheduleGammaRetries" } as const;

/** A module of about 4,000 tokens: one exported function and a long block of documentation. */
function module(name: string, fn: string): string {
	const lines = [`/** The ${name} module. */`, ""];
	for (let i = 0; i < 120; i++)
		lines.push(`// ${name} note ${i}: this line documents a detail of the ${name} pipeline that is not needed here.`);
	lines.push("", `export function ${fn}(input: string): string {`, "\treturn input.trim();", "}", "");
	return lines.join("\n");
}

const READ_PROMPT =
	"Read src/alpha.ts, src/beta.ts and src/gamma.ts one at a time with the read tool, then tell me in one line what each file exports.";
const RECALL_PROMPT =
	"Without reading any file again, list the exported function name of src/alpha.ts, src/beta.ts and src/gamma.ts, one per line.";
const COMPACT_INSTRUCTIONS = "Keep the exported function name of every file that was read.";

const { values } = parseArgs({
	options: {
		backend: { type: "string" },
		model: { type: "string" },
		"compact-at": { type: "string" },
		keep: { type: "string" },
		json: { type: "string" },
	},
});
if (values.backend !== "claude-code" && values.backend !== "anthropic-api") {
	process.stderr.write(
		"usage: measure-compaction.ts --backend claude-code|anthropic-api [--model <id>] [--compact-at <tokens>] [--keep <tokens>] [--json <file>]\n",
	);
	process.exit(2);
}
const backendName: BackendName = values.backend;
const compactAt = Number(values["compact-at"] ?? 12_000);
const keepRecentTokens = Number(values.keep ?? 3_000);

const root = await mkdtemp(join(tmpdir(), `atelier-compaction-${backendName}-`));
await mkdir(join(root, "src"));
for (const [name, fn] of Object.entries(NAMES)) await writeFile(join(root, "src", `${name}.ts`), module(name, fn));

interface Step {
	step: string;
	stopReason?: string;
	costUsd?: number;
	requests?: number;
	context?: { tokens: number; window: number; compactAt: number };
	compactions: Extract<AtelierEvent, { type: "compaction_finished" }>[];
	cacheMisses: string[];
	text: string;
	errors: string[];
}

const events: AtelierEvent[] = [];
const steps: Step[] = [];

async function play(step: string, turn: AsyncIterable<AtelierEvent>): Promise<Step> {
	const report: Step = { step, compactions: [], cacheMisses: [], text: "", errors: [] };
	for await (const event of turn) {
		events.push(event);
		if (event.parentCallId !== undefined || event.agent !== undefined) continue;
		if (event.type === "text_delta") report.text += event.text;
		else if (event.type === "compaction_finished") report.compactions.push(event);
		else if (event.type === "cache_miss") report.cacheMisses.push(event.reason);
		else if (event.type === "error") report.errors.push(`${event.code}: ${event.message}`);
		else if (event.type === "turn_finished") {
			report.stopReason = event.stopReason;
			if (event.costUsd !== undefined) report.costUsd = event.costUsd;
			if (event.requests !== undefined) report.requests = event.requests;
			if (event.context !== undefined) report.context = event.context;
		}
	}
	steps.push(report);
	return report;
}

const recalled = (text: string) => Object.values(NAMES).filter((name) => text.includes(name));

const started = Date.now();
const session = await Session.start({
	backend: await createBackend(
		backendName,
		backendName === "anthropic-api" ? { anthropicApi: { compactAt, keepRecentTokens } } : {},
	),
	cwd: root,
	tools: coreTools,
	systemPromptAppend: SYSTEM_PROMPT_APPEND,
	autoApprove: true,
	...(values.model === undefined ? {} : { model: values.model }),
});
try {
	await play("read", session.send(READ_PROMPT));
	if (backendName === "anthropic-api") await play("recall", session.send(RECALL_PROMPT));
	await play("compact", session.compact(COMPACT_INSTRUCTIONS));
	await play("recall after /compact", session.send(RECALL_PROMPT));
} finally {
	await session.close();
}
const wallSeconds = (Date.now() - started) / 1000;
await writeFile(join(root, "events.json"), `${JSON.stringify(events, null, 2)}\n`);

const numbers = new Intl.NumberFormat("en-US");
process.stdout.write(`backend ${backendName} · scratch ${root} · ${wallSeconds.toFixed(0)} s\n`);
if (backendName === "anthropic-api")
	process.stdout.write(`compactAt ${numbers.format(compactAt)} · keep ${numbers.format(keepRecentTokens)}\n`);
for (const step of steps) {
	const cost = step.costUsd === undefined ? "?" : `$${step.costUsd.toFixed(4)}`;
	const context = step.context ? ` · context ${numbers.format(step.context.tokens)}` : "";
	process.stdout.write(`\n${step.step}: ${step.stopReason} · ${step.requests ?? "?"} requests · ${cost}${context}\n`);
	for (const c of step.compactions)
		process.stdout.write(
			`  compaction ${c.reason} ${c.ok ? "ok" : `failed (${c.error})`}: ${numbers.format(c.tokensBefore)} → ${
				c.tokensAfter === undefined ? "?" : numbers.format(c.tokensAfter)
			} tokens · kept ${c.kept} · ${c.costUsd === undefined ? "?" : `$${c.costUsd.toFixed(4)}`}\n`,
		);
	if (step.cacheMisses.length > 0) process.stdout.write(`  cache misses: ${step.cacheMisses.join(", ")}\n`);
	if (step.step.startsWith("recall"))
		process.stdout.write(`  recalled ${recalled(step.text).length}/3: ${recalled(step.text).join(", ")}\n`);
	for (const error of step.errors) process.stdout.write(`  error ${error}\n`);
}
if (values.json !== undefined)
	await writeFile(
		values.json,
		`${JSON.stringify({ backend: backendName, root, wallSeconds, compactAt, keepRecentTokens, steps }, null, 2)}\n`,
	);
