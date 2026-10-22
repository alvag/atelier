/**
 * Event contract emitted by the core. Every event is plain JSON so a client can
 * receive it over a pipe unchanged (M2).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AuthSource = "subscription" | "api_key" | "none";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

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
	| { type: "turn_finished"; stopReason: string; usage: Usage; costUsd?: number }
	| { type: "rate_limit"; status: string; resetsAt?: number; window?: string }
	| { type: "error"; code: string; message: string; recoverable: boolean };

/** An event as delivered to clients: the body stamped by the session. */
export type AtelierEvent = AtelierEventBody & { seq: number; turnId: string };

export type AtelierEventType = AtelierEventBody["type"];

export const ZERO_USAGE: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

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
