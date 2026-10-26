/**
 * Event contract emitted by the core. Every event is plain JSON so a client can
 * receive it over a pipe unchanged (M2).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** "other": no API key, but no confirmed subscription either (bearer token, cloud provider...). */
export type AuthSource = "subscription" | "api_key" | "other" | "none";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export const PHASES = [
	"authorizing",
	"exploring",
	"deciding",
	"planning",
	"implementing",
	"checking",
	"closing",
] as const;
export type Phase = (typeof PHASES)[number];

/** A task as clients see it; status is absent for documents without an Estado column. */
export interface FeatureTask {
	id: string;
	title: string;
	specs: string[];
	status?: string;
	commit?: string;
}

/** A review finding as clients see it (the frozen-tree evidence is a `path:line` reference). */
export interface ReviewFinding {
	id: string;
	lens: string;
	severity: string;
	cause: string;
	path: string;
	line?: number;
	claim: string;
	evidence: string;
}

/** One step of a review's cycle, in the order the core takes them. */
export type ReviewStep =
	| { type: "lens_started"; lens: string }
	| { type: "lens_finished"; lens: string; ok: boolean; findings: number }
	| { type: "refuter_started"; findings: number }
	| { type: "refuter_finished"; confirmed: number; refuted: number }
	| { type: "correction_started"; budget: number; findings: number }
	| { type: "correction_finished"; ok: boolean; used?: number }
	| { type: "validator_started"; findings: number }
	| { type: "validator_finished"; resolved: number; unresolved: number };

/**
 * The parts of a turn, in the order they run: the main agent, the request to declare the risk, the verifier and
 * its correction, and the review's lenses, refuter, correction and validator.
 */
export const TURN_PHASES = ["main", "declare", "verify", "lenses", "refuter", "correction", "validator"] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

/** One agent that ran in a part of a turn: its profile role, and the backend, model and effort its `session_started` said. */
export interface PhaseAgent {
	role: string;
	backend: string;
	model: string;
	effort?: Effort | "off" | "unsupported";
}

/**
 * What one part of a turn cost; `requests` and `costUsd` are absent when its backends do not report them.
 * `agents`: who ran in it, each once, in the order they first ran; absent when none said `session_started`.
 */
export interface PhaseSpent {
	usage: Usage;
	requests?: number;
	costUsd?: number;
	agents?: PhaseAgent[];
}

/** A turn's cost by part; a part that did not run is absent. */
export type TurnPhases = Partial<Record<TurnPhase, PhaseSpent>>;

/** Context tokens the next request carries, the model's window, and where compaction starts. */
export interface ContextUsage {
	tokens: number;
	window: number;
	compactAt: number;
}

export type CompactionReason = "threshold" | "overflow" | "manual";

/** What the agent declared about the risk of a code change: high-risk items, none, or nothing at all. */
export type RiskDeclaration =
	| { kind: "items"; items: { items: number[]; reason: string }[] }
	| { kind: "none"; reason: string }
	| { kind: "missing" };

/** What the independent verifier concluded about one requirement it derived from the user's request. */
export interface VerifyRequirement {
	id: string;
	requirement: string;
	verdict: "met" | "unmet" | "unverified";
	evidence: string;
}

/** A defect the verifier reproduced on the candidate; `onBase`: it happens on the version before the turn too, so it is advisory. */
export interface VerifyDefect {
	id: string;
	severity: "blocker" | "major" | "minor";
	summary: string;
	reproduction: string;
	candidate: string;
	base: string;
	onBase: boolean;
}

export type VerifyOutcome = "passed" | "corrected" | "needs_decision" | "failed";

export type ReviewVerdict = "approved" | "escalated" | "declined" | "unavailable";

/** Why the verifier or a review ended without a pass: a closed set, so clients and logs never get only a generic message. */
export const REFUSAL_CAUSES = [
	"interrupted",
	"role_failed",
	"request_cap",
	"invalid_report",
	"missing_requirements",
	"invalid_reply",
	"context_too_large",
	"patch_unreadable",
	"copy_failed",
	"sandbox_unavailable",
	"correction_failed",
	"freeze_failed",
	"measure_failed",
	"over_budget",
	"unverified_requirements",
	"open_defects",
	"unresolved_findings",
] as const;
export type RefusalCause = (typeof REFUSAL_CAUSES)[number];

/** A cause and, when there is one, the value observed: bytes, lines, requests, ids, or the start of an unreadable reply. */
export interface Refusal {
	cause: RefusalCause;
	observed?: string;
}

const EXCERPT_CHARS = 200;

/** The start of a reply or an error on one line, cut at 200 characters. */
export function excerpt(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line;
}

/** What clients show for a refusal: the cause and the value observed, else the reason, else that none was given. */
export function describeRefusal(event: { cause?: RefusalCause; observed?: string; reason?: string }): string {
	if (event.cause === undefined) return event.reason ?? "no reason given";
	return event.observed === undefined ? event.cause : `${event.cause} (${event.observed})`;
}

/** Anthropic's reasoning effort levels, from the cheapest to the most thorough. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** What a profile entry sets for a role; an absent field is inherited. */
export interface ProfileRoleEntry {
	backend?: string;
	model?: string;
	thinking?: string;
}

/**
 * The profile a session froze at start: its name (absent for the default profile), the layer it came from
 * (`explicit`, `local-pin`, `repo`, `active`, `default`) and what it sets for each role but the orchestrator,
 * in the order of the roles; the orchestrator is the event's own `backend`, `model` and `effort`.
 */
export interface SessionProfile {
	name?: string;
	origin: "explicit" | "local-pin" | "repo" | "active" | "default";
	roles: { [role: string]: ProfileRoleEntry };
}

export type AtelierEventBody =
	/**
	 * `effort`: the thinking level asked for, as sent with every request: the reasoning effort, `off` when thinking
	 * was turned off, or `unsupported` when the model cannot take that level. Absent when no level was asked.
	 * `profile`: the main session's frozen profile, when it resolved one; set by the session.
	 */
	| {
			type: "session_started";
			backend: string;
			model: string;
			authSource: AuthSource;
			effort?: Effort | "off" | "unsupported";
			profile?: SessionProfile;
			/** Set by the session: how much it asks before a tool call. */
			permissionMode?: "normal" | "auto" | "yolo";
	  }
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_call_started"; callId: string; tool: string; input: JsonValue }
	| {
			type: "tool_call_finished";
			callId: string;
			ok: boolean;
			summary: string;
			truncated: boolean;
			fullOutputPath?: string;
			/** What the sandbox blocked in the call, as short causes (`write to /x (...)`); absent when it reported nothing. */
			blocked?: string[];
	  }
	/** Sent first in a session's first turn when `bash` exists: whether its commands run in the sandbox, with what, or why not. */
	| { type: "sandbox_status"; sandboxed: boolean; mechanism?: string; reason?: string }
	/** `bash` runs without the sandbox, so every command asks: said once per turn, before the first question. */
	| { type: "sandbox_warning"; reason: string }
	/** `reason`: the agent asked to run the command outside the sandbox, and says why. */
	| { type: "approval_requested"; callId: string; command: string; reason?: string; tool?: string }
	/**
	 * `requests`: model requests the turn made, when the backend knows it; `context`: how full the context is, when known.
	 * `durationMs`: wall time of the whole turn, tools and end-of-turn review included; set by the session.
	 * `phases`: the same usage, requests and cost by part of the turn, summing to the totals; set by the session.
	 */
	| {
			type: "turn_finished";
			stopReason: string;
			usage: Usage;
			costUsd?: number;
			requests?: number;
			durationMs?: number;
			context?: ContextUsage;
			phases?: TurnPhases;
	  }
	/** The core started summarizing the older history; `tokens` is the context size that led to it. */
	| { type: "compaction_started"; reason: CompactionReason; tokens: number }
	/** `tokensAfter` is an estimate until the next request measures it; `kept`: messages kept verbatim. */
	| {
			type: "compaction_finished";
			ok: boolean;
			reason: CompactionReason;
			tokensBefore: number;
			tokensAfter?: number;
			kept: number;
			usage: Usage;
			costUsd?: number;
			error?: string;
	  }
	/** The prompt cache could not reuse the previous prefix; `reason` is the API's (`system_changed`...). */
	| { type: "cache_miss"; reason: string; missedTokens: number }
	| { type: "phase_changed"; phase: Phase; source: "inferred" | "declared" }
	/** Sent first in a session's first turn: whether long-term memory works, for which project, or why not. */
	| { type: "memory_status"; available: boolean; project?: string; reason?: string }
	/** Sent first in a session's first turn when AGENTS.md / CLAUDE.md files were found: those added to the system prompt, and those left out by the size cap. */
	| { type: "project_instructions"; files: string[]; dropped: string[] }
	/** The active ODD feature document changed. */
	| { type: "feature_changed"; name: string; path: string; title: string; tasks: FeatureTask[] }
	/** Whether the review of uncommitted changes (RDD) works in this session; sent when it does not, once per reason. */
	| { type: "review_status"; available: boolean; reason?: string }
	/** The free, deterministic risk of the change a turn left (`declaration`: what the agent said about it; absent for documentation). `reviewDue`: only high risk is offered a review. */
	| {
			type: "review_assessed";
			tree: string;
			level: "passive" | "medium" | "high";
			reasons: string[];
			files: string[];
			changedLines: number;
			lenses: string[];
			/** Why the agent chose the lenses; absent when it did not. */
			lensesReason?: string;
			reviewDue: boolean;
			declaration?: RiskDeclaration;
			/** Short id of the commit the change is measured against, when it is not the current HEAD (the turn's commits are included). */
			since?: string;
			/** Why the base is the current HEAD although the turn started earlier (a reset or rebase), or the empty tree (the turn started without commits). */
			baseNote?: string;
	  }
	/** The core waits for session.review_consent; the turn stays open until it is answered. */
	| {
			type: "review_consent_requested";
			reviewId: string;
			level: string;
			reasons: string[];
			lenses: string[];
			lensesReason?: string;
	  }
	/** Progress of a review the user agreed to or asked for; role events follow tagged `agent: "review:<role>"`. */
	| { type: "review_progress"; reviewId: string; step: ReviewStep }
	| {
			type: "review_finished";
			reviewId: string;
			verdict: ReviewVerdict;
			reason?: string;
			/** Why an `escalated` or `unavailable` review ended so, and the value observed. */
			cause?: RefusalCause;
			observed?: string;
			/** Confirmed blocking findings. */
			findings: ReviewFinding[];
			refuted: { id: string; reason: string }[];
			followUps: ReviewFinding[];
			correction: { budget: number; used: number } | null;
			/** Absent when no receipt was written (an interrupted review). */
			receiptPath?: string;
			usage: Usage;
			costUsd?: number;
	  }
	/** An escalated review's correction was undone: `restored` got the candidate's version back (modified or deleted by the correction), `removed` were created by it. */
	| { type: "correction_undone"; reviewId: string; restored: string[]; removed: string[] }
	/** The core launched the independent verifier for a declared high-risk item; its events follow tagged `agent: "verify:verifier"` under `verifyId`. */
	| {
			type: "verification_started";
			verifyId: string;
			items: number[];
			declaration: { items: number[]; reason: string }[];
	  }
	/**
	 * One verifier run. `ok: false` (with `error`): it failed or its report was malformed; nothing else is known.
	 * `blocking`: ids of the defects the agent must fix (blocker or major, not on the base); `correcting`: they were handed to the agent.
	 */
	| {
			type: "verification_round";
			verifyId: string;
			round: number;
			ok: boolean;
			error?: string;
			/** With `ok: false`: why, and the value observed. */
			cause?: RefusalCause;
			observed?: string;
			requirements: VerifyRequirement[];
			defects: VerifyDefect[];
			blocking: string[];
			correcting: boolean;
			usage: Usage;
			costUsd?: number;
	  }
	/** The verification ended: `openDefects` are the blocking defects left; `usage` and `costUsd` include the verifier runs and the correction. */
	| {
			type: "verification_finished";
			verifyId: string;
			outcome: VerifyOutcome;
			reason?: string;
			/** Why it did not pass (`needs_decision` or `failed`), and the value observed. */
			cause?: RefusalCause;
			observed?: string;
			rounds: number;
			openDefects: VerifyDefect[];
			usage: Usage;
			costUsd?: number;
	  }
	| { type: "rate_limit"; status: string; resetsAt?: number; window?: string }
	| { type: "error"; code: string; message: string; recoverable: boolean };

/** Marks an event that a subagent produced inside the parent's turn. */
export interface SubagentTag {
	/** The parent's task call that started the subagent. */
	parentCallId?: string;
	agent?: string;
}

/** An event as delivered to clients: the body stamped by the session. */
export type AtelierEvent = AtelierEventBody & SubagentTag & { seq: number; turnId: string };

export type AtelierEventType = AtelierEventBody["type"];

export const ZERO_USAGE: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Share of the prompt served from the cache: cacheRead / (input + cacheRead + cacheWrite).
 * Cache writes count as input because they are paid for. Undefined when there was no input.
 */
export function cacheHitRate(usage: Usage): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt === 0 ? undefined : usage.cacheRead / prompt;
}

export function errorEvent(code: string, message: string, recoverable = false): AtelierEventBody {
	return { type: "error", code, message, recoverable };
}

/** Turns anything thrown into a readable message without leaking non-JSON values. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
