/**
 * Event contract emitted by the core. Every event is plain JSON so a client can
 * receive it over a pipe unchanged (M2).
 */

import type { ThinkingLevel } from "./thinking.ts";
import type { UserQuestion, UserQuestionResult } from "./tools/ask-user.ts";

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
	| { type: "refuter_finished"; confirmed: number; refuted: number; downgraded?: number }
	| { type: "correction_started"; budget: number; findings: number }
	| { type: "correction_finished"; ok: boolean; used?: number }
	| { type: "validator_started"; findings: number }
	| { type: "validator_finished"; resolved: number; unresolved: number };

/**
 * The parts of a turn, in the order they run: the summary that handed the conversation to a new backend, the main
 * agent, the permission classifier of `auto`, the request to declare the risk, the verifier and its correction, and
 * the review's lenses, refuter, correction and validator.
 */
export const TURN_PHASES = [
	"handoff",
	"main",
	"classifier",
	"declare",
	"verify",
	"lenses",
	"refuter",
	"correction",
	"validator",
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

/**
 * One agent that ran in a part of a turn: its profile role, and the backend, model and effort its `session_started` said.
 * `effectiveEffort`: the effort its backend says it applied when no level was asked (Claude Code's default, for one).
 */
export interface PhaseAgent {
	role: string;
	backend: string;
	model: string;
	effort?: Effort | "off" | "auto" | EffortNotSent;
	effectiveEffort?: Effort;
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

/**
 * Context tokens the next request carries, the model's window, and where compaction starts. `unknown`: the size is not
 * known, right after a compaction no answer measured yet; `tokens` is then only the backend's estimate, or 0.
 */
export interface ContextUsage {
	tokens: number;
	window: number;
	compactAt: number;
	unknown?: true;
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

/** What `effort` says when the level asked could not be sent: the level asked, then ` not sent`. */
export type EffortNotSent = `${ThinkingLevel} not sent`;

/** What a profile entry sets for a role; an absent field is inherited. */
export interface ProfileRoleEntry {
	backend?: string;
	model?: string;
	thinking?: string;
}

/** What a backend change did to the history, for the clients to say. */
export interface BackendChange {
	/** The backend the session left. */
	from: string;
	/** A summary of the conversation went to the new backend; false when there was nothing yet to carry. */
	summarized: boolean;
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

/** One MCP server as clients see it; `transport` is absent for an entry that could not be taken. */
export type McpServerStatus = {
	name: string;
	transport?: "stdio" | "http";
	/** `needs_auth`: an HTTP server that wants an OAuth sign-in (`atelier mcp login <name>`). */
	state: "connecting" | "connected" | "failed" | "needs_auth" | "disabled" | "invalid";
	/** The names of its tools while connected. */
	tools: string[];
	description?: string;
	error?: string;
	/** The end of a failed stdio server's stderr. */
	stderr?: string;
};

/** `steer` enters the running turn with its next tool result; `follow_up` waits for the turn to end and starts its own. */
export type QueueKind = "steer" | "follow_up";

/** A message the user queued while a turn runs, until it enters the conversation. */
export type QueuedMessage = {
	id: string;
	kind: QueueKind;
	text: string;
};

export type AtelierEventBody =
	/**
	 * `effort`: the thinking level asked for, as sent with every request: the reasoning effort, `off` when thinking
	 * was turned off, `auto` when a level was asked for a model that reasons on its own and takes no level, or
	 * `<level> not sent` when the level does not apply: the model does not take it, its thinking cannot be turned
	 * off, or its thinking budget cannot fit under half of the request's output budget. Absent when no level was asked.
	 * `profile`: the main session's frozen profile, when it resolved one; set by the session.
	 */
	| {
			type: "session_started";
			backend: string;
			model: string;
			authSource: AuthSource;
			effort?: Effort | "off" | "auto" | EffortNotSent;
			profile?: SessionProfile;
			/** Set by the session: how much it asks before a tool call. */
			permissionMode?: "normal" | "auto" | "yolo";
	  }
	/**
	 * The session's configuration after its model, thinking level or permission mode changed: what the next turns
	 * run with, sent in the turn where the change took effect (the next turn after a change made between turns).
	 * `thinking`: the level asked for, in the profiles' names (`off`, `minimal`, `low` ... `max`); `effort`: the level
	 * as the backend sends it, the same `session_started.effort` says, absent when no level was asked or while the
	 * change waits for the turn to end; `model` is absent while the backend's default one runs and nothing changed it.
	 * `backendChange`: set when the backend changed (`session.set_backend`): the one it left, and whether a summary of
	 * the conversation carried the history over (the new backend has the summary, not the messages).
	 */
	| {
			type: "session_configured";
			backend: string;
			model?: string;
			thinking?: string;
			effort?: Effort | "off" | "auto" | EffortNotSent;
			permissionMode: "normal" | "auto" | "yolo";
			profile?: SessionProfile;
			backendChange?: BackendChange;
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
			/** For `edit`: the line each edit starts at in the file before it, in the order of the edits; absent for other tools. */
			startLines?: number[];
			/** For `edit`: the line each edit's new text starts at in the file after it, in the order of the edits; absent for other tools. */
			newStartLines?: number[];
	  }
	| { type: "user_question_requested"; callId: string; questions: UserQuestion[] }
	| { type: "user_question_resolved"; callId: string; result: UserQuestionResult }
	/** Sent first in a session's first turn when `bash` exists: whether its commands run in the sandbox, with what, or why not. */
	| { type: "sandbox_status"; sandboxed: boolean; mechanism?: string; reason?: string }
	/** `bash` runs without the sandbox, so every command asks: said once per turn, before the first question. */
	| { type: "sandbox_warning"; reason: string }
	/**
	 * `reason`: the agent asked to run the command outside the sandbox, and says why. `confirm`: the guard rule
	 * (`recursive removal`, `git push`, ...) that makes the command ask in every mode, also inside the sandbox.
	 */
	| {
			type: "approval_requested";
			callId: string;
			command: string;
			reason?: string;
			tool?: string;
			confirm?: string;
			/** The sandbox failed to start: the command asks in every mode, `yolo` included. */
			sandboxFailed?: true;
			/**
			 * What "Allow in this session" and "Allow always" would remember; absent when only Allow and Deny are offered.
			 * `project` (the project's real path) offers "Allow always in this project" instead of "Allow always".
			 */
			remember?: { rules: string[]; always: boolean; project?: string };
	  }
	/**
	 * `auto`: what the permission classifier decided about the call, before it runs or is refused. `undecided`: the
	 * classifier failed or is paused (`reason` says why) and the user is asked as in `normal`; `paused` is set while paused.
	 */
	| {
			type: "permission_classified";
			callId: string;
			decision: "allow" | "deny" | "undecided";
			reason: string;
			paused?: true;
	  }
	/**
	 * `requests`: model requests the turn made, when the backend knows it; `context`: how full the context is, when known.
	 * `durationMs`: wall time of the whole turn, tools and end-of-turn review included; set by the session.
	 * `phases`: the same usage, requests and cost by part of the turn, summing to the totals; set by the session.
	 * `at`: when the turn ended, as an ISO time; set by the session.
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
			at?: string;
	  }
	/**
	 * The main agent's context reached 90% of where it compacts, said once before the turn's `turn_finished`, with that
	 * turn's context; said again once it went below, was unknown, compacted, or the backend or the model changed.
	 */
	| { type: "context_warning"; tokens: number; window: number; compactAt: number }
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
	/**
	 * The messages queued while a turn runs, whole, each time the queue changes. `returned`: the queue an interrupted or
	 * failed turn gives back instead of running it, for the client to put in its editor. Never saved.
	 */
	| { type: "queue_update"; messages: QueuedMessage[]; returned?: QueuedMessage[] }
	/**
	 * A queued message entered the conversation: a steer with a tool result of the running turn, a follow-up (or a steer
	 * no tool result took) as the prompt of the turn it starts, as that turn's first event. Clients show it as a prompt.
	 */
	| ({ type: "queued_message" } & QueuedMessage)
	/** A background job started (`bash_background`). `running`: the session's jobs running now, this one included. */
	| { type: "job_started"; jobId: string; label: string; command: string; outputPath: string; running: number }
	/**
	 * A background job ended: `exited` on its own (`exitCode`, or `signal` when a signal Atelier did not send killed it),
	 * `stopped` by `job_stop` or the session's close, `failed` when it could not start. `notified`: the agent gets a
	 * notice of it, as of every end but a stop. `running`: jobs still running; `waiting`: notices the agent has not read
	 * yet, this one included. Said in the turn that runs as it ends, else first in the turn its notice wakes, or the next.
	 */
	| {
			type: "job_finished";
			jobId: string;
			label: string;
			status: "exited" | "stopped" | "failed";
			exitCode?: number;
			signal?: string;
			durationMs: number;
			outputPath: string;
			notified: boolean;
			running: number;
			waiting: number;
	  }
	/**
	 * A subagent started in the background (`task` with `background`). `outputPath`: its activity, then its whole report.
	 * `running`: the session's background work running now (jobs and tasks), this one included.
	 */
	| { type: "task_started"; taskId: string; agent: string; label: string; outputPath: string; running: number }
	/**
	 * A background task ended: `finished` with a report, `failed` without one (`error` says why), `stopped` by `job_stop`
	 * or the session's close. `notified`, `running` and `waiting` as in `job_finished`; said as `job_finished` is.
	 */
	| {
			type: "task_finished";
			taskId: string;
			agent: string;
			label: string;
			status: "finished" | "failed" | "stopped";
			error?: string;
			durationMs: number;
			outputPath: string;
			costUsd?: number;
			notified: boolean;
			running: number;
			waiting: number;
	  }
	/**
	 * The agent read the notices that waited (with a tool result or a prompt), or they wait again because the backend
	 * failed on that prompt before answering: the jobs running and the notices left.
	 */
	| { type: "jobs_status"; running: number; waiting: number }
	/**
	 * The user's MCP servers and what is wrong with their file, at the start of the first turn and of any turn in which
	 * they changed. Never a value of their configuration: secrets are hidden as `***`.
	 */
	| { type: "mcp_status"; servers: McpServerStatus[]; problems: string[] }
	/** Sent first in a session's first turn: whether long-term memory works, for which project, or why not. */
	| { type: "memory_status"; available: boolean; project?: string; reason?: string }
	/**
	 * The compaction summary was saved to memory as `#id`, after a compaction or a backend change. `preview`: its first
	 * line, plain text, capped at 200 code points with `…` (clients cut it to their columns). `warning`: what the save warned about; the recoverable error
	 * `memory_summary_warning` still says it, for clients that do not know this event.
	 */
	| { type: "memory_summary_saved"; id: number; preview: string; warning?: string }
	/** Sent first in a session's first turn when AGENTS.md / CLAUDE.md files were found: those added to the system prompt, and those left out by the size cap. */
	| { type: "project_instructions"; files: string[]; dropped: string[] }
	/** Sent in a session's first turn, after `project_instructions`, when skills or problems with them were found: the skills listed in the system prompt, and what is wrong with the others. */
	| { type: "skills_loaded"; skills: { name: string; path: string }[]; warnings: { path: string; message: string }[] }
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
			/** `session`: the user allowed this session's reviews, so this one runs without asking. */
			consent?: "session";
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
