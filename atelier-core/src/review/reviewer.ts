import { describeError, type Usage, ZERO_USAGE } from "../events.ts";
import { type Candidate, type FreezeResult, holdsCommits } from "./candidate.ts";
import { type Finding, isBlocking, parseFindings } from "./findings.ts";
import { runGit } from "./git.ts";
import { buildLensPrompt, LENS_INSTRUCTIONS, readPatch } from "./lenses.ts";
import type { Receipt } from "./receipts.ts";
import type { Assessment, Lens } from "./risk.ts";
import { commitInstruction, parseResults, parseVerdicts, REFUTER_INSTRUCTION, VALIDATOR_INSTRUCTION } from "./roles.ts";

export type RoleName = Lens | "refuter" | "validator";

export type RoleResult =
	| { ok: true; text: string; usage: Usage; costUsd?: number; requests?: number }
	| { ok: false; error: string; usage: Usage; costUsd?: number; requests?: number };

export interface ReviewDeps {
	/** Runs one read-only subagent over `tree` and returns its final message. */
	runRole(call: {
		role: RoleName;
		instruction: string;
		prompt: string;
		tree: string;
		signal?: AbortSignal;
	}): Promise<RoleResult>;
	/** Asks the main agent to correct the findings in one turn. */
	correct(message: string, signal?: AbortSignal): Promise<{ ok: boolean; usage: Usage; costUsd?: number }>;
	/** Freezes the worktree again, after the correction. */
	freeze(): Promise<FreezeResult>;
	now(): Date;
	createId(): string;
}

export interface ReviewInput {
	candidate: Candidate;
	assessment: Assessment;
	signal?: AbortSignal;
}

/** Plain JSON progress of a review; the session maps these to protocol events. */
export type ReviewProgress =
	| { type: "lens_started"; lens: Lens }
	| { type: "lens_finished"; lens: Lens; ok: boolean; findings: number }
	| { type: "refuter_started"; findings: number }
	| { type: "refuter_finished"; confirmed: number; refuted: number }
	| { type: "correction_started"; budget: number; findings: number }
	| { type: "correction_finished"; ok: boolean; used?: number }
	| { type: "validator_started"; findings: number }
	| { type: "validator_finished"; resolved: number; unresolved: number };

const BUDGET_CAP = 200;
const BUDGET_FLOOR = 2;

/** The correction may change at most half the candidate's changed lines, between 2 and 200. */
export function correctionBudget(changedLines: number): number {
	return Math.max(BUDGET_FLOOR, Math.min(BUDGET_CAP, Math.ceil(changedLines / 2)));
}

type Refuted = Receipt["refuted"][number];

const severe = (finding: Finding) => finding.severity === "blocker" || finding.severity === "critical";

/**
 * Runs the review cycle of an already frozen candidate: the lenses, one
 * refuter call for every severe finding, at most one correction measured
 * against the budget, and one validator call. Whatever happens there is never a
 * second refuter, correction or validator. Returns the receipt; writing it is
 * the caller's decision.
 */
export async function* runReview(input: ReviewInput, deps: ReviewDeps): AsyncGenerator<ReviewProgress, Receipt> {
	const { candidate, assessment, signal } = input;
	const total: Usage = { ...ZERO_USAGE };
	let cost: number | undefined;
	let confirmed: Finding[] = [];
	let refuted: Refuted[] = [];
	let followUps: Finding[] = [];
	let corrected: string | null = null;
	let correction: Receipt["correction"] = null;

	const charge = (result: { usage: Usage; costUsd?: number }) => {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		if (result.costUsd !== undefined) cost = (cost ?? 0) + result.costUsd;
	};
	const finish = (verdict: "approved" | "escalated" | "unavailable", reason?: string): Receipt => ({
		schema: "atelier.review-receipt/v1",
		id: deps.createId(),
		createdAt: deps.now().toISOString(),
		base: candidate.base,
		candidate: candidate.tree,
		corrected,
		risk: { level: assessment.level, reasons: assessment.reasons },
		lenses: assessment.lenses,
		findings: confirmed,
		refuted,
		followUps,
		correction,
		verdict,
		...(verdict === "unavailable" && reason !== undefined ? { unavailableReason: reason } : {}),
		...(verdict === "escalated" && reason !== undefined ? { escalatedReason: reason } : {}),
		usage: total,
		...(cost !== undefined ? { costUsd: cost } : {}),
	});
	const interrupted = () => signal?.aborted === true;
	const stopped = () => finish("unavailable", "interrupted");
	/** A role that throws is a role that failed. */
	const callRole = async (role: RoleName, instruction: string, prompt: string, tree: string): Promise<RoleResult> => {
		try {
			const result = await deps.runRole({ role, instruction, prompt, tree, ...(signal ? { signal } : {}) });
			charge(result);
			return result;
		} catch (error) {
			return { ok: false, error: describeError(error), usage: ZERO_USAGE };
		}
	};

	if (interrupted()) return stopped();
	if (assessment.lenses.length === 0) return finish("approved");

	// Every lens prompt is built before any model call, so a refusal costs nothing.
	let patch: string;
	try {
		const read = await readPatch(candidate);
		if (!read.ok) return finish("unavailable", read.code);
		patch = read.patch;
	} catch (error) {
		return finish("unavailable", `Could not read the patch: ${describeError(error)}`);
	}
	const prompts = new Map<Lens, string>();
	for (const lens of assessment.lenses) {
		const built = buildLensPrompt({ candidate, lens, patch, reasons: assessment.reasons });
		if (!built.ok) return finish("unavailable", built.code);
		prompts.set(lens, built.prompt);
	}

	const runLens = async (lens: Lens): Promise<{ findings: Finding[] } | { error: string }> => {
		const prompt = prompts.get(lens) as string;
		let attempt = prompt;
		for (let tries = 0; tries < 2; tries++) {
			const reply = await callRole(lens, LENS_INSTRUCTIONS[lens], attempt, candidate.tree);
			if (!reply.ok) return { error: `Lens ${lens} failed: ${reply.error}` };
			const parsed = parseFindings(reply.text, lens);
			if (parsed.ok) return { findings: parsed.findings };
			if (tries === 1) return { error: `Lens ${lens} returned an invalid reply twice: ${parsed.error}` };
			attempt = `${prompt}\n\nYour previous reply was rejected: ${parsed.error}\nReply again with only the JSON object.`;
		}
		return { error: `Lens ${lens} returned no reply.` };
	};

	for (const lens of assessment.lenses) yield { type: "lens_started", lens };
	const outcomes = await Promise.all(assessment.lenses.map(runLens));
	const reported: Finding[] = [];
	let failure: string | undefined;
	for (const outcome of outcomes) {
		if ("error" in outcome) failure ??= outcome.error;
		else reported.push(...outcome.findings);
	}
	for (const [index, outcome] of outcomes.entries()) {
		const lens = assessment.lenses[index] as Lens;
		yield "error" in outcome
			? { type: "lens_finished", lens, ok: false, findings: 0 }
			: { type: "lens_finished", lens, ok: true, findings: outcome.findings.length };
	}
	if (interrupted()) return stopped();
	if (failure !== undefined) {
		followUps = reported;
		return finish("unavailable", failure);
	}

	// Blockers caused by the candidate, and severe findings of unknown cause, face the refuter.
	const toRefute = reported.filter((f) => isBlocking(f) || (severe(f) && f.cause === "unknown"));
	followUps = reported.filter((f) => !toRefute.includes(f));
	if (toRefute.length === 0) return finish("approved");

	yield { type: "refuter_started", findings: toRefute.length };
	const prompt = `Findings to refute:\n${JSON.stringify(toRefute, null, 2)}`;
	const reply = await callRole("refuter", REFUTER_INSTRUCTION, prompt, candidate.tree);
	// Until the refuter decides, every severe finding stands, so a failed refuter keeps them on record.
	confirmed = toRefute;
	if (interrupted()) return stopped();
	if (!reply.ok) return finish("unavailable", `The refuter failed: ${reply.error}`);
	const verdicts = parseVerdicts(reply.text);
	if (!verdicts.ok) return finish("unavailable", `The refuter returned an invalid reply: ${verdicts.error}`);
	const reasons = new Map(verdicts.verdicts.filter((v) => v.verdict === "refuted").map((v) => [v.id, v.reason]));
	confirmed = toRefute.filter((f) => !reasons.has(f.id));
	refuted = toRefute.filter((f) => reasons.has(f.id)).map((f) => ({ ...f, reason: reasons.get(f.id) as string }));
	yield { type: "refuter_finished", confirmed: confirmed.length, refuted: refuted.length };
	if (confirmed.length === 0) return finish("approved");

	// The one correction, by the main agent, measured by the core.
	const budget = correctionBudget(candidate.changedLines);
	yield { type: "correction_started", budget, findings: confirmed.length };
	if (interrupted()) return stopped();
	let fixed: Awaited<ReturnType<ReviewDeps["correct"]>>;
	try {
		fixed = await deps.correct(correctionMessage(confirmed, budget, holdsCommits(candidate)), signal);
	} catch {
		fixed = { ok: false, usage: ZERO_USAGE };
	}
	charge(fixed);
	if (interrupted()) return stopped();
	if (!fixed.ok) {
		yield { type: "correction_finished", ok: false };
		return finish("escalated", "The correction failed.");
	}
	const frozen = await deps.freeze();
	if (interrupted()) return stopped();
	if (!frozen.ok) {
		yield { type: "correction_finished", ok: false };
		return finish("escalated", `The corrected change could not be frozen: ${frozen.reason}`);
	}
	corrected = frozen.candidate.tree;
	let used: number;
	try {
		used = await changeSize(candidate.root, candidate.tree, corrected, budget);
	} catch (error) {
		yield { type: "correction_finished", ok: false };
		return finish("escalated", `The correction could not be measured: ${describeError(error)}`);
	}
	correction = { budget, used };
	yield { type: "correction_finished", ok: true, used };
	if (used > budget) return finish("escalated", `The correction changed ${used} lines, over the budget of ${budget}.`);

	if (interrupted()) return stopped();
	yield { type: "validator_started", findings: confirmed.length };
	const check = await callRole(
		"validator",
		VALIDATOR_INSTRUCTION,
		`Findings to check:\n${JSON.stringify(confirmed, null, 2)}`,
		corrected,
	);
	if (interrupted()) return stopped();
	if (!check.ok) return finish("escalated", `The validator failed: ${check.error}`);
	const results = parseResults(check.text);
	if (!results.ok) return finish("escalated", `The validator returned an invalid reply: ${results.error}`);
	const resolved = new Set(results.results.filter((r) => r.resolved).map((r) => r.id));
	const open = confirmed.filter((f) => !resolved.has(f.id));
	yield { type: "validator_finished", resolved: confirmed.length - open.length, unresolved: open.length };
	return open.length === 0
		? finish("approved")
		: finish("escalated", `Unresolved after the correction: ${open.map((f) => f.id).join(", ")}.`);
}

/** The message that asks the main agent for the single correction; `committed`: the turn already committed. */
function correctionMessage(findings: readonly Finding[], budget: number, committed: boolean): string {
	const list = findings.map(
		(f) => `- ${f.id} [${f.severity}] ${f.path}${f.line ? `:${f.line}` : ""}: ${f.claim} (evidence: ${f.evidence})`,
	);
	return [
		"A review of your changes confirmed these defects that the change introduced:",
		...list,
		"",
		`Fix them in this one turn. The correction may change at most ${budget} lines (added plus deleted) compared with the reviewed change; a larger one is not accepted and the review is handed back to the user. ${commitInstruction(committed)}`,
	].join("\n");
}

/** Lines added plus deleted between two trees; a binary change counts as over the budget. */
async function changeSize(root: string, from: string, to: string, budget: number): Promise<number> {
	const result = await runGit(
		["diff-tree", "-r", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "--numstat", from, to],
		{
			cwd: root,
		},
	);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git diff-tree exited with ${result.code}`);
	let lines = 0;
	let binary = false;
	for (const record of result.stdout.toString("utf8").split("\0")) {
		const match = /^(-|\d+)\t(-|\d+)\t/.exec(record);
		if (!match) continue;
		if (match[1] === "-") binary = true;
		else lines += Number(match[1]) + Number(match[2]);
	}
	return binary ? Math.max(lines, budget + 1) : lines;
}
