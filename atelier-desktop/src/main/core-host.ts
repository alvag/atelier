import type { CoreExit } from "@atelier/core/client";
import type { AtelierEvent, ClientCommand, JsonValue } from "@atelier/core/protocol";
import type { CommandResult, CoreStatus, HostMessage } from "../shared/bridge.ts";

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
 * start, restart and stop run one at a time, so no core is left orphaned;
 * stop is final.
 */
export class CoreHost {
	readonly #options: CoreHostOptions;
	#connection: CoreConnection | undefined;
	#lifecycle: Promise<void> = Promise.resolve();
	#stopped = false;
	/** Connections this host closed on purpose: their exit is not a crash. */
	readonly #closing = new WeakSet<CoreConnection>();
	#status: CoreStatus | undefined;

	constructor(options: CoreHostOptions) {
		this.#options = options;
	}

	/** The last core status, for a renderer that subscribes after it was sent (or reloads). */
	status(): CoreStatus | undefined {
		return this.#status;
	}

	/** Starts the core unless it is already running or the host was stopped. */
	start(): Promise<void> {
		return this.#enqueue(async () => {
			if (!this.#connection && !this.#stopped) await this.#connect();
		});
	}

	/** Stops the current core (if any) and starts a new one. */
	restart(): Promise<void> {
		return this.#enqueue(async () => {
			await this.#closeCurrent();
			if (!this.#stopped) await this.#connect();
		});
	}

	/** Closes the core for good, e.g. when the app quits. */
	stop(): Promise<void> {
		this.#stopped = true;
		return this.#enqueue(() => this.#closeCurrent());
	}

	async request(command: ClientCommand): Promise<CommandResult> {
		await this.#lifecycle;
		const connection = this.#connection;
		if (!connection) return { ok: false, error: { code: "core_unavailable", message: "The core is not running." } };
		try {
			return { ok: true, result: await connection.request(command) };
		} catch (error) {
			return { ok: false, error: errorOf(error) };
		}
	}

	#enqueue(step: () => Promise<void>): Promise<void> {
		const run = this.#lifecycle.then(step);
		this.#lifecycle = run.catch(() => {});
		return run;
	}

	#report(status: CoreStatus): void {
		this.#status = status;
		this.#options.send(status);
	}

	async #connect(): Promise<void> {
		const { send } = this.#options;
		let connection: CoreConnection;
		try {
			connection = await this.#options.connect();
		} catch (error) {
			this.#report({ type: "core_failed", message: errorOf(error).message });
			return;
		}
		this.#connection = connection;
		connection.onEvent((sessionId, event) => send({ type: "event", sessionId, event }));
		connection.onProtocolError((message) => send({ type: "protocol_error", message }));
		connection.onExit((exit) => {
			if (this.#connection === connection) this.#connection = undefined;
			if (this.#closing.has(connection)) return;
			const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
			this.#report({
				type: "core_exited",
				message: `The core stopped (${how}).${exit.stderr ? `\n${exit.stderr}` : ""}`,
			});
		});
		this.#report({ type: "core_ready", version: connection.coreVersion });
	}

	async #closeCurrent(): Promise<void> {
		const connection = this.#connection;
		this.#connection = undefined;
		if (!connection) return;
		this.#closing.add(connection);
		await connection.close();
	}
}
