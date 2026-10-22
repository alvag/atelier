import type { CoreExit } from "@atelier/core/client";
import type { AtelierEvent, ClientCommand, JsonValue } from "@atelier/core/protocol";
import type { CommandResult, HostMessage } from "../shared/bridge.ts";

/** The part of RpcClient the host uses; tests pass a fake. */
export interface CoreConnection {
	readonly coreVersion: string;
	request(command: ClientCommand): Promise<{ [key: string]: JsonValue }>;
	onEvent(listener: (sessionId: string, event: AtelierEvent) => void): () => void;
	onProtocolError(listener: (message: string) => void): () => void;
	onExit(listener: (exit: CoreExit) => void): () => void;
	close(): Promise<void>;
}

export interface CoreHostOptions {
	connect: () => Promise<CoreConnection>;
	/** Delivers a message to the renderer. */
	send: (message: HostMessage) => void;
}

function errorOf(error: unknown): { code: string; message: string } {
	const code =
		typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "internal_error";
	return { code, message: error instanceof Error ? error.message : String(error) };
}

/**
 * Owns the core process for the desktop. It never throws across IPC:
 * every request settles as ok or error, and every way the core can fail
 * (cannot start, exits, garbles the protocol) becomes a message for the UI.
 */
export class CoreHost {
	readonly #options: CoreHostOptions;
	#connection: CoreConnection | undefined;
	#connecting: Promise<void> | undefined;
	#stopping = false;

	constructor(options: CoreHostOptions) {
		this.#options = options;
	}

	start(): Promise<void> {
		this.#connecting ??= this.#connect().finally(() => {
			this.#connecting = undefined;
		});
		return this.#connecting;
	}

	async #connect(): Promise<void> {
		const { send } = this.#options;
		let connection: CoreConnection;
		try {
			connection = await this.#options.connect();
		} catch (error) {
			send({ type: "core_failed", message: errorOf(error).message });
			return;
		}
		this.#connection = connection;
		connection.onEvent((sessionId, event) => send({ type: "event", sessionId, event }));
		connection.onProtocolError((message) => send({ type: "protocol_error", message }));
		connection.onExit((exit) => {
			if (this.#connection === connection) this.#connection = undefined;
			if (this.#stopping) return;
			const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
			send({ type: "core_exited", message: `The core stopped (${how}).${exit.stderr ? `\n${exit.stderr}` : ""}` });
		});
		send({ type: "core_ready", version: connection.coreVersion });
	}

	async request(command: ClientCommand): Promise<CommandResult> {
		if (this.#connecting) await this.#connecting;
		const connection = this.#connection;
		if (!connection) return { ok: false, error: { code: "core_unavailable", message: "The core is not running." } };
		try {
			return { ok: true, result: await connection.request(command) };
		} catch (error) {
			return { ok: false, error: errorOf(error) };
		}
	}

	/** Stops the current core (if any) and starts a new one. */
	async restart(): Promise<void> {
		await this.#closeCurrent();
		await this.start();
	}

	/** Closes the core for good, e.g. when the app quits. */
	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#connecting) await this.#connecting;
		await this.#closeCurrent();
	}

	async #closeCurrent(): Promise<void> {
		const connection = this.#connection;
		this.#connection = undefined;
		if (!connection) return;
		const wasStopping = this.#stopping;
		this.#stopping = true;
		try {
			await connection.close();
		} finally {
			this.#stopping = wasStopping;
		}
	}
}
