import {
	type AtelierEventBody,
	describeError,
	type SubagentTag,
	type Usage,
	type VerifyDefect,
	type VerifyOutcome,
	type VerifyRequirement,
	ZERO_USAGE,
} from "../events.ts";
import type { Candidate, FreezeResult } from "./candidate.ts";
import type { RoleResult } from "./reviewer.ts";
import type { Escalation } from "./risk.ts";
import {
	blockingIssues,
	parseVerifierReport,
	unverifiedRequirements,
	VERIFIER_ROUNDS,
	type VerifierDefect,
	verifierCorrectionMessage,
} from "./verifier.ts";

export interface VerificationDeps {
	/** Runs the verifier once over `candidate` and returns its final message. */
	runVerifier(call: {
		verifyId: string;
		candidate: Candidate;
		round: number;
		handedBack?: readonly VerifierDefect[];
	}): Promise<RoleResult>;
	/** Asks the main agent to correct, in one turn. */
	correct(message: string): Promise<{ ok: boolean; usage: Usage; costUsd?: number; requests?: number }>;
	/** Freezes the worktree again, after the correction. */
	freeze(): Promise<FreezeResult>;
	push(event: AtelierEventBody & SubagentTag): void;
	createId(): string;
	aborted(): boolean;
}

function unverifiedReason(unverified: readonly VerifyRequirement[]): string {
	const listed = unverified.map((r) => `${r.id} ${r.requirement} (${r.evidence})`).join("; ");
	return `${unverified.length} unverified ${unverified.length === 1 ? "requirement" : "requirements"}: ${listed}`;
}

/** What the verification cost, to be added to the turn. */
export interface VerificationCost {
	usage: Usage;
	costUsd?: number;
	requests?: number;
}

export interface Verification {
	/** The candidate to carry on with: the last one frozen, which a correction may have changed. */
	candidate: Candidate;
	cost: VerificationCost;
	outcome: VerifyOutcome;
}

/**
 * The verification of a high-risk candidate: the verifier runs, the main agent
 * corrects what it reproduced as a blocking defect (once), the corrected work
 * is frozen and verified again. At most two verifier runs; defects left after
 * the second, or a verifier that failed, end in a result for the user to decide,
 * never in a loop and never in a pass.
 */
export async function verify(
	input: { candidate: Candidate; declaration: readonly Escalation[]; count(requests: number | undefined): void },
	deps: VerificationDeps,
): Promise<Verification> {
	const verifyId = deps.createId();
	const total: Usage = { ...ZERO_USAGE };
	let cost: number | undefined;
	const charge = (result: { usage: Usage; costUsd?: number; requests?: number }) => {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		if (result.costUsd !== undefined) cost = (cost ?? 0) + result.costUsd;
	};
	let current = input.candidate;
	let rounds = 0;
	const finish = (outcome: VerifyOutcome, reason?: string, openDefects: VerifyDefect[] = []): Verification => {
		deps.push({
			type: "verification_finished",
			verifyId,
			outcome,
			...(reason === undefined ? {} : { reason }),
			rounds,
			openDefects,
			usage: { ...total },
			...(cost === undefined ? {} : { costUsd: cost }),
		});
		return {
			candidate: current,
			outcome,
			cost: { usage: total, ...(cost === undefined ? {} : { costUsd: cost }) },
		};
	};

	deps.push({
		type: "verification_started",
		verifyId,
		items: [...new Set(input.declaration.flatMap((entry) => entry.items))].sort((a, b) => a - b),
		declaration: input.declaration.map(({ items, reason }) => ({ items, reason })),
	});
	let handedBack: VerifierDefect[] | undefined;
	for (let round = 1; round <= VERIFIER_ROUNDS; round++) {
		rounds = round;
		let reply: RoleResult;
		try {
			reply = await deps.runVerifier({ verifyId, candidate: current, round, ...(handedBack ? { handedBack } : {}) });
		} catch (error) {
			reply = { ok: false, error: describeError(error), usage: ZERO_USAGE };
		}
		charge(reply);
		const spent = { usage: reply.usage, ...(reply.costUsd === undefined ? {} : { costUsd: reply.costUsd }) };
		const failed = (error: string): Verification => {
			deps.push({
				type: "verification_round",
				verifyId,
				round,
				ok: false,
				error,
				requirements: [],
				defects: [],
				blocking: [],
				correcting: false,
				...spent,
			});
			return finish("failed", error);
		};
		if (deps.aborted()) return failed("interrupted");
		if (!reply.ok) return failed(reply.error);
		const parsed = parseVerifierReport(reply.text);
		if (!parsed.ok) return failed(`The verifier returned an invalid report: ${parsed.error}`);
		const blocking = blockingIssues(parsed.report);
		const unverified = unverifiedRequirements(parsed.report);
		const correcting = blocking.length > 0 && round < VERIFIER_ROUNDS;
		deps.push({
			type: "verification_round",
			verifyId,
			round,
			ok: true,
			requirements: parsed.report.requirements,
			defects: parsed.report.defects,
			blocking: blocking.map((defect) => defect.id),
			correcting,
			...spent,
		});
		// Proof that is partial or missing is a decision for the user, never a pass.
		if (blocking.length === 0) {
			if (unverified.length > 0) return finish("needs_decision", unverifiedReason(unverified));
			return finish(round === 1 ? "passed" : "corrected");
		}
		if (!correcting)
			return finish("needs_decision", unverified.length > 0 ? unverifiedReason(unverified) : undefined, blocking);

		let fixed: Awaited<ReturnType<VerificationDeps["correct"]>>;
		try {
			fixed = await deps.correct(verifierCorrectionMessage(blocking, current.since !== undefined));
		} catch {
			fixed = { ok: false, usage: ZERO_USAGE };
		}
		charge(fixed);
		input.count(fixed.requests);
		if (deps.aborted()) return finish("failed", "interrupted", blocking);
		if (!fixed.ok) return finish("needs_decision", "The correction failed.", blocking);
		const frozen = await deps.freeze();
		if (!frozen.ok)
			return finish("needs_decision", `The corrected work could not be frozen: ${frozen.reason}`, blocking);
		current = frozen.candidate;
		handedBack = blocking;
	}
	// The loop always returns: the last round never corrects.
	return finish("failed", "The verification ended without a result.");
}
