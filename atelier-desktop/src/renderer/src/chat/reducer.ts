import type {
	AtelierEvent,
	AuthSource,
	CompactionReason,
	ContextUsage,
	FeatureTask,
	JsonValue,
	McpServerStatus,
	Phase,
	QueuedMessage,
	RefusalCause,
	ReviewConsentAnswer,
	RiskDeclaration,
	SessionProfile,
	TurnPhases,
	Usage,
	UserQuestion,
	UserQuestionResult,
} from "@atelier/core/protocol";
import type { HostMessage } from "../../../shared/bridge.ts";

/** What the user is asked before a tool call; the core's own `PermissionMode`. */
export type PermissionMode = "normal" | "auto" | "yolo";

const DENIED_SUMMARY = "The user denied this command.";

export type TurnItem =
	| { kind: "text"; text: string }
	/** What the user steered the turn with, where it entered. */
	| { kind: "steer"; text: string }
	| {
			kind: "tool";
			callId: string;
			tool: string;
			input: JsonValue;
			status: "running" | "ok" | "error" | "denied";
			summary?: string;
			truncated?: boolean;
			/** What the sandbox blocked in the call, as short causes. */
			blocked?: string[];
			/** What the `auto` classifier decided about the call; the reason is model text. */
			classified?: { decision: "allow" | "deny" | "undecided"; reason: string };
			/** A task call's subagent: its work, shown under the call. */
			subagent?: Subagent;
	  }
	| {
			kind: "approval";
			callId: string;
			command: string;
			/** Why the agent asks to run the command outside the sandbox; absent for an ordinary command. */
			reason?: string;
			/** `edit` or `write` when the question is about changing a file outside the working directory; absent for `bash`. */
			tool?: string;
			/** The guard rule (`recursive removal`, `git push`, ...) that makes the command ask, also inside the sandbox; absent otherwise. */
			confirm?: string;
			/** What "Allow in this session" and "Allow always" would remember; absent when only Allow and Deny are offered. */
			remember?: { rules: string[]; always: boolean };
			state: "pending" | "approved" | "denied";
			/** How the answer was remembered, when it was. */
			remembered?: "session" | "always";
	  }
	/** An `ask_user` batch; the core's resolved event closes its inputs. */
	| {
			kind: "question";
			callId: string;
			questions: UserQuestion[];
			state: "pending" | "resolved";
			result?: UserQuestionResult;
	  }
	| {
			kind: "review_consent";
			reviewId: string;
			level: string;
			reasons: string[];
			lenses: string[];
			/** Why the agent chose the lenses; absent when it did not. */
			lensesReason?: string;
			/** closed: the review ended, or the turn did, before it was answered. */
			state: "pending" | ReviewConsentAnswer | "closed";
	  }
	| {
			kind: "review";
			/** Unknown until the review is offered or starts; the assessment that precedes it carries none. */
			reviewId?: string;
			level?: string;
			reasons: string[];
			lenses: string[];
			/** Why the agent chose the lenses; absent when it did not. */
			lensesReason?: string;
			/** What the agent declared about the risk; absent for documentation. */
			declaration?: RiskDeclaration;
			/** Short id of the commit the change is measured from, when it is not the current HEAD. */
			since?: string;
			/** Why the base is the current HEAD although the turn started earlier. */
			baseNote?: string;
			/** The user allowed this session's reviews, so this one runs without asking. */
			allowedForSession?: true;
			/** Each lens, the refuter and the validator, in the order they first spoke. */
			roles: Subagent[];
			result?: ReviewResult;
			/** The escalated correction was undone: the files put back and the ones removed. */
			undone?: { restored: string[]; removed: string[] };
			/** The turn ended without a result (the review failed): it is no longer running. */
			ended?: boolean;
	  }
	| {
			kind: "verification";
			verifyId: string;
			/** The high-risk items the agent declared, and why. */
			items: number[];
			declaration: { items: number[]; reason: string }[];
			rounds: VerificationRound[];
			/** The verifier's own work, as a block like a review role. */
			roles: Subagent[];
			result?: VerificationResult;
			/** The turn ended without an outcome: it is no longer running. */
			ended?: boolean;
	  }
	| { kind: "error"; code: string; message: string }
	/** `bash` runs without a sandbox in this turn: every command asks. */
	| { kind: "sandbox_warning"; reason: string }
	/** `expected`: it follows a compaction, which rewrote the history on purpose. */
	| { kind: "cache_miss"; reason: string; missedTokens: number; expected?: boolean }
	| {
			kind: "compaction";
			reason: CompactionReason;
			tokensBefore: number;
			tokensAfter?: number;
			kept: number;
			costUsd?: number;
			state: "running" | "done" | "failed";
			error?: string;
	  };

type VerificationEvent = Extract<AtelierEvent, { type: "verification_round" }>;
export type VerificationRound = Pick<
	VerificationEvent,
	"round" | "ok" | "requirements" | "defects" | "blocking" | "correcting"
> & { error?: string; cause?: RefusalCause; observed?: string };
export type VerificationResult = Pick<
	Extract<AtelierEvent, { type: "verification_finished" }>,
	"outcome" | "rounds" | "openDefects"
> & { reason?: string; cause?: RefusalCause; observed?: string; costUsd?: number };

type ReviewFinding = Extract<AtelierEvent, { type: "review_finished" }>["findings"][number];

export interface ReviewResult {
	verdict: string;
	reason?: string;
	cause?: RefusalCause;
	observed?: string;
	findings: ReviewFinding[];
	refuted: number;
	followUps: number;
	correction: { budget: number; used: number } | null;
	receiptPath?: string;
}

export interface Finished {
	stopReason: string;
	usage: Usage;
	costUsd?: number;
	requests?: number;
	durationMs?: number;
	/** The same cost by part of the turn (main agent, declaration, verifier, review roles). */
	phases?: TurnPhases;
	/** The session's model when the turn finished, so a later session with another model does not relabel it. */
	model?: string;
	/** The session's backend when the turn finished: the phases name another backend only. */
	backend?: string;
}

export interface Turn {
	/** Undefined until the core assigns the turn id. */
	id?: string;
	prompt: string;
	items: TurnItem[];
	finished?: Finished;
}

export interface Subagent {
	agent: string;
	model?: string;
	items: TurnItem[];
	finished?: Finished;
}

export interface ChatState {
	core: { status: "starting" | "ready" | "failed" | "exited"; version?: string; message?: string };
	/** `noSandbox`: the session was started with `bash` outside the sandbox. */
	session?: { id: string; cwd: string; noSandbox: boolean };
	backend?: string;
	model?: string;
	authSource?: AuthSource;
	/** The main agent's effort, when a level was asked. */
	effort?: string;
	/** The profile the session froze, when the core resolved one. */
	profile?: SessionProfile;
	/** The main agent's permission mode, as its latest `session_started` or `set_mode` answer said. */
	permissionMode?: PermissionMode;
	/** The ODD phase the agent is in. */
	phase?: Phase;
	/** Whether `bash` runs in the sandbox, with what, or why not; absent until the first turn says. */
	sandbox?: { sandboxed: boolean; mechanism?: string; reason?: string };
	/** Whether the session has long-term memory, for which project, or why not. */
	memory?: { available: boolean; project?: string; reason?: string };
	/** The AGENTS.md / CLAUDE.md files in the system prompt, and those the size cap left out; absent when none. */
	instructions?: { files: string[]; dropped: string[] };
	/** The skills listed in the system prompt, and the problems with the others; absent when none. */
	skills?: { skills: { name: string; path: string }[]; warnings: { path: string; message: string }[] };
	/** Why changes cannot be reviewed in this session; absent when they can. */
	review?: { available: false; reason?: string };
	/** The session's MCP servers, as the latest `mcp_status` or `session.mcp` answer said; absent without servers. */
	mcp?: { servers: McpServerStatus[]; problems: string[] };
	/** The active ODD feature document, as the core last reported it. */
	feature?: { name: string; path: string; title: string; tasks: FeatureTask[] };
	turns: Turn[];
	/** A turn is running (or its prompt is on the way). */
	busy: boolean;
	/** The latest failure, shown in the status bar. */
	lastError?: { code: string; message: string };
	/** Something worth seeing that is not an error, like a rate limit warning. */
	notice?: string;
	/** How full the context was at the end of the last turn, when the backend says. */
	context?: ContextUsage;
	/** Turns, counting the current one, in which a cache miss is the expected result of a compaction. */
	expectedMissTurns?: number;
	/** The messages queued while a turn runs, as the core last said; absent when none. */
	queue?: QueuedMessage[];
	/** The texts of the latest queue an interrupted or failed turn gave back, for the composer; `seq` tells one from the next. */
	returned?: { seq: number; texts: string[] };
}

/** Host messages plus what the renderer itself knows (it sent a prompt, a command failed...). */
export type ChatAction =
	| HostMessage
	| { type: "session_opened"; sessionId: string; cwd: string; noSandbox?: boolean }
	| { type: "prompt_sent"; text: string }
	| { type: "turn_accepted"; turnId: string }
	| { type: "approval_answered"; callId: string; approved: boolean; remember?: "session" | "always" }
	| { type: "review_consent_answered"; reviewId: string; answer: ReviewConsentAnswer }
	| { type: "command_failed"; code: string; message: string }
	/** A command on the queue failed: shown, with the turn left running. */
	| { type: "queue_failed"; code: string; message: string }
	/** The core answered `session.set_mode` with this mode. */
	| { type: "mode_changed"; mode: PermissionMode }
	/** The core answered `session.mcp`. */
	| { type: "mcp_answered"; servers: McpServerStatus[]; problems: string[] }
	| { type: "batch"; actions: ChatAction[] };

export const initialChatState: ChatState = { core: { status: "starting" }, turns: [], busy: false };

/** Pure: the whole chat is a fold of these actions. */
export function reduceChat(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case "batch":
			return action.actions.reduce(reduceChat, state);
		case "core_ready":
			return { ...state, core: { status: "ready", version: action.version } };
		case "core_failed":
			return {
				...withoutSession(state),
				core: { status: "failed", message: action.message },
				lastError: { code: "core_failed", message: action.message },
			};
		case "core_exited":
			return {
				...withoutSession(state),
				core: { status: "exited", message: action.message },
				lastError: { code: "core_exited", message: action.message },
			};
		case "protocol_error":
			return { ...state, lastError: { code: "protocol_error", message: action.message } };
		case "session_opened": {
			const {
				feature: _feature,
				phase: _phase,
				memory: _memory,
				mcp: _mcp,
				sandbox: _sandbox,
				instructions: _instructions,
				skills: _skills,
				review: _review,
				context: _context,
				expectedMissTurns: _expected,
				effort: _effort,
				profile: _profile,
				permissionMode: _permissionMode,
				queue: _queue,
				...rest
			} = state;
			return {
				...rest,
				session: { id: action.sessionId, cwd: action.cwd, noSandbox: action.noSandbox === true },
				turns: [],
				busy: false,
			};
		}
		case "prompt_sent": {
			const { lastError: _cleared, notice: _notice, ...rest } = state;
			return { ...rest, busy: true, turns: [...state.turns, { prompt: action.text, items: [] }] };
		}
		case "turn_accepted":
			if (state.turns.some((turn) => turn.id === action.turnId)) return state;
			return updatePending(state, (turn) => ({ ...turn, id: action.turnId }));
		case "approval_answered":
			return mapItems(state, (item) =>
				item.kind === "approval" && item.callId === action.callId
					? {
							...item,
							state: action.approved ? "approved" : "denied",
							...(action.approved && action.remember !== undefined ? { remembered: action.remember } : {}),
						}
					: item,
			);
		case "review_consent_answered":
			return mapItems(state, (item) =>
				item.kind === "review_consent" && item.reviewId === action.reviewId && item.state === "pending"
					? { ...item, state: action.answer }
					: item,
			);
		case "command_failed": {
			const error = { code: action.code, message: action.message };
			const withError = updateLast(state, (turn) => ({ ...turn, items: [...turn.items, { kind: "error", ...error }] }));
			return { ...withError, busy: false, lastError: error };
		}
		case "queue_failed":
			return { ...state, lastError: { code: action.code, message: action.message } };
		case "mode_changed":
			return { ...state, permissionMode: action.mode };
		case "mcp_answered":
			if (action.servers.length === 0 && action.problems.length === 0) {
				const { mcp: _mcp, ...rest } = state;
				return rest;
			}
			return { ...state, mcp: { servers: action.servers, problems: action.problems } };
		case "event":
			if (action.sessionId !== state.session?.id) return state;
			return applyEvent(state, action.event);
	}
}

function withoutSession(state: ChatState): ChatState {
	// The queue belonged to the session: nothing can edit, remove or run it anymore, so it goes back to the composer.
	const closed = mapItems(state, (item) =>
		item.kind === "question" && item.state === "pending"
			? { ...item, state: "resolved", result: { status: "cancelled", reason: "closed" } }
			: item,
	);
	const { session: _session, queue, ...rest } = closed;
	if (queue === undefined) return { ...rest, busy: false };
	const returned = { seq: (state.returned?.seq ?? 0) + 1, texts: queue.map((message) => message.text) };
	return { ...rest, busy: false, returned };
}

function applyEvent(state: ChatState, event: AtelierEvent): ChatState {
	if (event.parentCallId !== undefined) return applySubagentEvent(state, event, event.parentCallId);
	switch (event.type) {
		case "session_started": {
			// Claude Code says session_started on every init: a later one without a profile keeps the known one.
			const { effort: _effort, ...rest } = state;
			return {
				...rest,
				backend: event.backend,
				model: event.model,
				authSource: event.authSource,
				...(event.effort === undefined ? {} : { effort: event.effort }),
				...(event.profile === undefined ? {} : { profile: event.profile }),
				...(event.permissionMode === undefined ? {} : { permissionMode: event.permissionMode }),
			};
		}
		case "rate_limit": {
			if (event.status === "allowed") return state;
			return { ...state, notice: `Rate limit: ${event.status}${event.window ? ` (${event.window})` : ""}` };
		}
		case "turn_finished": {
			const finished: ChatState = {
				...updateTurn(state, event.turnId, (turn) => ({
					...turn,
					items: endReviews(closeConsents(turn.items)),
					finished: {
						...finishedOf(event),
						...(state.model === undefined ? {} : { model: state.model }),
						...(state.backend === undefined ? {} : { backend: state.backend }),
					},
				})),
				busy: false,
				...(event.context === undefined ? {} : { context: event.context }),
			};
			const turnsLeft = (state.expectedMissTurns ?? 0) - 1;
			const { expectedMissTurns: _expected, ...rest } = finished;
			return turnsLeft > 0 ? { ...rest, expectedMissTurns: turnsLeft } : rest;
		}
		case "compaction_finished": {
			const updated = updateTurn(state, event.turnId, (turn) => ({ ...turn, items: reduceItems(turn.items, event) }));
			return event.ok ? { ...updated, expectedMissTurns: 2 } : updated;
		}
		case "cache_miss": {
			if ((state.expectedMissTurns ?? 0) === 0)
				return updateTurn(state, event.turnId, (turn) => ({ ...turn, items: reduceItems(turn.items, event) }));
			const { expectedMissTurns: _expected, ...rest } = state;
			const item: TurnItem = {
				kind: "cache_miss",
				reason: event.reason,
				missedTokens: event.missedTokens,
				expected: true,
			};
			return updateTurn(rest, event.turnId, (turn) => ({ ...turn, items: [...turn.items, item] }));
		}
		case "phase_changed":
			return { ...state, phase: event.phase };
		case "queue_update": {
			const { queue: _queue, ...rest } = state;
			const queued = event.messages.length === 0 ? rest : { ...rest, queue: event.messages };
			if (event.returned === undefined || event.returned.length === 0) return queued;
			const seq = (state.returned?.seq ?? 0) + 1;
			return { ...queued, returned: { seq, texts: event.returned.map((message) => message.text) } };
		}
		case "queued_message":
			// A message that starts a turn is its prompt; a steer is shown where it entered the running turn.
			if (event.seq === 1)
				return { ...updateTurn(state, event.turnId, (turn) => ({ ...turn, prompt: event.text })), busy: true };
			return updateTurn(state, event.turnId, (turn) => ({
				...turn,
				items: [...turn.items, { kind: "steer", text: event.text }],
			}));
		case "mcp_status":
			return { ...state, mcp: { servers: event.servers, problems: event.problems } };
		case "memory_status":
			return {
				...state,
				memory: {
					available: event.available,
					...(event.project === undefined ? {} : { project: event.project }),
					...(event.reason === undefined ? {} : { reason: event.reason }),
				},
			};
		case "sandbox_status":
			return {
				...state,
				sandbox: {
					sandboxed: event.sandboxed,
					...(event.mechanism === undefined ? {} : { mechanism: event.mechanism }),
					...(event.reason === undefined ? {} : { reason: event.reason }),
				},
			};
		case "project_instructions":
			return { ...state, instructions: { files: event.files, dropped: event.dropped } };
		case "skills_loaded":
			return { ...state, skills: { skills: event.skills, warnings: event.warnings } };
		case "review_status":
			return event.available
				? state
				: { ...state, review: { available: false, ...(event.reason === undefined ? {} : { reason: event.reason }) } };
		case "correction_undone":
			// The review block is in an earlier turn than the undo.
			return mapItems(state, (item) =>
				item.kind === "review" && item.reviewId === event.reviewId
					? { ...item, undone: { restored: event.restored, removed: event.removed } }
					: item,
			);
		case "feature_changed":
			return { ...state, feature: { name: event.name, path: event.path, title: event.title, tasks: event.tasks } };
		case "error": {
			const updated = updateTurn(state, event.turnId, (turn) => ({ ...turn, items: reduceItems(turn.items, event) }));
			return { ...updated, lastError: { code: event.code, message: event.message } };
		}
		default:
			return updateTurn(state, event.turnId, (turn) => ({ ...turn, items: reduceItems(turn.items, event) }));
	}
}

/** A subagent's event changes only its block under the task call: never the parent's model, busy flag or status bar. */
function applySubagentEvent(state: ChatState, event: AtelierEvent, parentCallId: string): ChatState {
	return updateTurn(state, event.turnId, (turn) => ({
		...turn,
		items: reduceChildItems(turn.items, event, parentCallId),
	}));
}

/** A review's roles share one parent id, so each gets its own block; any other child belongs to its task call. */
function reduceChildItems(items: TurnItem[], event: AtelierEvent, parentCallId: string): TurnItem[] {
	if (event.agent?.startsWith("verify:")) {
		const agent = event.agent;
		return updateVerification(items, parentCallId, (verification) => {
			const known = verification.roles.find((role) => role.agent === agent);
			const role: Subagent = known ?? { agent, items: [] };
			const next =
				event.type === "session_started"
					? { ...role, model: event.model }
					: event.type === "turn_finished"
						? { ...role, finished: finishedOf(event) }
						: { ...role, items: reduceItems(role.items, event) };
			return {
				...verification,
				roles: known ? verification.roles.map((r) => (r === known ? next : r)) : [...verification.roles, next],
			};
		});
	}
	if (event.agent?.startsWith("review:")) {
		const agent = event.agent;
		return updateReview(items, parentCallId, (review) => {
			const known = review.roles.find((role) => role.agent === agent);
			const role: Subagent = known ?? { agent, items: [] };
			const next =
				event.type === "session_started"
					? { ...role, model: event.model }
					: event.type === "turn_finished"
						? { ...role, finished: finishedOf(event) }
						: { ...role, items: reduceItems(role.items, event) };
			return { ...review, roles: known ? review.roles.map((r) => (r === known ? next : r)) : [...review.roles, next] };
		});
	}
	return items.map((item) => {
		if (item.kind !== "tool" || item.callId !== parentCallId) return item;
		const subagent = item.subagent ?? { agent: event.agent ?? item.tool, items: [] };
		if (event.type === "session_started") return { ...item, subagent: { ...subagent, model: event.model } };
		if (event.type === "turn_finished") return { ...item, subagent: { ...subagent, finished: finishedOf(event) } };
		if (event.type === "cache_miss" && missExpected(subagent.items)) {
			const miss: TurnItem = {
				kind: "cache_miss",
				reason: event.reason,
				missedTokens: event.missedTokens,
				expected: true,
			};
			return { ...item, subagent: { ...subagent, items: [...subagent.items, miss] } };
		}
		return { ...item, subagent: { ...subagent, items: reduceItems(subagent.items, event) } };
	});
}

/** A subagent runs one turn: its first cache miss after its own compaction is the expected one. */
function missExpected(items: TurnItem[]): boolean {
	const last = items.findLast((item) => item.kind === "compaction" || item.kind === "cache_miss");
	return last?.kind === "compaction" && last.state === "done";
}

function finishedOf(event: Extract<AtelierEvent, { type: "turn_finished" }>): Finished {
	return {
		stopReason: event.stopReason,
		usage: event.usage,
		...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
		...(event.requests === undefined ? {} : { requests: event.requests }),
		...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
		...(event.phases === undefined ? {} : { phases: event.phases }),
	};
}

/** The items of a turn or of a subagent block: text, tool rows, approvals, errors and cache misses. */
function reduceItems(items: TurnItem[], event: AtelierEvent): TurnItem[] {
	switch (event.type) {
		case "text_delta": {
			const last = items.at(-1);
			if (last?.kind === "text") return [...items.slice(0, -1), { kind: "text", text: last.text + event.text }];
			return [...items, { kind: "text", text: event.text }];
		}
		case "tool_call_started":
			return [
				...items,
				{ kind: "tool", callId: event.callId, tool: event.tool, input: event.input, status: "running" },
			];
		case "tool_call_finished": {
			const status = event.ok ? "ok" : event.summary === DENIED_SUMMARY ? "denied" : "error";
			return items.map((item) =>
				item.kind === "tool" && item.callId === event.callId
					? {
							...item,
							status,
							summary: event.summary,
							truncated: event.truncated,
							...(event.blocked === undefined ? {} : { blocked: event.blocked }),
						}
					: item,
			);
		}
		case "permission_classified":
			return items.map((item) =>
				item.kind === "tool" && item.callId === event.callId
					? { ...item, classified: { decision: event.decision, reason: event.reason } }
					: item,
			);
		case "approval_requested":
			return [
				...items,
				{
					kind: "approval",
					callId: event.callId,
					command: event.command,
					...(event.reason === undefined ? {} : { reason: event.reason }),
					...(event.tool === undefined ? {} : { tool: event.tool }),
					...(event.confirm === undefined ? {} : { confirm: event.confirm }),
					...(event.remember === undefined ? {} : { remember: event.remember }),
					state: "pending",
				},
			];
		case "user_question_requested":
			return [...items, { kind: "question", callId: event.callId, questions: event.questions, state: "pending" }];
		case "user_question_resolved":
			return items.map((item) =>
				item.kind === "question" && item.callId === event.callId
					? { ...item, state: "resolved", result: event.result }
					: item,
			);
		case "sandbox_warning":
			return [...items, { kind: "sandbox_warning", reason: event.reason }];
		case "error":
			return [...items, { kind: "error", code: event.code, message: event.message }];
		case "cache_miss":
			return [...items, { kind: "cache_miss", reason: event.reason, missedTokens: event.missedTokens }];
		case "compaction_started":
			return [
				...items,
				{ kind: "compaction", reason: event.reason, tokensBefore: event.tokens, kept: 0, state: "running" },
			];
		case "compaction_finished": {
			const done: TurnItem = {
				kind: "compaction",
				reason: event.reason,
				tokensBefore: event.tokensBefore,
				...(event.tokensAfter === undefined ? {} : { tokensAfter: event.tokensAfter }),
				kept: event.kept,
				...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
				state: event.ok ? "done" : "failed",
				...(event.error === undefined ? {} : { error: event.error }),
			};
			const index = items.findLastIndex((item) => item.kind === "compaction" && item.state === "running");
			return index === -1 ? [...items, done] : items.map((item, i) => (i === index ? done : item));
		}
		case "review_assessed":
			return [
				...items,
				{
					kind: "review",
					level: event.level,
					reasons: event.reasons,
					lenses: event.lenses,
					...(event.lensesReason === undefined ? {} : { lensesReason: event.lensesReason }),
					...(event.declaration === undefined ? {} : { declaration: event.declaration }),
					...(event.since === undefined ? {} : { since: event.since }),
					...(event.baseNote === undefined ? {} : { baseNote: event.baseNote }),
					...(event.consent === "session" ? { allowedForSession: true as const } : {}),
					roles: [],
				},
			];
		case "review_consent_requested":
			return [
				...updateReview(items, event.reviewId, (review) => review),
				{
					kind: "review_consent",
					reviewId: event.reviewId,
					level: event.level,
					reasons: event.reasons,
					lenses: event.lenses,
					...(event.lensesReason === undefined ? {} : { lensesReason: event.lensesReason }),
					state: "pending",
				},
			];
		case "verification_started":
			return updateVerification(items, event.verifyId, (verification) => ({
				...verification,
				items: event.items,
				declaration: event.declaration,
			}));
		case "verification_round":
			return updateVerification(items, event.verifyId, (verification) => ({
				...verification,
				rounds: [
					...verification.rounds,
					{
						round: event.round,
						ok: event.ok,
						...(event.error === undefined ? {} : { error: event.error }),
						...refusalOf(event),
						requirements: event.requirements,
						defects: event.defects,
						blocking: event.blocking,
						correcting: event.correcting,
					},
				],
			}));
		case "verification_finished":
			return updateVerification(items, event.verifyId, (verification) => ({
				...verification,
				result: {
					outcome: event.outcome,
					rounds: event.rounds,
					openDefects: event.openDefects,
					...(event.reason === undefined ? {} : { reason: event.reason }),
					...refusalOf(event),
					...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
				},
			}));
		case "review_progress":
			return updateReview(items, event.reviewId, (review) => review);
		case "review_finished":
			return closeConsents(
				updateReview(items, event.reviewId, (review) => ({
					...review,
					result: {
						verdict: event.verdict,
						...(event.reason === undefined ? {} : { reason: event.reason }),
						...refusalOf(event),
						findings: event.findings,
						refuted: event.refuted.length,
						followUps: event.followUps.length,
						correction: event.correction,
						...(event.receiptPath === undefined ? {} : { receiptPath: event.receiptPath }),
					},
				})),
				event.reviewId,
			);
		default:
			return items;
	}
}

type ReviewItem = Extract<TurnItem, { kind: "review" }>;

/** The cause of a refusal and the value observed, when the event has them. */
function refusalOf(event: { cause?: RefusalCause; observed?: string }): { cause?: RefusalCause; observed?: string } {
	return {
		...(event.cause === undefined ? {} : { cause: event.cause }),
		...(event.observed === undefined ? {} : { observed: event.observed }),
	};
}

/**
 * Applies `update` to the review block with this id. The assessment that opens a block carries no id, so the
 * newest block without one is adopted; with none, a block is started.
 */
function updateReview(items: TurnItem[], reviewId: string, update: (review: ReviewItem) => ReviewItem): TurnItem[] {
	let index = items.findIndex((item) => item.kind === "review" && item.reviewId === reviewId);
	if (index === -1) index = items.findLastIndex((item) => item.kind === "review" && item.reviewId === undefined);
	if (index === -1) return [...items, update({ kind: "review", reviewId, reasons: [], lenses: [], roles: [] })];
	return items.map((item, i) => (i === index ? update({ ...(item as ReviewItem), reviewId }) : item));
}

type VerificationItem = Extract<TurnItem, { kind: "verification" }>;

/** Applies `update` to the verification block with this id, starting one when there is none. */
function updateVerification(
	items: TurnItem[],
	verifyId: string,
	update: (verification: VerificationItem) => VerificationItem,
): TurnItem[] {
	const index = items.findIndex((item) => item.kind === "verification" && item.verifyId === verifyId);
	if (index === -1)
		return [...items, update({ kind: "verification", verifyId, items: [], declaration: [], rounds: [], roles: [] })];
	return items.map((item, i) => (i === index ? update(item as VerificationItem) : item));
}

/** A review or verification still without a result when its turn ends will never get one. */
function endReviews(items: TurnItem[]): TurnItem[] {
	return items.map((item) =>
		(item.kind === "review" && item.reviewId !== undefined && item.result === undefined) ||
		(item.kind === "verification" && item.result === undefined)
			? { ...item, ended: true }
			: item,
	);
}

/** Pending consent cards of this review (any, without an id) can no longer be answered. */
function closeConsents(items: TurnItem[], reviewId?: string): TurnItem[] {
	return items.map((item) =>
		item.kind === "review_consent" && item.state === "pending" && (reviewId === undefined || item.reviewId === reviewId)
			? { ...item, state: "closed" }
			: item,
	);
}

/** Updates the turn with this id; else adopts the turn still waiting for its id; else starts one. */
function updateTurn(state: ChatState, turnId: string, update: (turn: Turn) => Turn): ChatState {
	const index = state.turns.findIndex((turn) => turn.id === turnId);
	if (index !== -1) return { ...state, turns: state.turns.map((turn, i) => (i === index ? update(turn) : turn)) };
	const pending = state.turns.findIndex((turn) => turn.id === undefined);
	if (pending !== -1)
		return { ...state, turns: state.turns.map((turn, i) => (i === pending ? update({ ...turn, id: turnId }) : turn)) };
	return { ...state, turns: [...state.turns, update({ id: turnId, prompt: "", items: [] })] };
}

function updatePending(state: ChatState, update: (turn: Turn) => Turn): ChatState {
	const pending = state.turns.findIndex((turn) => turn.id === undefined);
	if (pending === -1) return state;
	return { ...state, turns: state.turns.map((turn, i) => (i === pending ? update(turn) : turn)) };
}

function updateLast(state: ChatState, update: (turn: Turn) => Turn): ChatState {
	if (state.turns.length === 0) return state;
	return { ...state, turns: [...state.turns.slice(0, -1), update(state.turns.at(-1) as Turn)] };
}

/** Maps every item, including the ones inside subagent blocks. */
function mapItems(state: ChatState, map: (item: TurnItem) => TurnItem): ChatState {
	const deep = (item: TurnItem): TurnItem => {
		const mapped = map(item);
		return mapped.kind === "tool" && mapped.subagent
			? { ...mapped, subagent: { ...mapped.subagent, items: mapped.subagent.items.map(deep) } }
			: mapped;
	};
	return { ...state, turns: state.turns.map((turn) => ({ ...turn, items: turn.items.map(deep) })) };
}
