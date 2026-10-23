import type { AgentBackend } from "../backend.ts";
import {
	type AtelierEventBody,
	describeError,
	errorEvent,
	type ReviewFinding,
	type ReviewVerdict,
	type SubagentTag,
	type Usage,
	ZERO_USAGE,
} from "../events.ts";
import { DECLARE_RISK_REQUEST } from "../prompt.ts";
import type { Session, SessionOptions } from "../session.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { type Candidate, freezeCandidate } from "./candidate.ts";
import type { Finding } from "./findings.ts";
import { findReceipt, type Receipt, writeReceipt } from "./receipts.ts";
import { type ReviewDeps, type RoleResult, runReview } from "./reviewer.ts";
import { type Assessment, assessRisk } from "./risk.ts";
import { createRiskTool, RiskRequests } from "./tool.ts";
import { createTreeTools } from "./tree-tools.ts";

export interface ReviewConsentRequest {
	reviewId: string;
	level: string;
	reasons: string[];
	lenses: string[];
}

export interface ReviewOptions {
	/** A fresh backend of the same kind as the session's, for each review role. */
	createBackend: () => AgentBackend | Promise<AgentBackend>;
	/** Asks the user about a high-risk candidate; without it a high-risk change is assessed but never offered. */
	consent?: (request: ReviewConsentRequest) => Promise<"granted" | "declined">;
}

/** What a review cost, to be added to the turn that ran it; `refused` when it did not start. */
export interface Spent {
	usage: Usage;
	costUsd?: number;
	/** Model requests of the roles and the correction, when their backends report them. */
	requests?: number;
	refused?: boolean;
}

/** What the session lends to a review: the turn's stream, its abort signal and the main agent. */
export interface ReviewHost {
	cwd: string;
	model: string | undefined;
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

	constructor(options: ReviewOptions) {
		this.#options = options;
	}

	/** Ends a turn that finished well: assesses the change for free and, if it is due and the user agrees, reviews it. */
	endOfTurn(host: ReviewHost): Promise<Spent> {
		return this.#run(host, false);
	}

	/** The user asked: any risk, no consent, and a receipt does not stop it. */
	onDemand(host: ReviewHost): Promise<Spent> {
		return this.#run(host, true);
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.#children].map((child) => child.close()));
	}

	async #run(host: ReviewHost, manual: boolean): Promise<Spent> {
		const none: Spent = { usage: { ...ZERO_USAGE } };
		const refuse = (code: string, message: string): Spent => {
			host.push(errorEvent(code, message, true));
			return { ...none, refused: true };
		};
		let candidate: Candidate;
		try {
			const frozen = await freezeCandidate(host.cwd);
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

		const assess = () =>
			assessRisk(candidate, {
				escalations: this.#requests.escalations,
				...(this.#requests.none === undefined ? {} : { none: this.#requests.none }),
				...(this.#requests.lens === undefined ? {} : { lens: this.#requests.lens }),
			});
		let assessment = assess();
		// A code change nobody declared the risk of: ask the agent once, inside this turn, then take its word or lack of it.
		let asked: Spent | undefined;
		if (!manual && assessment.declaration?.kind === "missing" && !host.signal.aborted) {
			const answer = await host.correct(DECLARE_RISK_REQUEST);
			asked = {
				usage: answer.usage,
				...(answer.costUsd === undefined ? {} : { costUsd: answer.costUsd }),
				...(answer.requests === undefined ? {} : { requests: answer.requests }),
			};
			assessment = assess();
		}
		const paid = (spent: Spent): Spent => (asked === undefined ? spent : addSpent(asked, spent));
		host.push({
			type: "review_assessed",
			tree: candidate.tree,
			level: assessment.level,
			reasons: assessment.reasons,
			files: assessment.files,
			changedLines: assessment.changedLines,
			lenses: assessment.lenses,
			reviewDue: assessment.reviewDue,
			...(assessment.declaration === undefined ? {} : { declaration: assessment.declaration }),
		});
		const reviewId = host.createId();
		if (!manual) {
			const consent = this.#options.consent;
			if (!assessment.reviewDue || !consent) return paid(none);
			host.push({
				type: "review_consent_requested",
				reviewId,
				level: assessment.level,
				reasons: assessment.reasons,
				lenses: assessment.lenses,
			});
			const answer = await untilAborted(
				host.signal,
				consent({ reviewId, level: assessment.level, reasons: assessment.reasons, lenses: assessment.lenses }),
			).catch((error: unknown) => {
				host.push(errorEvent("review_consent_failed", describeError(error), true));
				return "aborted" as const;
			});
			// An interrupted or failed question is not a refusal: the candidate is offered again.
			if (answer === "aborted") return paid(none);
			if (answer === "declined") return paid(await this.#declined(host, reviewId, candidate, assessment));
		}
		return paid(await this.#cycle(host, reviewId, candidate, assessment));
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
		const deps: ReviewDeps = {
			runRole: (call) => this.#runRole(host, reviewId, candidate, call, count),
			correct: async (message) => {
				const result = await host.correct(message);
				count(result.requests);
				return result;
			},
			freeze: () => freezeCandidate(host.cwd),
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

	/** One read-only role: a child session over the frozen tree, its events nested under the review. */
	async #runRole(
		host: ReviewHost,
		reviewId: string,
		candidate: Candidate,
		call: Parameters<ReviewDeps["runRole"]>[0],
		count: (requests: number | undefined) => void,
	): Promise<RoleResult> {
		const failed = (error: string, usage: Usage = ZERO_USAGE, costUsd?: number): RoleResult => ({
			ok: false,
			error,
			usage,
			...(costUsd === undefined ? {} : { costUsd }),
		});
		let child: Session;
		try {
			child = await host.startChild({
				backend: await this.#options.createBackend(),
				cwd: host.cwd,
				...(host.model === undefined ? {} : { model: host.model }),
				tools: createTreeTools(candidate.root, call.tree),
				systemPromptAppend: call.instruction,
				createId: host.createId,
			});
		} catch (error) {
			return failed(`The ${call.role} role could not start: ${describeError(error)}`);
		}
		this.#children.add(child);
		const signal = call.signal;
		const stop = () => void child.interrupt();
		signal?.addEventListener("abort", stop, { once: true });
		const tag: SubagentTag = { parentCallId: reviewId, agent: `review:${call.role}` };
		try {
			if (signal?.aborted) return failed("interrupted");
			// Only the text after the role's last tool call is its answer.
			let report = "";
			let failure: string | undefined;
			let stopReason = "incomplete";
			let usage: Usage = ZERO_USAGE;
			let costUsd: number | undefined;
			for await (const event of child.send(call.prompt)) {
				const { seq: _seq, turnId: _turnId, ...body } = event;
				host.push({ ...body, ...tag });
				if (event.type === "text_delta") report += event.text;
				else if (event.type === "tool_call_started") report = "";
				else if (event.type === "error") failure ??= `${event.code}: ${event.message}`;
				else if (event.type === "turn_finished") {
					stopReason = event.stopReason;
					usage = event.usage;
					costUsd = event.costUsd;
					count(event.requests);
				}
			}
			if (stopReason === "error" || stopReason === "interrupted" || failure !== undefined)
				return failed(`${stopReason}: ${failure ?? "no details"}`, usage, costUsd);
			if (report.trim() === "") return failed("The role returned no reply.", usage, costUsd);
			return { ok: true, text: report, usage, ...(costUsd === undefined ? {} : { costUsd }) };
		} finally {
			signal?.removeEventListener("abort", stop);
			this.#children.delete(child);
			await child.close();
		}
	}
}

function addSpent(a: Spent, b: Spent): Spent {
	const sum = (x: number | undefined, y: number | undefined) =>
		x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
	const costUsd = sum(a.costUsd, b.costUsd);
	const requests = sum(a.requests, b.requests);
	return {
		usage: {
			input: a.usage.input + b.usage.input,
			output: a.usage.output + b.usage.output,
			cacheRead: a.usage.cacheRead + b.usage.cacheRead,
			cacheWrite: a.usage.cacheWrite + b.usage.cacheWrite,
		},
		...(costUsd === undefined ? {} : { costUsd }),
		...(requests === undefined ? {} : { requests }),
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
