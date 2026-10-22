import type { AtelierEvent, JsonValue } from "../events.ts";

/** Bumped on any incompatible change; sent first by the server in `hello`. */
export const PROTOCOL_VERSION = 3;

export const BACKEND_NAMES = ["claude-code", "anthropic-api"] as const;
/** claude-code uses the Claude subscription; anthropic-api runs Atelier's own loop on an API key. */
export type BackendName = (typeof BACKEND_NAMES)[number];
export const DEFAULT_BACKEND: BackendName = "claude-code";

export type ClientCommand =
	| { command: "session.start"; cwd: string; model?: string; autoApprove?: boolean; backend?: BackendName }
	| { command: "session.send"; sessionId: string; prompt: string }
	| { command: "session.interrupt"; sessionId: string }
	| { command: "session.approve"; sessionId: string; callId: string; approved: boolean }
	| { command: "session.close"; sessionId: string }
	| { command: "shutdown" };

export type CommandName = ClientCommand["command"];

/** Every command carries an id and gets exactly one response with that id. */
export type ClientMessage = { type: "command"; id: string } & ClientCommand;

export interface ProtocolError {
	code: string;
	message: string;
}

export type ServerMessage =
	| { type: "hello"; protocol: number; core: string }
	| { type: "response"; id: string; ok: true; result: { [key: string]: JsonValue } }
	| { type: "response"; id: string; ok: false; error: ProtocolError }
	| { type: "event"; sessionId: string; event: AtelierEvent }
	/** A line the server could not attribute to any command. */
	| { type: "protocol_error"; message: string };
