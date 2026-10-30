import { describeError, excerpt, type PhaseAgent, type Refusal, type Usage, ZERO_USAGE } from "../events.ts";
import { type Candidate, type FreezeResult, holdsCommits } from "./candidate.ts";
import { type Finding, isBlocking, numberFindings, parseFindings } from "./findings.ts";
import { runGit } from "./git.ts";
import { type BudgetExceeded, buildLensPrompts, LENS_INSTRUCTIONS, MAX_LENS_PARTS, readPatch } from "./lenses.ts";
import type { Receipt } from "./receipts.ts";
import type { Assessment, Lens } from "./risk.ts";
import { commitInstruction, parseResults, parseVerdicts, REFUTER_INSTRUCTION, VALIDATOR_INSTRUCTION } from "./roles.ts";

export type RoleName = Lens | "refuter" | "validator";

export type RoleResult =
	| { ok: true; text: string; usage: Usage; costUsd?: number; requests?: number; agents?: PhaseAgent[] }
	| ({
			ok: false;
			error: string;
			usage: Usage;
			costUsd?: number;
			requests?: number;
			agents?: PhaseAgent[];
	  } & Partial<Refusal>);

export interface ReviewDeps {
	/** Runs one read-only subagent over `tree` and returns its final message. */
	runRole(call: {
		role: RoleName;
		instruction: string;
		prompt: string;
		tree: string;
		/** Which part of a change split for the lenses this lens call reviews; absent for a whole change. */
		part?: LensPart;
		/** Model requests the earlier tries of this lens call spent: a second try only gets what they left. */
		used?: number;
		signal?: AbortSignal;
	}): Promise<RoleResult>;
	/** Asks the main agent to correct the findings in one turn. */
	correct(message: string, signal?: AbortSignal): Promise<{ ok: boolean; usage: Usage; costUsd?: number }>;
	/** Freezes the worktree again, after the correction. */
	freeze(): Promise<FreezeResult>;
	now(): Date;
	createId(): string;
}

export interface LensPart {
	index: number;
	count: number;
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
	| { type: "refuter_finished"; confirmed: number; refuted: number; downgraded: number }
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
	let parts = 1;

	const charge = (result: { usage: Usage; costUsd?: number }) => {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		if (result.costUsd !== undefined) cost = (cost ?? 0) + result.costUsd;
	};
	const finish = (verdict: "approved" | "escalated" | "unavailable", reason?: string, refusal?: Refusal): Receipt => ({
		schema: "atelier.review-receipt/v1",
		id: deps.createId(),
		createdAt: deps.now().toISOString(),
		base: candidate.base,
		...(candidate.reviewedBase === undefined ? {} : { previousReview: candidate.reviewedBase.receiptId }),
		candidate: candidate.tree,
		corrected,
		risk: { level: assessment.level, reasons: assessment.reasons },
		lenses: assessment.lenses,
		findings: confirmed,
		refuted,
		followUps,
		correction,
		...(parts > 1 ? { parts } : {}),
		verdict,
		...(verdict === "unavailable" && reason !== undefined ? { unavailableReason: reason } : {}),
		...(verdict === "escalated" && reason !== undefined ? { escalatedReason: reason } : {}),
		...(refusal === undefined ? {} : { cause: refusal.cause }),
		...(refusal?.observed === undefined ? {} : { observed: refusal.observed }),
		usage: total,
		...(cost !== undefined ? { costUsd: cost } : {}),
	});
	const interrupted = () => signal?.aborted === true;
	const stopped = () => finish("unavailable", "interrupted", { cause: "interrupted" });
	/** A role that throws is a role that failed. */
	const callRole = async (
		role: RoleName,
		instruction: string,
		prompt: string,
		tree: string,
		part?: LensPart,
		used?: number,
	): Promise<RoleResult> => {
		try {
			const result = await deps.runRole({
				role,
				instruction,
				prompt,
				tree,
				...(part ? { part } : {}),
				...(used ? { used } : {}),
				...(signal ? { signal } : {}),
			});
			charge(result);
			return result;
		} catch (error) {
			return { ok: false, error: describeError(error), usage: ZERO_USAGE };
		}
	};
	/** A failed role keeps the cause its runner found; otherwise it failed, with its error. */
	const roleFailure = (reply: RoleResult & { ok: false }): Refusal =>
		reply.cause === undefined
			? { cause: "role_failed", observed: excerpt(reply.error) }
			: { cause: reply.cause, ...(reply.observed === undefined ? {} : { observed: reply.observed }) };
	const unreadable = (text: string): Refusal => ({ cause: "invalid_reply", observed: excerpt(text) });
	const tooLarge = (refused: BudgetExceeded): Refusal => ({
		cause: "context_too_large",
		observed: `${refused.bytes} bytes, limit ${refused.limit}`,
	});
	/** The reason names the next action too: the agent reads the reason, not the cause. */
	const refuseSize = (refused: BudgetExceeded) =>
		finish(
			"unavailable",
			`The change is too large to review: ${refused.bytes} bytes, over ${refused.limit} in one part or more than ${MAX_LENS_PARTS} parts. Review smaller candidates: commit in steps, or /review <ref> from a nearer commit.`,
			tooLarge(refused),
		);

	if (interrupted()) return stopped();
	if (assessment.lenses.length === 0) return finish("approved");

	// Every lens prompt is built before any model call, so a refusal costs nothing.
	let patch: string;
	try {
		const read = await readPatch(candidate);
		if (!read.ok) return refuseSize(read);
		patch = read.patch;
	} catch (error) {
		return finish("unavailable", `Could not read the patch: ${describeError(error)}`, {
			cause: "patch_unreadable",
			observed: excerpt(describeError(error)),
		});
	}
	const built = buildLensPrompts({ candidate, patch, reasons: assessment.reasons }, assessment.lenses);
	if (!built.ok) return refuseSize(built);
	const prompts = built.prompts;
	parts = prompts.get(assessment.lenses[0] as Lens)?.length ?? 1;

	const runPart = async (
		lens: Lens,
		prompt: string,
		part: LensPart | undefined,
	): Promise<{ findings: Finding[] } | { error: string; refusal: Refusal }> => {
		let attempt = prompt;
		let used = 0;
		for (let tries = 0; tries < 2; tries++) {
			const reply = await callRole(lens, LENS_INSTRUCTIONS[lens], attempt, candidate.tree, part, used);
			if (!reply.ok) return { error: `Lens ${lens} failed: ${reply.error}`, refusal: roleFailure(reply) };
			// A backend that reports no requests made at least one.
			used += reply.requests ?? 1;
			const parsed = parseFindings(reply.text, lens);
			if (parsed.ok) return { findings: parsed.findings };
			if (tries === 1)
				return {
					error: `Lens ${lens} returned an invalid reply twice: ${parsed.error}`,
					refusal: unreadable(reply.text),
				};
			attempt = `${prompt}\n\nYour previous reply was rejected: ${parsed.error}\nReply again with only the JSON object.`;
		}
		return { error: `Lens ${lens} returned no reply.`, refusal: { cause: "role_failed" } };
	};
	/** Every part of a lens, at once; a failed part fails the lens, and what its other parts found is kept. */
	const runLens = async (
		lens: Lens,
	): Promise<{ findings: Finding[]; failure?: { error: string; refusal: Refusal } }> => {
		const own = prompts.get(lens) as string[];
		const outcomes = await Promise.all(
			own.map((prompt, index) =>
				runPart(lens, prompt, own.length > 1 ? { index: index + 1, count: own.length } : undefined),
			),
		);
		const found = outcomes.flatMap((outcome) => ("findings" in outcome ? outcome.findings : []));
		const failure = outcomes.find((outcome) => "error" in outcome);
		// Each part numbered its findings from 1; joined, they are numbered again so ids stay unique.
		const findings = outcomes.length > 1 ? numberFindings(found, lens) : found;
		return failure !== undefined && "error" in failure ? { findings, failure } : { findings };
	};

	for (const lens of assessment.lenses) yield { type: "lens_started", lens };
	const outcomes = await Promise.all(assessment.lenses.map(runLens));
	const reported: Finding[] = [];
	let failure: { error: string; refusal: Refusal } | undefined;
	for (const outcome of outcomes) {
		if (outcome.failure !== undefined) failure ??= outcome.failure;
		reported.push(...outcome.findings);
	}
	for (const [index, outcome] of outcomes.entries()) {
		const lens = assessment.lenses[index] as Lens;
		yield { type: "lens_finished", lens, ok: outcome.failure === undefined, findings: outcome.findings.length };
	}
	if (interrupted()) return stopped();
	if (failure !== undefined) {
		followUps = reported;
		return finish("unavailable", failure.error, failure.refusal);
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
	if (!reply.ok) return finish("unavailable", `The refuter failed: ${reply.error}`, roleFailure(reply));
	const verdicts = parseVerdicts(reply.text);
	if (!verdicts.ok)
		return finish("unavailable", `The refuter returned an invalid reply: ${verdicts.error}`, unreadable(reply.text));
	const reasons = new Map(verdicts.verdicts.filter((v) => v.verdict === "refuted").map((v) => [v.id, v.reason]));
	const downgraded = new Set(verdicts.verdicts.filter((v) => v.verdict === "downgraded").map((v) => v.id));
	confirmed = toRefute.filter((f) => !reasons.has(f.id) && !downgraded.has(f.id));
	refuted = toRefute.filter((f) => reasons.has(f.id)).map((f) => ({ ...f, reason: reasons.get(f.id) as string }));
	// A downgraded finding stands as a warning: it stops blocking and stays as a follow-up.
	const warnings = toRefute.filter((f) => downgraded.has(f.id)).map((f): Finding => ({ ...f, severity: "warning" }));
	followUps = [...followUps, ...warnings];
	yield {
		type: "refuter_finished",
		confirmed: confirmed.length,
		refuted: refuted.length,
		downgraded: warnings.length,
	};
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
		return finish("escalated", "The correction failed.", { cause: "correction_failed" });
	}
	const frozen = await deps.freeze();
	if (interrupted()) return stopped();
	if (!frozen.ok) {
		yield { type: "correction_finished", ok: false };
		return finish("escalated", `The corrected change could not be frozen: ${frozen.reason}`, {
			cause: "freeze_failed",
			observed: excerpt(frozen.reason),
		});
	}
	corrected = frozen.candidate.tree;
	let used: number;
	try {
		used = await changeSize(candidate.root, candidate.tree, corrected, budget);
	} catch (error) {
		yield { type: "correction_finished", ok: false };
		return finish("escalated", `The correction could not be measured: ${describeError(error)}`, {
			cause: "measure_failed",
			observed: excerpt(describeError(error)),
		});
	}
	correction = { budget, used };
	yield { type: "correction_finished", ok: true, used };
	if (used > budget)
		return finish("escalated", `The correction changed ${used} lines, over the budget of ${budget}.`, {
			cause: "over_budget",
			observed: `${used} lines, budget ${budget}`,
		});

	if (interrupted()) return stopped();
	yield { type: "validator_started", findings: confirmed.length };
	const check = await callRole(
		"validator",
		VALIDATOR_INSTRUCTION,
		`Findings to check:\n${JSON.stringify(confirmed, null, 2)}`,
		corrected,
	);
	if (interrupted()) return stopped();
	if (!check.ok) return finish("escalated", `The validator failed: ${check.error}`, roleFailure(check));
	const results = parseResults(check.text);
	if (!results.ok)
		return finish("escalated", `The validator returned an invalid reply: ${results.error}`, unreadable(check.text));
	const resolved = new Set(results.results.filter((r) => r.resolved).map((r) => r.id));
	const open = confirmed.filter((f) => !resolved.has(f.id));
	yield { type: "validator_finished", resolved: confirmed.length - open.length, unresolved: open.length };
	return open.length === 0
		? finish("approved")
		: finish("escalated", `Unresolved after the correction: ${open.map((f) => f.id).join(", ")}.`, {
				cause: "unresolved_findings",
				observed: open.map((f) => f.id).join(", "),
			});
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
