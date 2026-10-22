import type { AtelierEvent, ClientCommand, JsonValue } from "@atelier/core/protocol";

/** Whether the core is up; the latest one can be asked for with getStatus(). */
export type CoreStatus =
	| { type: "core_ready"; version: string }
	/** The core could not start (missing binary, wrong protocol version...). */
	| { type: "core_failed"; message: string }
	/** The core process ended; its sessions are gone. */
	| { type: "core_exited"; message: string };

/** What the main process tells the renderer. Everything the user must see arrives through here. */
export type HostMessage =
	| CoreStatus
	| { type: "event"; sessionId: string; event: AtelierEvent }
	| { type: "protocol_error"; message: string };

export type CommandResult =
	| { ok: true; result: { [key: string]: JsonValue } }
	| { ok: false; error: { code: string; message: string } };

/** The only API the renderer has, exposed by the preload script on window.atelier. */
export interface AtelierBridge {
	request(command: ClientCommand): Promise<CommandResult>;
	onMessage(listener: (message: HostMessage) => void): () => void;
	restartCore(): Promise<void>;
	/** The latest core status, for when it was sent before this renderer subscribed. */
	getStatus(): Promise<CoreStatus | undefined>;
	/** Opens the native folder picker; undefined when cancelled. */
	pickFolder(): Promise<string | undefined>;
}

export const IPC = {
	request: "atelier:request",
	restart: "atelier:restart",
	status: "atelier:status",
	pickFolder: "atelier:pick-folder",
	message: "atelier:message",
} as const;
