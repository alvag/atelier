import type { AtelierEvent, AuthSource, JsonValue, Usage } from "@atelier/core/protocol";
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
	  }
	| { kind: "approval"; callId: string; command: string; state: "pending" | "approved" | "denied" }
	| { kind: "error"; code: string; message: string };

export interface Turn {
	/** Undefined until the core assigns the turn id. */
	id?: string;
	prompt: string;
	items: TurnItem[];
	finished?: { stopReason: string; usage: Usage; costUsd?: number };
}

export interface ChatState {
	core: { status: "starting" | "ready" | "failed" | "exited"; version?: string; message?: string };
	session?: { id: string; cwd: string };
	model?: string;
	authSource?: AuthSource;
	turns: Turn[];
	/** A turn is running (or its prompt is on the way). */
	busy: boolean;
	/** The latest failure, shown in the status bar. */
	lastError?: { code: string; message: string };
	/** Something worth seeing that is not an error, like a rate limit warning. */
	notice?: string;
}

/** Host messages plus what the renderer itself knows (it sent a prompt, a command failed...). */
export type ChatAction =
	| HostMessage
	| { type: "session_opened"; sessionId: string; cwd: string }
	| { type: "prompt_sent"; text: string }
	| { type: "turn_accepted"; turnId: string }
	| { type: "approval_answered"; callId: string; approved: boolean }
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
		case "session_opened":
			return { ...state, session: { id: action.sessionId, cwd: action.cwd }, turns: [], busy: false };
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
	switch (event.type) {
		case "session_started":
			return { ...state, model: event.model, authSource: event.authSource };
		case "rate_limit": {
			if (event.status === "allowed") return state;
			return { ...state, notice: `Rate limit: ${event.status}${event.window ? ` (${event.window})` : ""}` };
		}
		case "thinking_delta":
		case "cache_miss":
			return state;
		case "text_delta":
			return updateTurn(state, event.turnId, (turn) => {
				const last = turn.items.at(-1);
				if (last?.kind === "text")
					return { ...turn, items: [...turn.items.slice(0, -1), { kind: "text", text: last.text + event.text }] };
				return { ...turn, items: [...turn.items, { kind: "text", text: event.text }] };
			});
		case "tool_call_started":
			return updateTurn(state, event.turnId, (turn) => ({
				...turn,
				items: [
					...turn.items,
					{ kind: "tool", callId: event.callId, tool: event.tool, input: event.input, status: "running" },
				],
			}));
		case "approval_requested":
			return updateTurn(state, event.turnId, (turn) => ({
				...turn,
				items: [...turn.items, { kind: "approval", callId: event.callId, command: event.command, state: "pending" }],
			}));
		case "tool_call_finished": {
			const status = event.ok ? "ok" : event.summary === DENIED_SUMMARY ? "denied" : "error";
			return updateTurn(state, event.turnId, (turn) => ({
				...turn,
				items: turn.items.map((item) =>
					item.kind === "tool" && item.callId === event.callId
						? { ...item, status, summary: event.summary, truncated: event.truncated }
						: item,
				),
			}));
		}
		case "error": {
			const error = { code: event.code, message: event.message };
			const updated = updateTurn(state, event.turnId, (turn) => ({
				...turn,
				items: [...turn.items, { kind: "error", ...error }],
			}));
			return { ...updated, lastError: error };
		}
		case "turn_finished": {
			const finished = {
				stopReason: event.stopReason,
				usage: event.usage,
				...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
			};
			return { ...updateTurn(state, event.turnId, (turn) => ({ ...turn, finished })), busy: false };
		}
	}
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

function mapItems(state: ChatState, map: (item: TurnItem) => TurnItem): ChatState {
	return { ...state, turns: state.turns.map((turn) => ({ ...turn, items: turn.items.map(map) })) };
}
