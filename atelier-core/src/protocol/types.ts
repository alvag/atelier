import type { AtelierEvent, JsonValue } from "../events.ts";

/** Bumped on any incompatible change; sent first by the server in `hello`. */
export const PROTOCOL_VERSION = 6;

/** Limit of the instructions a client may give `session.compact`. */
export const MAX_COMPACT_INSTRUCTIONS_BYTES = 2000;

export const BACKEND_NAMES = ["claude-code", "anthropic-api"] as const;
/** claude-code uses the Claude subscription; anthropic-api runs Atelier's own loop on an API key. */
export type BackendName = (typeof BACKEND_NAMES)[number];
export const DEFAULT_BACKEND: BackendName = "claude-code";

export type ClientCommand =
	| {
			command: "session.start";
			cwd: string;
			model?: string;
			autoApprove?: boolean;
			backend?: BackendName;
			review?: boolean;
			/** Runs `bash` without the sandbox (every command asks); the server's own ATELIER_SANDBOX=off applies to all sessions. */
			noSandbox?: boolean;
	  }
	| { command: "session.send"; sessionId: string; prompt: string }
	| { command: "session.interrupt"; sessionId: string }
	| { command: "session.approve"; sessionId: string; callId: string; approved: boolean }
	/** Reviews the current uncommitted change at any risk; answers like session.send. */
	| { command: "session.review"; sessionId: string }
	| { command: "session.review_consent"; sessionId: string; reviewId: string; answer: "granted" | "declined" }
	/** Undoes the correction an escalated review left in the worktree (that review, or the latest escalated one); answers like session.send. */
	| { command: "session.undo_correction"; sessionId: string; reviewId?: string }
	/** Summarizes the older history now; answers like session.send. `instructions`: at most 2000 bytes. */
	| { command: "session.compact"; sessionId: string; instructions?: string }
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
