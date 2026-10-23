#!/usr/bin/env node
/**
 * Measures the review of uncommitted changes (RDD, M7) on a real backend. It
 * costs money or subscription usage: four lenses, a refuter, one correction and
 * a validator can cost several times the turn they review. Not part of
 * `pnpm check`.
 *
 * Each scenario runs in its own throwaway git repo under the system temp dir:
 *   high         a seeded defect under src/auth/, reviewed on demand (4 lenses)
 *   medium       an ordinary change in src/format.ts, reviewed on demand (1 lens)
 *   end-of-turn  `send` asks for a small change in src/auth/; consent is granted by code
 * Prints a summary table and writes the full event logs to the scratch directory.
 *
 *   node atelier-core/scripts/measure-review.ts --backend claude-code|anthropic-api [--model <id>] [--json <file>]
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	type AtelierEvent,
	type BackendName,
	BUILTIN_AGENTS,
	coreTools,
	createBackend,
	Session,
	SYSTEM_PROMPT_APPEND,
	type Usage,
} from "../src/index.ts";
import { usd } from "./cost.ts";

const BASE_FILES: Record<string, string> = {
	"package.json":
		'{ "name": "review-demo", "private": true, "type": "module", "scripts": { "test": "node --test test/*.test.ts" } }\n',
	"src/format.ts": [
		"/** Formats an amount of cents as dollars, e.g. 1234 -> $12.34. */",
		"export function formatCents(cents: number): string {",
		"\tconst sign = cents < 0 ? '-' : '';",
		"\tconst abs = Math.abs(cents);",
		"\treturn sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');",
		"}",
		"",
	].join("\n"),
	"src/auth/session.ts": [
		"export interface Token {",
		"\tuser: string;",
		"\t/** Milliseconds since the epoch. */",
		"\texpiresAt: number;",
		"}",
		"",
		"/** A token is valid until the moment it expires. */",
		"export function isTokenValid(token: Token, now: number): boolean {",
		"\treturn token.expiresAt > now;",
		"}",
		"",
	].join("\n"),
	"test/format.test.ts": [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { formatCents } from "../src/format.ts";',
		"",
		'test("formats cents as dollars", () => {',
		'\tassert.equal(formatCents(1234), "$12.34");',
		'\tassert.equal(formatCents(-5), "-$0.05");',
		"});",
		"",
	].join("\n"),
	"test/session.test.ts": [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { isTokenValid } from "../src/auth/session.ts";',
		"",
		'test("a token is valid before it expires and invalid after", () => {',
		'\tconst token = { user: "ana", expiresAt: 1000 };',
		"\tassert.equal(isTokenValid(token, 999), true);",
		"\tassert.equal(isTokenValid(token, 1001), false);",
		"});",
		"",
	].join("\n"),
};

/** The seeded defect: a grace period whose comparison is inverted, so an expired token is accepted. */
const HIGH_CHANGE = [
	"export interface Token {",
	"\tuser: string;",
	"\t/** Milliseconds since the epoch. */",
	"\texpiresAt: number;",
	"}",
	"",
	"/** Clock skew tolerated between the issuer and this server. */",
	"const GRACE_MS = 5_000;",
	"",
	"/** A token is valid until it expires, with a small grace period for clock skew. */",
	"export function isTokenValid(token: Token, now: number): boolean {",
	"\treturn token.expiresAt + GRACE_MS < now;",
	"}",
	"",
].join("\n");

const MEDIUM_CHANGE = [
	"/** Formats an amount of cents as dollars, e.g. 1234 -> $12.34. */",
	"export function formatCents(cents: number): string {",
	"\tconst sign = cents < 0 ? '-' : '';",
	"\tconst abs = Math.abs(cents);",
	"\treturn sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');",
	"}",
	"",
	"/** Formats cents with a currency code, e.g. 1234, 'USD' -> USD 12.34. */",
	"export function formatWithCode(cents: number, code: string): string {",
	"\treturn code + ' ' + formatCents(cents).replace('$', '');",
	"}",
	"",
].join("\n");

const END_OF_TURN_PROMPT =
	"In src/auth/session.ts add an exported function `secondsLeft(token: Token, now: number): number` that returns how many whole seconds remain before the token expires, or 0 if it already expired. Do not run anything.";

interface Measure {
	usage: Usage;
	requests: number;
	/** Unknown when the backend did not report it. */
	costUsd: number | undefined;
}

type Finished = Extract<AtelierEvent, { type: "review_finished" }>;

interface ScenarioReport {
	scenario: "high" | "medium" | "end-of-turn";
	dir: string;
	wallSeconds: number;
	/** The review turn's own `turn_finished` (it includes the correction turn). */
	turn: Measure;
	lenses: { lens: string; ok: boolean; findings: number }[];
	refuter?: { confirmed: number; refuted: number };
	correction?: { ok: boolean; used?: number; budget: number };
	validator?: { resolved: number; unresolved: number };
	finished?: Finished;
	receipt?: unknown;
	testsAfter?: { passed: boolean; output: string };
	/** end-of-turn only: the order of the milestone events. */
	order?: string[];
	errors: string[];
	events: AtelierEvent[];
}

const { values } = parseArgs({
	options: { backend: { type: "string" }, model: { type: "string" }, json: { type: "string" } },
});
if (values.backend !== "claude-code" && values.backend !== "anthropic-api") {
	process.stderr.write("usage: measure-review.ts --backend claude-code|anthropic-api [--model <id>] [--json <file>]\n");
	process.exit(2);
}
const backendName: BackendName = values.backend;
const root = await mkdtemp(join(tmpdir(), `atelier-review-${backendName}-`));

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
			resolve({ code, output: `${stdout}${stderr}` });
		});
	});
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const result = await run("git", args, cwd);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.output}`);
}

async function put(cwd: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(cwd, path)), { recursive: true });
		await writeFile(join(cwd, path), content);
	}
}

async function scratchRepo(name: string): Promise<string> {
	const cwd = join(root, name);
	await mkdir(cwd);
	await git(cwd, "init", "-q");
	await put(cwd, BASE_FILES);
	await git(cwd, "add", "-A");
	await git(cwd, "-c", "user.name=measure", "-c", "user.email=measure@example.invalid", "commit", "-q", "-m", "base");
	return cwd;
}

async function runTests(cwd: string): Promise<{ passed: boolean; output: string }> {
	const result = await run("node", ["--test", "test/format.test.ts", "test/session.test.ts"], cwd);
	return { passed: result.code === 0, output: result.output.split("\n").slice(-30).join("\n") };
}

const empty = (): Measure => ({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0, costUsd: 0 });

async function startSession(cwd: string, consent?: () => Promise<"granted" | "declined">): Promise<Session> {
	const backend = () => createBackend(backendName);
	return Session.start({
		backend: await backend(),
		cwd,
		tools: coreTools,
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		autoApprove: true,
		subagents: { agents: BUILTIN_AGENTS, createBackend: backend },
		review: { createBackend: backend, ...(consent ? { consent } : {}) },
		...(values.model === undefined ? {} : { model: values.model }),
	});
}

function collect(report: ScenarioReport, event: AtelierEvent): void {
	report.events.push(event);
	if (event.type === "error") report.errors.push(`${event.agent ?? "main"} ${event.code}: ${event.message}`);
	if (event.type === "review_finished") report.finished = event;
	if (event.type === "turn_finished" && event.parentCallId === undefined && event.agent === undefined) {
		report.turn.usage = { ...event.usage };
		report.turn.requests = event.requests ?? 0;
		report.turn.costUsd = event.costUsd;
	}
	if (event.type !== "review_progress") return;
	const step = event.step;
	if (step.type === "lens_finished") report.lenses.push({ lens: step.lens, ok: step.ok, findings: step.findings });
	if (step.type === "refuter_finished") report.refuter = { confirmed: step.confirmed, refuted: step.refuted };
	if (step.type === "correction_started") report.correction = { ok: false, budget: step.budget };
	if (step.type === "correction_finished")
		report.correction = {
			budget: report.correction?.budget ?? 0,
			ok: step.ok,
			...(step.used === undefined ? {} : { used: step.used }),
		};
	if (step.type === "validator_finished") report.validator = { resolved: step.resolved, unresolved: step.unresolved };
}

async function finish(report: ScenarioReport, session: Session, started: number): Promise<void> {
	report.wallSeconds = (Date.now() - started) / 1000;
	await session.close();
	const path = report.finished?.receiptPath;
	if (path) report.receipt = JSON.parse(await readFile(path, "utf8"));
	await writeFile(join(root, `${report.scenario}-events.json`), `${JSON.stringify(report.events, null, 2)}\n`);
}

const newReport = (scenario: ScenarioReport["scenario"], dir: string): ScenarioReport => ({
	scenario,
	dir,
	wallSeconds: 0,
	turn: empty(),
	lenses: [],
	errors: [],
	events: [],
});

async function onDemand(scenario: "high" | "medium"): Promise<ScenarioReport> {
	const cwd = await scratchRepo(scenario);
	await put(cwd, scenario === "high" ? { "src/auth/session.ts": HIGH_CHANGE } : { "src/format.ts": MEDIUM_CHANGE });
	const report = newReport(scenario, cwd);
	const session = await startSession(cwd);
	const started = Date.now();
	try {
		for await (const event of session.review()) collect(report, event);
	} finally {
		await finish(report, session, started);
	}
	report.testsAfter = await runTests(cwd);
	return report;
}

async function endOfTurn(): Promise<ScenarioReport> {
	const cwd = await scratchRepo("end-of-turn");
	const report = newReport("end-of-turn", cwd);
	report.order = [];
	const session = await startSession(cwd, async () => "granted");
	const started = Date.now();
	try {
		for await (const event of session.send(END_OF_TURN_PROMPT)) {
			collect(report, event);
			const top = event.parentCallId === undefined && event.agent === undefined;
			if (
				top &&
				(event.type === "review_assessed" ||
					event.type === "review_consent_requested" ||
					event.type === "review_finished" ||
					event.type === "turn_finished")
			)
				report.order.push(event.type);
		}
	} finally {
		await finish(report, session, started);
	}
	report.testsAfter = await runTests(cwd);
	return report;
}

const reports: ScenarioReport[] = [];
for (const scenario of [() => onDemand("high"), () => onDemand("medium"), endOfTurn]) {
	try {
		reports.push(await scenario());
	} catch (error) {
		process.stderr.write(`scenario failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

const prompt = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
const row = (r: ScenarioReport) => {
	const f = r.finished;
	const correction = f?.correction ? `${f.correction.used}/${f.correction.budget}` : "-";
	return `| ${r.scenario} | ${r.lenses.map((l) => `${l.lens}${l.ok ? "" : "!"}(${l.findings})`).join(" ") || "-"} | ${f?.findings.length ?? 0} | ${f?.refuted.length ?? 0} | ${correction} | ${r.validator ? `${r.validator.resolved}/${r.validator.unresolved}` : "-"} | ${f?.verdict ?? "-"} | ${f ? prompt(f.usage) : 0} | ${f?.usage.output ?? 0} | ${f?.usage.cacheRead ?? 0} | ${f?.usage.cacheWrite ?? 0} | ${usd(f?.costUsd)} | ${r.turn.requests} | ${usd(r.turn.costUsd)} | ${r.wallSeconds.toFixed(0)}s | ${r.testsAfter ? (r.testsAfter.passed ? "pass" : "fail") : "-"} |`;
};
const lines = [
	`Backend: ${backendName}${values.model ? `, model ${values.model}` : ""}.`,
	"",
	"| Scenario | Lenses (findings; ! = failed) | Blocking | Refuted | Correction used/budget | Validator resolved/unresolved | Verdict | Review prompt tokens | Review output | Cache read | Cache write | Review cost | Turn requests | Turn cost | Wall | Tests after |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	...reports.map(row),
	"",
];
for (const r of reports) {
	lines.push(`### ${r.scenario}`, "");
	if (r.finished) {
		for (const f of [...r.finished.findings, ...r.finished.followUps])
			lines.push(`- ${f.id} ${f.severity}/${f.cause} (${f.lens}) ${f.path}${f.line ? `:${f.line}` : ""}: ${f.claim}`);
		for (const f of r.finished.refuted) lines.push(`- refuted ${f.id}: ${f.reason}`);
		if (r.finished.reason) lines.push(`- reason: ${r.finished.reason}`);
		lines.push(`- receipt: ${r.finished.receiptPath ?? "none"}`);
	}
	if (r.order) lines.push(`- event order: ${r.order.join(" → ")}`);
	for (const e of r.errors) lines.push(`- error: ${e}`);
	lines.push("");
}
lines.push(`Scratch directory (repos and event logs): ${root}`);
process.stdout.write(`${lines.join("\n")}\n`);
if (values.json)
	await writeFile(
		values.json,
		`${JSON.stringify({ backend: backendName, reports: reports.map(({ events: _, ...r }) => r) }, null, 2)}\n`,
	);
