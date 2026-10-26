import type { AgentBackend } from "../backend.ts";
import {
	type AtelierEventBody,
	describeError,
	errorEvent,
	excerpt,
	type PhaseAgent,
	type PhaseSpent,
	type Refusal,
	type ReviewFinding,
	type ReviewVerdict,
	type SubagentTag,
	type TurnPhase,
	type TurnPhases,
	type Usage,
	ZERO_USAGE,
} from "../events.ts";
import type { ProfileBackend, Role, RoleBackendFactory, RoleSettings, ThinkingLevel } from "../profiles/index.ts";
import { roleStartMessage } from "../profiles/index.ts";
import { DECLARE_RISK_REQUEST } from "../prompt.ts";
import type { Session, SessionOptions } from "../session.ts";
import { addPhaseSpent, addPhases, onePhase, phaseAgent } from "../spent.ts";
import { createBashTool, grepTool, readTool, sandbox } from "../tools/index.ts";
import type { Sandbox } from "../tools/sandbox.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { type Candidate, emptyStartBase, type FreezeOptions, freezeCandidate, readTurnGit } from "./candidate.ts";
import type { Finding } from "./findings.ts";
import { gitText, runGit } from "./git.ts";
import { findReceipt, latestCorrection, type Receipt, writeReceipt } from "./receipts.ts";
import { type ReviewDeps, type RoleName, type RoleResult, runReview } from "./reviewer.ts";
import { type Assessment, assessRisk, type Escalation } from "./risk.ts";
import { createRiskTool, RiskRequests } from "./tool.ts";
import { createTreeTools } from "./tree-tools.ts";
import { undoCorrection } from "./undo.ts";
import { type VerifierRun, verify } from "./verification.ts";
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
	/** A fresh backend for each review role: the one `name` says, or the session's kind when the profile names none. */
	createBackend: RoleBackendFactory;
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
	/** What the session's frozen profile says for `role`; the model is the session's where the entry sets none. */
	settings(role: Role): RoleSettings;
	/** The compaction entry as it applies to a child on the backend `backendId`; undefined when it does not. */
	compaction(backendId: string): { model?: string; thinking?: ThinkingLevel } | undefined;
	/** The active ODD feature document, absolute. */
	feature?: string;
	signal: AbortSignal;
	push(event: AtelierEventBody & SubagentTag): void;
	/** One turn of the main agent inside this turn; `agents`: the main agent, once its backend described it. */
	correct(message: string): Promise<{ ok: boolean } & PhaseSpent>;
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
	/** The reviews this session finished with a receipt, oldest first, and where: what an undo needs. */
	readonly #finished = new Map<string, { root: string; gitDir: string; receipt: Receipt }>();
	/** The candidate trees whose correction this session undid. */
	readonly #undone = new Set<string>();

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

	/**
	 * Undoes the correction an escalated review left in the worktree: the review of this session `reviewId` names,
	 * or the repository's latest escalated one with a correction, found among its receipts whichever session wrote
	 * it. Refuses (with an error event) anything else; true when undone.
	 */
	async undo(host: Pick<ReviewHost, "push" | "cwd">, reviewId?: string): Promise<boolean> {
		const refuse = (code: string, message: string) => {
			host.push(errorEvent(code, message, true));
			return false;
		};
		const found = reviewId === undefined ? await this.#latestCorrection(host.cwd) : this.#finished.get(reviewId);
		if (found === undefined)
			return refuse(
				"no_correction",
				reviewId === undefined
					? "No escalated review of this repository left a correction to undo."
					: `No review ${reviewId} in this session.`,
			);
		const { root, gitDir } = found;
		// The stored receipt knows whether another session undid it; this session's copy stands in when it was not written.
		const stored = await findReceipt(gitDir, found.receipt.candidate);
		const receipt = stored ?? found.receipt;
		const id = reviewId ?? this.#reviewIdOf(receipt) ?? receipt.id;
		if (receipt.verdict !== "escalated")
			return refuse(
				"not_escalated",
				`The review was ${receipt.verdict}, not escalated: there is no correction to undo.`,
			);
		if (receipt.corrected === null) return refuse("no_correction", "The review left no correction in the worktree.");
		if (this.#undone.has(receipt.candidate) || receipt.undoneAt !== undefined)
			return refuse("correction_already_undone", "This correction was already undone.");
		if (receipt.headTree === undefined)
			return refuse(
				"undo_failed",
				"The review's receipt has no tree of HEAD (an older receipt, or HEAD could not be read when the review ended), so a commit of the correction cannot be told; nothing was undone.",
			);
		const result = await undoCorrection(root, receipt.candidate, receipt.corrected, receipt.headTree);
		if (!result.ok) return refuse(result.code, result.message);
		this.#undone.add(receipt.candidate);
		try {
			await writeReceipt(gitDir, { ...receipt, undoneAt: new Date().toISOString() });
		} catch (error) {
			host.push(errorEvent("review_receipt_failed", `The receipt was not updated: ${describeError(error)}`, true));
		}
		host.push({ type: "correction_undone", reviewId: id, restored: result.restored, removed: result.removed });
		return true;
	}

	/** The latest correction among the receipts of `cwd`'s repository; undefined outside one or without any. */
	async #latestCorrection(cwd: string): Promise<{ root: string; gitDir: string; receipt: Receipt } | undefined> {
		try {
			const root = (await gitText(["rev-parse", "--show-toplevel"], { cwd })).trim();
			const gitDir = (await gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root })).trim();
			const receipt = await latestCorrection(gitDir);
			return receipt === undefined ? undefined : { root, gitDir, receipt };
		} catch {
			return undefined;
		}
	}

	/** The id this session gave the review of a receipt, when it ran it. */
	#reviewIdOf(receipt: Receipt): string | undefined {
		return [...this.#finished].find(([, found]) => found.receipt.candidate === receipt.candidate)?.[0];
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
		await this.#finish(host, reviewId, candidate, receipt);
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
		await this.#finish(host, reviewId, candidate, receipt, !interrupted);
		return {
			usage: receipt.usage,
			...(receipt.costUsd === undefined ? {} : { costUsd: receipt.costUsd }),
			...(requests === undefined ? {} : { requests }),
			...(phases === undefined ? {} : { phases }),
		};
	}

	/** Stores the receipt (not for an interrupted review), announces the end, and forgets what the agent raised. */
	async #finish(
		host: ReviewHost,
		reviewId: string,
		candidate: Candidate,
		receipt: Receipt,
		store = true,
	): Promise<void> {
		const { gitDir } = candidate;
		let receiptPath: string | undefined;
		if (store) {
			// HEAD as the review left it: a later commit of the correction is told from what HEAD already held.
			const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { cwd: candidate.root }).catch(
				() => undefined,
			);
			const kept = head?.code === 0 ? { ...receipt, headTree: head.stdout.toString("utf8").trim() } : receipt;
			this.#finished.set(reviewId, { root: candidate.root, gitDir, receipt: kept });
			try {
				receiptPath = await writeReceipt(gitDir, kept);
				// The corrected change is what the worktree holds now: it must not be offered again either.
				if (kept.corrected !== null)
					await writeReceipt(gitDir, { ...kept, candidate: kept.corrected, corrected: null });
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
			...(receipt.cause === undefined ? {} : { cause: receipt.cause }),
			...(receipt.observed === undefined ? {} : { observed: receipt.observed }),
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
		// Who ran: the verifier rounds and the main agent's corrections, in order.
		let ran: PhaseSpent = { usage: ZERO_USAGE };
		const saw = <T extends PhaseSpent>(run: T): T => {
			ran = addPhaseSpent(ran, { usage: ZERO_USAGE, ...(run.agents === undefined ? {} : { agents: run.agents }) });
			return run;
		};
		const result = await verify(
			{ candidate, declaration, count },
			{
				runVerifier: async (call) => saw(await this.#runVerifier(host, declaration, call, count)),
				correct: async (message) => saw(await host.correct(message)),
				freeze: () => freezeCandidate(host.cwd, freezing),
				push: (event) => host.push(event),
				createId: host.createId,
				aborted: () => host.signal.aborted,
			},
		);
		return {
			candidate: result.candidate,
			spent: asPhase("verify", {
				...result.cost,
				...(requests === undefined ? {} : { requests }),
				...(ran.agents === undefined ? {} : { agents: ran.agents }),
			}),
		};
	}

	/** One verifier run: a child session in a throwaway copy of the base and the candidate, removed when it ends. */
	async #runVerifier(
		host: ReviewHost,
		declaration: readonly Escalation[],
		call: { verifyId: string; candidate: Candidate; round: number; handedBack?: readonly VerifierDefect[] },
		count: (requests: number | undefined) => void,
	): Promise<VerifierRun> {
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
			return failedRole(`The verifier's copy could not be made: ${describeError(error)}`, {
				cause: "copy_failed",
				observed: excerpt(describeError(error)),
			});
		}
		try {
			const settings = host.settings("verifier");
			let backend: AgentBackend;
			try {
				backend = await this.#options.createBackend(settings.backend);
			} catch (error) {
				return failedRole(startFailure("The verifier could not start", "verifier", settings, error));
			}
			const compaction = host.compaction(backend.id);
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
			const result = await this.#runChild(
				host,
				{ parentCallId: call.verifyId, agent: "verify:verifier" },
				{
					backend,
					cwd: workspace.dir,
					...(settings.model === undefined ? {} : { model: settings.model }),
					...(settings.thinking === undefined ? {} : { thinking: settings.thinking }),
					...(compaction === undefined ? {} : { compaction }),
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
				undefined,
				ownBackend("verifier", settings),
			);
			return sandboxStatus.available ? result : { ...result, bashUnavailable: sandboxStatus.reason };
		} catch (error) {
			return failedRole(`The verifier could not start: ${describeError(error)}`);
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
		const profileRole: Role = `review-${call.role}`;
		const settings = host.settings(profileRole);
		try {
			const backend = await this.#options.createBackend(settings.backend);
			const compaction = host.compaction(backend.id);
			options = {
				backend,
				...(compaction === undefined ? {} : { compaction }),
				cwd: host.cwd,
				...(settings.model === undefined ? {} : { model: settings.model }),
				...(settings.thinking === undefined ? {} : { thinking: settings.thinking }),
				tools: createTreeTools(candidate.root, call.tree),
				systemPromptAppend: call.instruction,
				createId: host.createId,
			};
		} catch (error) {
			return failedRole(startFailure(`The ${call.role} role could not start`, profileRole, settings, error));
		}
		return this.#runChild(
			host,
			{ parentCallId: reviewId, agent: `review:${call.role}` },
			options,
			call.role,
			call.prompt,
			count,
			call.signal,
			ownBackend(profileRole, settings),
		);
	}

	/** Runs one child session to its final message; its events join the turn's stream under `tag`. */
	async #runChild(
		host: ReviewHost,
		tag: SubagentTag,
		options: SessionOptions,
		role: RoleName | "verifier",
		prompt: string,
		count: (requests: number | undefined) => void,
		signal: AbortSignal | undefined = host.signal,
		/** Set when the profile gives the role its own backend: its failures then name the role and that backend. */
		own?: { role: Role; backend: ProfileBackend },
	): Promise<RoleResult> {
		let child: Session;
		try {
			child = await host.startChild(options);
		} catch (error) {
			if (own) return failedRole(roleStartMessage(own.role, own.backend, error));
			return failedRole(`The ${role} role could not start: ${describeError(error)}`);
		}
		this.#children.add(child);
		const stop = () => void child.interrupt();
		signal?.addEventListener("abort", stop, { once: true });
		try {
			if (signal?.aborted) return failedRole("interrupted", { cause: "interrupted" });
			// Only the text after the role's last tool call is its answer.
			let report = "";
			let failure: string | undefined;
			let stopReason = "incomplete";
			let usage: Usage = ZERO_USAGE;
			let costUsd: number | undefined;
			let requests: number | undefined;
			let agent: PhaseAgent | undefined;
			for await (const event of child.send(prompt)) {
				const { seq: _seq, turnId: _turnId, ...body } = event;
				host.push({ ...body, ...tag });
				if (event.type === "session_started") agent = phaseAgent(role === "verifier" ? role : `review-${role}`, event);
				else if (event.type === "text_delta") report += event.text;
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
			const spent = {
				usage,
				...(costUsd === undefined ? {} : { costUsd }),
				...(requests === undefined ? {} : { requests }),
				...(agent === undefined ? {} : { agents: [agent] }),
			};
			if (stopReason === "error" || stopReason === "interrupted" || failure !== undefined)
				return failedRole(
					`${own ? `${own.role}: ${own.backend}: ` : ""}${stopReason}: ${failure ?? "no details"}`,
					childRefusal(stopReason, failure, requests ?? options.maxRequestsPerTurn),
					spent,
				);
			if (report.trim() === "")
				return failedRole("The role returned no reply.", { cause: "role_failed", observed: "no reply" }, spent);
			return { ok: true, text: report, ...spent };
		} finally {
			signal?.removeEventListener("abort", stop);
			this.#children.delete(child);
			await child.close();
		}
	}
}

/** The role and backend to name in a failure, when the profile gives the role its own backend. */
function ownBackend(role: Role, { backend }: RoleSettings): { role: Role; backend: ProfileBackend } | undefined {
	return backend === undefined ? undefined : { role, backend };
}

/** Why a role could not start: with its own backend the message names the role and the backend. */
function startFailure(plain: string, role: Role, settings: RoleSettings, error: unknown): string {
	if (settings.backend !== undefined) return roleStartMessage(role, settings.backend, error);
	return `${plain}: ${describeError(error)}`;
}

/** A role that did not answer; without a cause it failed, with its error as the value observed. */
function failedRole(
	error: string,
	refusal: Refusal = { cause: "role_failed", observed: excerpt(error) },
	spent: PhaseSpent = { usage: ZERO_USAGE },
): RoleResult {
	return { ok: false, error, ...refusal, ...spent };
}

/** Request limits by backend: Atelier's API backend stops with `turn_limit`, Claude Code with `error_max_turns`. */
const REQUEST_CAP_STOPS = new Set(["turn_limit", "error_max_turns"]);

/** Why a child turn ended without an answer: interrupted, out of model requests, or failed with its error. */
function childRefusal(stopReason: string, failure: string | undefined, requests: number | undefined): Refusal {
	if (stopReason === "interrupted") return { cause: "interrupted" };
	if (REQUEST_CAP_STOPS.has(stopReason))
		return { cause: "request_cap", ...(requests === undefined ? {} : { observed: `${requests} requests` }) };
	return { cause: "role_failed", observed: excerpt(failure ?? stopReason) };
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
