import type {
	AtelierEvent,
	AuthSource,
	CompactionReason,
	ContextUsage,
	FeatureTask,
	JsonValue,
	Phase,
	Usage,
} from "@atelier/core/protocol";
import type { HostMessage } from "../../../shared/bridge.ts";

const DENIED_SUMMARY = "The user denied this command.";

export type TurnItem =
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			callId: string;
			tool: string;
			input: JsonValue;
			status: "running" | "ok" | "error" | "denied";
			summary?: string;
			truncated?: boolean;
			/** A task call's subagent: its work, shown under the call. */
			subagent?: Subagent;
	  }
	| { kind: "approval"; callId: string; command: string; state: "pending" | "approved" | "denied" }
	| {
			kind: "review_consent";
			reviewId: string;
			level: string;
			reasons: string[];
			lenses: string[];
			/** closed: the review ended, or the turn did, before it was answered. */
			state: "pending" | "granted" | "declined" | "closed";
	  }
	| {
			kind: "review";
			/** Unknown until the review is offered or starts; the assessment that precedes it carries none. */
			reviewId?: string;
			level?: string;
			reasons: string[];
			lenses: string[];
			/** Each lens, the refuter and the validator, in the order they first spoke. */
			roles: Subagent[];
			result?: ReviewResult;
			/** The turn ended without a result (the review failed): it is no longer running. */
			ended?: boolean;
	  }
	| { kind: "error"; code: string; message: string }
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

type ReviewFinding = Extract<AtelierEvent, { type: "review_finished" }>["findings"][number];

export interface ReviewResult {
	verdict: string;
	reason?: string;
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
	/** The session's model when the turn finished, so a later session with another model does not relabel it. */
	model?: string;
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
	session?: { id: string; cwd: string };
	backend?: string;
	model?: string;
	authSource?: AuthSource;
	/** The ODD phase the agent is in. */
	phase?: Phase;
	/** Whether the session has long-term memory, for which project, or why not. */
	memory?: { available: boolean; project?: string; reason?: string };
	/** Why changes cannot be reviewed in this session; absent when they can. */
	review?: { available: false; reason?: string };
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
}

/** Host messages plus what the renderer itself knows (it sent a prompt, a command failed...). */
export type ChatAction =
	| HostMessage
	| { type: "session_opened"; sessionId: string; cwd: string }
	| { type: "prompt_sent"; text: string }
	| { type: "turn_accepted"; turnId: string }
	| { type: "approval_answered"; callId: string; approved: boolean }
	| { type: "review_consent_answered"; reviewId: string; answer: "granted" | "declined" }
	| { type: "command_failed"; code: string; message: string }
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
				review: _review,
				context: _context,
				expectedMissTurns: _expected,
				...rest
			} = state;
			return { ...rest, session: { id: action.sessionId, cwd: action.cwd }, turns: [], busy: false };
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
					? { ...item, state: action.approved ? "approved" : "denied" }
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
		case "event":
			if (action.sessionId !== state.session?.id) return state;
			return applyEvent(state, action.event);
	}
}

function withoutSession(state: ChatState): ChatState {
	const { session: _session, ...rest } = state;
	return { ...rest, busy: false };
}

function applyEvent(state: ChatState, event: AtelierEvent): ChatState {
	if (event.parentCallId !== undefined) return applySubagentEvent(state, event, event.parentCallId);
	switch (event.type) {
		case "session_started":
			return { ...state, backend: event.backend, model: event.model, authSource: event.authSource };
		case "rate_limit": {
			if (event.status === "allowed") return state;
			return { ...state, notice: `Rate limit: ${event.status}${event.window ? ` (${event.window})` : ""}` };
		}
		case "turn_finished": {
			const finished: ChatState = {
				...updateTurn(state, event.turnId, (turn) => ({
					...turn,
					items: endReviews(closeConsents(turn.items)),
					finished: { ...finishedOf(event), ...(state.model === undefined ? {} : { model: state.model }) },
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
		case "memory_status":
			return {
				...state,
				memory: {
					available: event.available,
					...(event.project === undefined ? {} : { project: event.project }),
					...(event.reason === undefined ? {} : { reason: event.reason }),
				},
			};
		case "review_status":
			return event.available
				? state
				: { ...state, review: { available: false, ...(event.reason === undefined ? {} : { reason: event.reason }) } };
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
		return { ...item, subagent: { ...subagent, items: reduceItems(subagent.items, event) } };
	});
}

function finishedOf(event: Extract<AtelierEvent, { type: "turn_finished" }>): Finished {
	return {
		stopReason: event.stopReason,
		usage: event.usage,
		...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
		...(event.requests === undefined ? {} : { requests: event.requests }),
		...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
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
					? { ...item, status, summary: event.summary, truncated: event.truncated }
					: item,
			);
		}
		case "approval_requested":
			return [...items, { kind: "approval", callId: event.callId, command: event.command, state: "pending" }];
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
				{ kind: "review", level: event.level, reasons: event.reasons, lenses: event.lenses, roles: [] },
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
					state: "pending",
				},
			];
		case "review_progress":
			return updateReview(items, event.reviewId, (review) => review);
		case "review_finished":
			return closeConsents(
				updateReview(items, event.reviewId, (review) => ({
					...review,
					result: {
						verdict: event.verdict,
						...(event.reason === undefined ? {} : { reason: event.reason }),
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

/** Pending consent cards of this review (any, without an id) can no longer be answered. */
/** A review still without a result when its turn ends will never get one. */
function endReviews(items: TurnItem[]): TurnItem[] {
	return items.map((item) =>
		item.kind === "review" && item.reviewId !== undefined && item.result === undefined
			? { ...item, ended: true }
			: item,
	);
}

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
