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

/** Context tokens the next request carries, the model's window, and where compaction starts. */
export interface ContextUsage {
	tokens: number;
	window: number;
	compactAt: number;
}

export type CompactionReason = "threshold" | "overflow" | "manual";

export type ReviewVerdict = "approved" | "escalated" | "declined" | "unavailable";

export type AtelierEventBody =
	| { type: "session_started"; backend: string; model: string; authSource: AuthSource }
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
	  }
	| { type: "approval_requested"; callId: string; command: string }
	/**
	 * `requests`: model requests the turn made, when the backend knows it; `context`: how full the context is, when known.
	 * `durationMs`: wall time of the whole turn, tools and end-of-turn review included; set by the session.
	 */
	| {
			type: "turn_finished";
			stopReason: string;
			usage: Usage;
			costUsd?: number;
			requests?: number;
			durationMs?: number;
			context?: ContextUsage;
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
	/** The free, deterministic risk of the change a turn left. `reviewDue`: only high risk is offered a review. */
	| {
			type: "review_assessed";
			tree: string;
			level: "passive" | "medium" | "high";
			reasons: string[];
			files: string[];
			changedLines: number;
			lenses: string[];
			reviewDue: boolean;
	  }
	/** The core waits for session.review_consent; the turn stays open until it is answered. */
	| { type: "review_consent_requested"; reviewId: string; level: string; reasons: string[]; lenses: string[] }
	/** Progress of a review the user agreed to or asked for; role events follow tagged `agent: "review:<role>"`. */
	| { type: "review_progress"; reviewId: string; step: ReviewStep }
	| {
			type: "review_finished";
			reviewId: string;
			verdict: ReviewVerdict;
			reason?: string;
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
