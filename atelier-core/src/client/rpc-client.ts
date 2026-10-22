import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AtelierEvent, JsonValue } from "../events.ts";
import { decodeServerMessage, encodeMessage, LineSplitter } from "../protocol/codec.ts";
import { type ClientCommand, PROTOCOL_VERSION, type ServerMessage } from "../protocol/types.ts";

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const STDERR_TAIL_BYTES = 4096;

export interface RpcClientOptions {
	/** Executable that runs the core, e.g. `node`. */
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	helloTimeoutMs?: number;
	/** How long close() waits for the core to exit after shutdown before killing it. */
	closeTimeoutMs?: number;
}

export interface CoreExit {
	code: number | null;
	signal: string | null;
	/** Last bytes the core wrote to stderr, to explain a crash. */
	stderr: string;
}

/** A command that failed: the core's `{ ok: false }` answer, or a client-side failure such as core_exited. */
export class RpcError extends Error {
	override name = "RpcError";
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

type ResultFor<C extends ClientCommand> = C extends { command: "session.start" }
	? { sessionId: string }
	: C extends { command: "session.send" }
		? { turnId: string }
		: Record<string, never>;

interface Pending {
	resolve: (result: { [key: string]: JsonValue }) => void;
	reject: (error: RpcError) => void;
}

/**
 * Runs the core as a child process and speaks the protocol with it: every
 * request gets its own id and settles with the matching response, events
 * and protocol errors go to listeners, and if the core dies every pending
 * request fails with core_exited instead of hanging.
 */
export class RpcClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<string, Pending>();
	readonly #eventListeners = new Set<(sessionId: string, event: AtelierEvent) => void>();
	readonly #protocolErrorListeners = new Set<(message: string) => void>();
	readonly #exitListeners = new Set<(exit: CoreExit) => void>();
	readonly #closeTimeoutMs: number;
	#nextId = 0;
	#stderr = "";
	#exit: CoreExit | undefined;
	#hello: ((message: Extract<ServerMessage, { type: "hello" }>) => void) | undefined;
	coreVersion = "";

	private constructor(child: ChildProcessWithoutNullStreams, closeTimeoutMs: number) {
		this.#child = child;
		this.#closeTimeoutMs = closeTimeoutMs;
		const splitter = new LineSplitter();
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			for (const line of splitter.push(chunk)) this.#receive(line);
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_BYTES);
		});
		const onExit = (code: number | null, signal: string | null) =>
			this.#exited({ code, signal, stderr: this.#stderr.trim() });
		child.on("close", onExit);
		child.on("error", (error) => {
			this.#stderr = (this.#stderr + error.message).slice(-STDERR_TAIL_BYTES);
			onExit(null, null);
		});
		child.stdin.on("error", () => {});
	}

	/** Starts the core and waits for its hello; fails if it does not speak our protocol version. */
	static async connect(options: RpcClientOptions): Promise<RpcClient> {
		const child = spawn(options.command, options.args, {
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = new RpcClient(child, options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
		try {
			const hello = await new Promise<Extract<ServerMessage, { type: "hello" }>>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new RpcError("hello_timeout", "The core did not answer in time.")),
					options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
				);
				client.#hello = (message) => {
					clearTimeout(timer);
					resolve(message);
				};
				client.onExit((exit) => {
					clearTimeout(timer);
					reject(exitError(exit));
				});
			});
			if (hello.protocol !== PROTOCOL_VERSION)
				throw new RpcError(
					"protocol_mismatch",
					`The core speaks protocol ${hello.protocol}; this client needs ${PROTOCOL_VERSION}.`,
				);
			client.coreVersion = hello.core;
			return client;
		} catch (error) {
			client.#kill();
			throw error;
		}
	}

	request<C extends ClientCommand>(command: C): Promise<ResultFor<C>> {
		if (this.#exit) return Promise.reject(exitError(this.#exit));
		const id = `r${++this.#nextId}`;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as Pending["resolve"], reject });
			// The envelope goes last, so a command object can never override its id or type.
			this.#child.stdin.write(encodeMessage({ ...command, type: "command", id }));
		});
	}

	onEvent(listener: (sessionId: string, event: AtelierEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onProtocolError(listener: (message: string) => void): () => void {
		this.#protocolErrorListeners.add(listener);
		return () => this.#protocolErrorListeners.delete(listener);
	}

	/** Called once when the core process ends, for any reason. */
	onExit(listener: (exit: CoreExit) => void): () => void {
		if (this.#exit) listener(this.#exit);
		else this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	get exited(): boolean {
		return this.#exit !== undefined;
	}

	/** Asks the core to shut down, and kills it if it has not exited in time. */
	async close(): Promise<void> {
		if (this.#exit) return;
		const exited = new Promise<void>((resolve) => this.onExit(() => resolve()));
		this.request({ command: "shutdown" }).catch(() => {});
		this.#child.stdin.end();
		const timer = setTimeout(() => this.#kill(), this.#closeTimeoutMs);
		await exited;
		clearTimeout(timer);
	}

	#kill(): void {
		if (!this.#exit) this.#child.kill("SIGKILL");
	}

	#receive(line: string): void {
		const message = decodeServerMessage(line);
		switch (message.type) {
			case "hello":
				this.#hello?.(message);
				this.#hello = undefined;
				return;
			case "response": {
				const pending = this.#pending.get(message.id);
				if (!pending) {
					this.#protocolError(`Response to an unknown command id: ${message.id}`);
					return;
				}
				this.#pending.delete(message.id);
				if (message.ok) pending.resolve(message.result);
				else pending.reject(new RpcError(message.error.code, message.error.message));
				return;
			}
			case "event":
				for (const listener of this.#eventListeners) listener(message.sessionId, message.event);
				return;
			case "protocol_error":
				this.#protocolError(message.message);
				return;
			case "unknown":
				this.#protocolError(`Unreadable line from the core: ${message.line}`);
				return;
		}
	}

	#protocolError(message: string): void {
		for (const listener of this.#protocolErrorListeners) listener(message);
	}

	#exited(exit: CoreExit): void {
		if (this.#exit) return;
		this.#exit = exit;
		const error = exitError(exit);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		for (const listener of this.#exitListeners) listener(exit);
		this.#exitListeners.clear();
	}
}

function exitError(exit: CoreExit): RpcError {
	const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
	return new RpcError("core_exited", `The core exited (${how}).${exit.stderr ? `\n${exit.stderr}` : ""}`);
}
