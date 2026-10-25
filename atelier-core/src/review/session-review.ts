import type { AgentBackend } from "../backend.ts";
import {
	type AtelierEventBody,
	describeError,
	errorEvent,
	type PhaseSpent,
	type ReviewFinding,
	type ReviewVerdict,
	type SubagentTag,
	type TurnPhase,
	type TurnPhases,
	type Usage,
	ZERO_USAGE,
} from "../events.ts";
import { DECLARE_RISK_REQUEST } from "../prompt.ts";
import type { Session, SessionOptions } from "../session.ts";
import { addPhaseSpent, addPhases, onePhase } from "../spent.ts";
import { createBashTool, grepTool, readTool, sandbox } from "../tools/index.ts";
import type { Sandbox } from "../tools/sandbox.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { type Candidate, emptyStartBase, type FreezeOptions, freezeCandidate, readTurnGit } from "./candidate.ts";
import type { Finding } from "./findings.ts";
import { runGit } from "./git.ts";
import { findReceipt, type Receipt, writeReceipt } from "./receipts.ts";
import { type ReviewDeps, type RoleName, type RoleResult, runReview } from "./reviewer.ts";
import { type Assessment, assessRisk, type Escalation } from "./risk.ts";
import { createRiskTool, RiskRequests } from "./tool.ts";
import { createTreeTools } from "./tree-tools.ts";
import { verify } from "./verification.ts";
import {
	buildVerifierPrompt,
	VERIFIER_ENV,
	VERIFIER_INSTRUCTION,
	VERIFIER_INSTRUCTION_WITHOUT_BASH,
	VERIFIER_MAX_REQUESTS,
	type VerifierDefect,
} from "./verifier.ts";
import { createWorkspace } from "./workspace.ts";

export interface ReviewConsentRequest {
	reviewId: string;
	level: string;
	reasons: string[];
	lenses: string[];
	/** Why the agent chose the lenses; absent when it did not. */
	lensesReason?: string;
}

export interface ReviewOptions {
	/** A fresh backend of the same kind as the session's, for each review role. */
	createBackend: () => AgentBackend | Promise<AgentBackend>;
	/** Asks the user about a high-risk candidate; without it a high-risk change is assessed but never offered. */
	consent?: (request: ReviewConsentRequest) => Promise<"granted" | "declined">;
	/** The sandbox the verifier's bash runs in; tests pass their own. */
	sandbox?: Sandbox;
}

/**
 * What a review cost, to be added to the turn that ran it; `requests`: model requests of the roles and the
 * corrections, when their backends report them; `phases`: the same by part. `refused` when it did not start.
 */
export interface Spent extends PhaseSpent {
	phases?: TurnPhases;
	refused?: boolean;
}

/** What the session lends to a review: the turn's stream, its abort signal and the main agent. */
export interface ReviewHost {
	cwd: string;
	model: string | undefined;
	/** The active ODD feature document, absolute. */
	feature?: string;
	signal: AbortSignal;
	push(event: AtelierEventBody & SubagentTag): void;
	/** One turn of the main agent inside this turn. */
	correct(message: string): Promise<{ ok: boolean; usage: Usage; costUsd?: number; requests?: number }>;
	startChild(options: SessionOptions): Promise<Session>;
	createId(): string;
}

/** Everything a session needs for RDD: the risk tool's state, the roles, and the once-per-reason status. */
export class SessionReview {
	readonly #options: ReviewOptions;
	readonly #requests = new RiskRequests();
	readonly tool: ToolDefinition = createRiskTool(this.#requests);
	readonly #unavailable = new Set<string>();
	readonly #children = new Set<Session>();
	/** The commit HEAD pointed at when the current turn started; undefined without one. */
	#turnStart: string | undefined;
	/** HEAD had no commit when the current turn started: its reflog then tells its own commits from history it pulled. */
	#startedEmpty = false;
	/** What the user asked in the current turn, verbatim: the verifier's brief. */
	#turnPrompt = "";
	#starting: Promise<void> = Promise.resolve();

	constructor(options: ReviewOptions) {
		this.#options = options;
	}

	/**
	 * A main-agent turn begins: what the agent declared before no longer counts, and the base of its candidate is
	 * today's HEAD. The lookup runs beside the turn and is awaited when the turn ends.
	 */
	startTurn(cwd: string, prompt: string): void {
		this.#requests.clear();
		this.#turnPrompt = prompt;
		this.#turnStart = undefined;
		this.#startedEmpty = false;
		this.#starting = runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd }).then(
			(head) => {
				if (head.code === 0) this.#turnStart = head.stdout.toString("utf8").trim();
				// No commit, or not yet a repository.
				else this.#startedEmpty = true;
			},
			// Not a git repository, or no git: the review reports it when the turn ends.
			() => {},
		);
	}

	/** Ends a turn that finished well: assesses the change for free and, if it is due and the user agrees, reviews it. */
	endOfTurn(host: ReviewHost): Promise<Spent> {
		return this.#run(host, false);
	}

	/** The user asked: any risk, no consent, and a receipt does not stop it. With a `ref`, against that ref's commit instead of HEAD. */
	onDemand(host: ReviewHost, ref?: string): Promise<Spent> {
		return this.#run(host, true, ref);
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.#children].map((child) => child.close()));
	}

	async #run(host: ReviewHost, manual: boolean, ref?: string): Promise<Spent> {
		const none: Spent = { usage: { ...ZERO_USAGE } };
		const refuse = (code: string, message: string): Spent => {
			host.push(errorEvent(code, message, true));
			return { ...none, refused: true };
		};
		await this.#starting;
		// The user's /review measures against HEAD or the ref they gave; the end of a turn, against where the turn started.
		const freezing: FreezeOptions = ref !== undefined ? { ref } : manual ? {} : await this.#startOf(host.cwd);
		let candidate: Candidate;
		try {
			const frozen = await freezeCandidate(host.cwd, freezing);
			if (!frozen.ok) {
				if (manual) return refuse("review_unavailable", frozen.reason);
				if (!this.#unavailable.has(frozen.reason)) {
					this.#unavailable.add(frozen.reason);
					host.push({ type: "review_status", available: false, reason: frozen.reason });
				}
				return none;
			}
			candidate = frozen.candidate;
			if (candidate.files.length === 0)
				return manual ? refuse("nothing_to_review", "There are no changes to review.") : none;
			if (!manual && (await findReceipt(candidate.gitDir, candidate.tree))) return none;
		} catch (error) {
			return manual ? refuse("review_unavailable", describeError(error)) : none;
		}

		const paid = (spent: Spent): Spent => (extra === undefined ? spent : addSpent(extra, spent));
		const assess = () => {
			if (!manual) this.#requests.tree = candidate.tree;
			// The agent's lenses were chosen for the tree its turn assessed; another candidate gets the defaults.
			const chosen = !manual || candidate.tree === this.#requests.tree;
			return assessRisk(candidate, {
				escalations: this.#requests.escalations,
				...(this.#requests.none === undefined ? {} : { none: this.#requests.none }),
				...(!chosen || this.#requests.lenses === undefined ? {} : { lenses: this.#requests.lenses }),
				...(!chosen || this.#requests.lensesReason === undefined ? {} : { lensesReason: this.#requests.lensesReason }),
			});
		};
		let assessment = assess();
		// A code change nobody declared the risk of: ask the agent once, inside this turn, then take its word or lack of it.
		let extra: Spent | undefined;
		if (!manual && assessment.declaration?.kind === "missing" && !host.signal.aborted) {
			const answer = await host.correct(DECLARE_RISK_REQUEST);
			extra = asPhase("declare", answer);
			// The agent may have edited while answering: those edits are part of what gets assessed.
			const again = await freezeCandidate(host.cwd, freezing);
			// The base can move too (a reset or a commit while answering), so it counts as much as the tree.
			if (
				again.ok &&
				(again.candidate.tree !== candidate.tree ||
					again.candidate.baseCommit !== candidate.baseCommit ||
					again.candidate.baseNote !== candidate.baseNote)
			) {
				candidate = again.candidate;
				if (candidate.files.length === 0 || (await findReceipt(candidate.gitDir, candidate.tree))) return paid(none);
			}
			assessment = assess();
		}
		// A declared high-risk item gets an independent verifier before the review; what it makes the agent change is what the review sees.
		if (!manual && assessment.declaration?.kind === "items" && !host.signal.aborted) {
			const verified = await this.#verify(host, candidate, freezing);
			extra = extra === undefined ? verified.spent : addSpent(extra, verified.spent);
			candidate = verified.candidate;
			if (host.signal.aborted) return paid(none);
			if (candidate.files.length === 0 || (await findReceipt(candidate.gitDir, candidate.tree))) return paid(none);
			assessment = assess();
		}
		host.push({
			type: "review_assessed",
			tree: candidate.tree,
			level: assessment.level,
			reasons: assessment.reasons,
			files: assessment.files,
			changedLines: assessment.changedLines,
			lenses: assessment.lenses,
			...lensesReasonOf(assessment),
			reviewDue: assessment.reviewDue,
			...(assessment.declaration === undefined ? {} : { declaration: assessment.declaration }),
			...(candidate.since === undefined ? {} : { since: candidate.since }),
			...(candidate.baseNote === undefined ? {} : { baseNote: candidate.baseNote }),
		});
		const reviewId = host.createId();
		if (!manual) {
			const consent = this.#options.consent;
			if (!assessment.reviewDue || !consent) return paid(none);
			const request: ReviewConsentRequest = {
				reviewId,
				level: assessment.level,
				reasons: assessment.reasons,
				lenses: assessment.lenses,
				...lensesReasonOf(assessment),
			};
			host.push({ type: "review_consent_requested", ...request });
			const answer = await untilAborted(host.signal, consent(request)).catch((error: unknown) => {
				host.push(errorEvent("review_consent_failed", describeError(error), true));
				return "aborted" as const;
			});
			// An interrupted or failed question is not a refusal: the candidate is offered again.
			if (answer === "aborted") return paid(none);
			if (answer === "declined") return paid(await this.#declined(host, reviewId, candidate, assessment));
		}
		return paid(await this.#cycle(host, reviewId, candidate, assessment));
	}

	async #startOf(cwd: string): Promise<FreezeOptions> {
		if (this.#startedEmpty) return emptyStartBase(cwd).catch(() => ({}));
		return this.#turnStart === undefined ? {} : { turnStart: this.#turnStart };
	}

	async #declined(host: ReviewHost, reviewId: string, candidate: Candidate, assessment: Assessment): Promise<Spent> {
		const receipt = receiptOf(host, candidate, assessment, "declined");
		await this.#finish(host, reviewId, candidate.gitDir, receipt);
		return { usage: { ...ZERO_USAGE } };
	}

	async #cycle(host: ReviewHost, reviewId: string, candidate: Candidate, assessment: Assessment): Promise<Spent> {
		let requests: number | undefined;
		const count = (more: number | undefined) => {
			if (more !== undefined) requests = (requests ?? 0) + more;
		};
		// Each role call and the correction, by part; together they are what the receipt's usage and cost add up.
		let phases: TurnPhases | undefined;
		const charge = (phase: TurnPhase, spent: PhaseSpent) => {
			phases = addPhases(phases, onePhase(phase, spent));
		};
		const deps: ReviewDeps = {
			runRole: async (call) => {
				const result = await this.#runRole(host, reviewId, candidate, call, count);
				charge(phaseOfRole(call.role), result);
				return result;
			},
			correct: async (message) => {
				const result = await host.correct(message);
				count(result.requests);
				charge("correction", result);
				return result;
			},
			freeze: () =>
				freezeCandidate(
					host.cwd,
					candidate.baseCommit === undefined ? { fromEmpty: true } : { ref: candidate.baseCommit },
				),
			now: () => new Date(),
			createId: host.createId,
		};
		let receipt: Receipt;
		try {
			const run = runReview({ candidate, assessment, signal: host.signal }, deps);
			for (let next = await run.next(); ; next = await run.next()) {
				if (next.done) {
					receipt = next.value;
					break;
				}
				host.push({ type: "review_progress", reviewId, step: next.value });
			}
		} catch (error) {
			host.push(errorEvent("review_failed", describeError(error), true));
			return { usage: { ...ZERO_USAGE }, refused: true };
		}
		const interrupted = receipt.verdict === "unavailable" && receipt.unavailableReason === "interrupted";
		await this.#finish(host, reviewId, candidate.gitDir, receipt, !interrupted);
		return {
			usage: receipt.usage,
			...(receipt.costUsd === undefined ? {} : { costUsd: receipt.costUsd }),
			...(requests === undefined ? {} : { requests }),
			...(phases === undefined ? {} : { phases }),
		};
	}

	/** Stores the receipt (not for an interrupted review), announces the end, and forgets what the agent raised. */
	async #finish(host: ReviewHost, reviewId: string, gitDir: string, receipt: Receipt, store = true): Promise<void> {
		let receiptPath: string | undefined;
		if (store) {
			try {
				receiptPath = await writeReceipt(gitDir, receipt);
				// The corrected change is what the worktree holds now: it must not be offered again either.
				if (receipt.corrected !== null)
					await writeReceipt(gitDir, { ...receipt, candidate: receipt.corrected, corrected: null });
			} catch (error) {
				host.push(errorEvent("review_receipt_failed", `The receipt was not written: ${describeError(error)}`, true));
			}
		}
		const reason = receipt.unavailableReason ?? receipt.escalatedReason;
		host.push({
			type: "review_finished",
			reviewId,
			verdict: receipt.verdict as ReviewVerdict,
			...(reason === undefined ? {} : { reason }),
			findings: receipt.findings.map(compact),
			refuted: receipt.refuted.map(({ id, reason }) => ({ id, reason })),
			followUps: receipt.followUps.map(compact),
			correction: receipt.correction,
			...(receiptPath === undefined ? {} : { receiptPath }),
			usage: receipt.usage,
			...(receipt.costUsd === undefined ? {} : { costUsd: receipt.costUsd }),
		});
		if (store) this.#requests.clear();
	}

	/** The independent verifier over the turn's candidate, up to two rounds with a correction between them. */
	async #verify(
		host: ReviewHost,
		candidate: Candidate,
		freezing: FreezeOptions,
	): Promise<{ candidate: Candidate; spent: Spent }> {
		let requests: number | undefined;
		const count = (more: number | undefined) => {
			if (more !== undefined) requests = (requests ?? 0) + more;
		};
		const declaration = [...this.#requests.escalations];
		const result = await verify(
			{ candidate, declaration, count },
			{
				runVerifier: (call) => this.#runVerifier(host, declaration, call, count),
				correct: (message) => host.correct(message),
				freeze: () => freezeCandidate(host.cwd, freezing),
				push: (event) => host.push(event),
				createId: host.createId,
				aborted: () => host.signal.aborted,
			},
		);
		return {
			candidate: result.candidate,
			spent: asPhase("verify", { ...result.cost, ...(requests === undefined ? {} : { requests }) }),
		};
	}

	/** One verifier run: a child session in a throwaway copy of the base and the candidate, removed when it ends. */
	async #runVerifier(
		host: ReviewHost,
		declaration: readonly Escalation[],
		call: { verifyId: string; candidate: Candidate; round: number; handedBack?: readonly VerifierDefect[] },
		count: (requests: number | undefined) => void,
	): Promise<RoleResult> {
		const { candidate } = call;
		let workspace: Awaited<ReturnType<typeof createWorkspace>>;
		try {
			workspace = await createWorkspace({
				root: candidate.root,
				base: candidate.base,
				tree: candidate.tree,
				...(host.feature === undefined ? {} : { feature: host.feature }),
			});
		} catch (error) {
			return { ok: false, error: `The verifier's copy could not be made: ${describeError(error)}`, usage: ZERO_USAGE };
		}
		try {
			const sandboxStatus = await (this.#options.sandbox ?? sandbox).status();
			// Without it the verifier marks the branch and commit requirements unverified, as it would anyway.
			const git = await readTurnGit(candidate).catch(() => undefined);
			const prompt = buildVerifierPrompt({
				request: this.#turnPrompt,
				...(workspace.feature === undefined ? {} : { feature: workspace.feature }),
				declaration,
				candidate,
				round: call.round,
				...(call.handedBack === undefined ? {} : { handedBack: call.handedBack }),
				dependencies: workspace.dependencies,
				...(sandboxStatus.available ? {} : { bashUnavailable: sandboxStatus.reason }),
				...(git === undefined ? {} : { git }),
			});
			return await this.#runChild(
				host,
				{ parentCallId: call.verifyId, agent: "verify:verifier" },
				{
					backend: await this.#options.createBackend(),
					cwd: workspace.dir,
					...(host.model === undefined ? {} : { model: host.model }),
					// Without the sandbox the verifier has no way to stay in its copy or off the network: it gets no bash.
					tools: sandboxStatus.available
						? [
								readTool,
								grepTool,
								createBashTool({
									withoutApproval: true,
									env: VERIFIER_ENV,
									policy: "verifier",
									...(this.#options.sandbox ? { sandbox: this.#options.sandbox } : {}),
								}),
							]
						: [readTool, grepTool],
					systemPromptAppend: sandboxStatus.available ? VERIFIER_INSTRUCTION : VERIFIER_INSTRUCTION_WITHOUT_BASH,
					maxRequestsPerTurn: VERIFIER_MAX_REQUESTS,
					createId: host.createId,
				},
				"verifier",
				prompt,
				count,
			);
		} catch (error) {
			return { ok: false, error: `The verifier could not start: ${describeError(error)}`, usage: ZERO_USAGE };
		} finally {
			await workspace.remove();
		}
	}

	/** One read-only role: a child session over the frozen tree, its events nested under the review. */
	async #runRole(
		host: ReviewHost,
		reviewId: string,
		candidate: Candidate,
		call: Parameters<ReviewDeps["runRole"]>[0],
		count: (requests: number | undefined) => void,
	): Promise<RoleResult> {
		let options: SessionOptions;
		try {
			options = {
				backend: await this.#options.createBackend(),
				cwd: host.cwd,
				...(host.model === undefined ? {} : { model: host.model }),
				tools: createTreeTools(candidate.root, call.tree),
				systemPromptAppend: call.instruction,
				createId: host.createId,
			};
		} catch (error) {
			return failedRole(`The ${call.role} role could not start: ${describeError(error)}`);
		}
		return this.#runChild(
			host,
			{ parentCallId: reviewId, agent: `review:${call.role}` },
			options,
			call.role,
			call.prompt,
			count,
			call.signal,
		);
	}

	/** Runs one child session to its final message; its events join the turn's stream under `tag`. */
	async #runChild(
		host: ReviewHost,
		tag: SubagentTag,
		options: SessionOptions,
		role: string,
		prompt: string,
		count: (requests: number | undefined) => void,
		signal: AbortSignal | undefined = host.signal,
	): Promise<RoleResult> {
		let child: Session;
		try {
			child = await host.startChild(options);
		} catch (error) {
			return failedRole(`The ${role} role could not start: ${describeError(error)}`);
		}
		this.#children.add(child);
		const stop = () => void child.interrupt();
		signal?.addEventListener("abort", stop, { once: true });
		try {
			if (signal?.aborted) return failedRole("interrupted");
			// Only the text after the role's last tool call is its answer.
			let report = "";
			let failure: string | undefined;
			let stopReason = "incomplete";
			let usage: Usage = ZERO_USAGE;
			let costUsd: number | undefined;
			let requests: number | undefined;
			for await (const event of child.send(prompt)) {
				const { seq: _seq, turnId: _turnId, ...body } = event;
				host.push({ ...body, ...tag });
				if (event.type === "text_delta") report += event.text;
				else if (event.type === "tool_call_started") report = "";
				else if (event.type === "error") failure ??= `${event.code}: ${event.message}`;
				else if (event.type === "turn_finished") {
					stopReason = event.stopReason;
					usage = event.usage;
					costUsd = event.costUsd;
					requests = event.requests;
					count(event.requests);
				}
			}
			if (stopReason === "error" || stopReason === "interrupted" || failure !== undefined)
				return failedRole(`${stopReason}: ${failure ?? "no details"}`, usage, costUsd, requests);
			if (report.trim() === "") return failedRole("The role returned no reply.", usage, costUsd, requests);
			return {
				ok: true,
				text: report,
				usage,
				...(costUsd === undefined ? {} : { costUsd }),
				...(requests === undefined ? {} : { requests }),
			};
		} finally {
			signal?.removeEventListener("abort", stop);
			this.#children.delete(child);
			await child.close();
		}
	}
}

function failedRole(error: string, usage: Usage = ZERO_USAGE, costUsd?: number, requests?: number): RoleResult {
	return {
		ok: false,
		error,
		usage,
		...(costUsd === undefined ? {} : { costUsd }),
		...(requests === undefined ? {} : { requests }),
	};
}

/** The four lenses are one part of the turn; the refuter and the validator are one each. */
function phaseOfRole(role: RoleName): TurnPhase {
	return role === "refuter" || role === "validator" ? role : "lenses";
}

/** A cost that is all one part of the turn. */
function asPhase(phase: TurnPhase, spent: PhaseSpent): Spent {
	return { ...addPhaseSpent(spent, { usage: ZERO_USAGE }), phases: onePhase(phase, spent) };
}

function addSpent(a: Spent, b: Spent): Spent {
	const phases = addPhases(a.phases, b.phases);
	return {
		...addPhaseSpent(a, b),
		...(phases === undefined ? {} : { phases }),
		...(b.refused ? { refused: true } : {}),
	};
}

function receiptOf(host: ReviewHost, candidate: Candidate, assessment: Assessment, verdict: "declined"): Receipt {
	return {
		schema: "atelier.review-receipt/v1",
		id: host.createId(),
		createdAt: new Date().toISOString(),
		base: candidate.base,
		candidate: candidate.tree,
		corrected: null,
		risk: { level: assessment.level, reasons: assessment.reasons },
		lenses: assessment.lenses,
		findings: [],
		refuted: [],
		followUps: [],
		correction: null,
		verdict,
		usage: { ...ZERO_USAGE },
	};
}

function compact({ line, ...rest }: Finding): ReviewFinding {
	return line === undefined ? rest : { ...rest, line };
}

/** Resolves "aborted" when the signal fires first; the abandoned promise is left alone. */
function untilAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T | "aborted"> {
	if (signal.aborted) return Promise.resolve("aborted");
	return new Promise((resolve, reject) => {
		const onAbort = () => resolve("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function lensesReasonOf(assessment: Assessment): { lensesReason?: string } {
	return assessment.lensesReason === undefined ? {} : { lensesReason: assessment.lensesReason };
}
