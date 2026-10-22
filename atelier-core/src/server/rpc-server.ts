import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { AgentBackend } from "../backend.ts";
import { KeychainError, MissingApiKeyError } from "../credentials.ts";
import { describeError, type JsonValue } from "../events.ts";
import { decodeClientMessage, encodeMessage, LineSplitter } from "../protocol/codec.ts";
import {
	type BackendName,
	type ClientMessage,
	DEFAULT_BACKEND,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "../protocol/types.ts";
import { Session } from "../session.ts";
import { BUILTIN_AGENTS, type SubagentDefinition } from "../subagents/definitions.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { VERSION } from "../version.ts";

export interface RpcServerOptions {
	input: Readable;
	/** Receives one encoded line per message; in `serve` it writes to stdout. */
	write: (line: string) => void;
	/** May be async: anthropic-api resolves its key first. */
	createBackend: (name: BackendName) => AgentBackend | Promise<AgentBackend>;
	/** Agents every session can delegate to, each on a fresh backend like the session's. Default: the builtins. */
	subagents?: readonly SubagentDefinition[];
	tools: readonly ToolDefinition[];
	systemPromptAppend: string;
	onShutdown?: () => void;
	createId?: () => string;
}

/** A failure answered as `{ ok: false, error }` to the command that caused it. */
class CommandError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

interface ServerSession {
	session: Session;
	/** Approval questions waiting for session.approve, by callId. */
	approvals: Map<string, (approved: boolean) => void>;
}

type Result = { [key: string]: JsonValue };

const MAX_REMEMBERED_IDS = 10_000;

/**
 * Serves the protocol over a line stream: one Session per session.start,
 * every command answered exactly once, events forwarded with their
 * sessionId, and approvals answered by session.approve. Approvals still
 * pending are denied when their turn is interrupted, their session closes
 * or the client goes away.
 */
export class RpcServer {
	readonly #options: RpcServerOptions;
	readonly #createId: () => string;
	readonly #sessions = new Map<string, ServerSession>();
	/** Recently used command ids, to reject reuse; bounded to the last MAX_REMEMBERED_IDS. */
	readonly #usedIds = new Set<string>();
	#stopping = false;

	constructor(options: RpcServerOptions) {
		this.#options = options;
		this.#createId = options.createId ?? randomUUID;
	}

	/** Greets, serves until the input ends or shutdown, then closes every session. */
	async run(): Promise<void> {
		this.#send({ type: "hello", protocol: PROTOCOL_VERSION, core: VERSION });
		const splitter = new LineSplitter();
		const pending = new Set<Promise<void>>();
		const handle = (line: string) => {
			const work = this.#handleLine(line).finally(() => pending.delete(work));
			pending.add(work);
		};
		this.#options.input.setEncoding("utf8");
		for await (const chunk of this.#options.input as AsyncIterable<string>) {
			for (const line of splitter.push(chunk)) handle(line);
			if (this.#stopping) break;
		}
		if (!this.#stopping) for (const line of splitter.flush()) handle(line);
		// Commands still running (a session.start, say) finish before the final cleanup,
		// and a start that completes after this point closes its own session.
		this.#stopping = true;
		await Promise.allSettled(pending);
		await this.#closeAll();
	}

	#send(message: ServerMessage): void {
		this.#options.write(encodeMessage(message));
	}

	async #handleLine(line: string): Promise<void> {
		const decoded = decodeClientMessage(line);
		if (!decoded.ok) {
			if (decoded.id === undefined) this.#send({ type: "protocol_error", message: decoded.message });
			else
				this.#send({
					type: "response",
					id: decoded.id,
					ok: false,
					error: { code: "invalid_command", message: decoded.message },
				});
			return;
		}
		const { id } = decoded.message;
		if (this.#usedIds.has(id)) {
			this.#send({
				type: "response",
				id,
				ok: false,
				error: { code: "duplicate_id", message: `Command id ${id} was already used.` },
			});
			return;
		}
		this.#usedIds.add(id);
		if (this.#usedIds.size > MAX_REMEMBERED_IDS) {
			const oldest = this.#usedIds.values().next().value;
			if (oldest !== undefined) this.#usedIds.delete(oldest);
		}
		try {
			const result = await this.#execute(decoded.message);
			this.#send({ type: "response", id, ok: true, result });
			if (decoded.message.command === "shutdown") this.#options.onShutdown?.();
		} catch (error) {
			const code = error instanceof CommandError ? error.code : "internal_error";
			this.#send({ type: "response", id, ok: false, error: { code, message: describeError(error) } });
		}
	}

	#session(sessionId: string): ServerSession {
		const entry = this.#sessions.get(sessionId);
		if (!entry) throw new CommandError("unknown_session", `No session ${sessionId}.`);
		return entry;
	}

	async #execute(message: ClientMessage): Promise<Result> {
		switch (message.command) {
			case "session.start":
				return {
					sessionId: await this.#start(
						message.cwd,
						message.model,
						message.autoApprove ?? false,
						message.backend ?? DEFAULT_BACKEND,
					),
				};
			case "session.send": {
				const entry = this.#session(message.sessionId);
				if (entry.session.busy) throw new CommandError("busy", "A turn is already running in this session.");
				const turnId = this.#createId();
				this.#runTurn(message.sessionId, entry, message.prompt, turnId).catch((error: unknown) =>
					process.stderr.write(`atelier-core: turn ${turnId} stopped: ${describeError(error)}\n`),
				);
				return { turnId };
			}
			case "session.interrupt": {
				const entry = this.#session(message.sessionId);
				denyAll(entry);
				await entry.session.interrupt();
				return {};
			}
			case "session.approve": {
				const entry = this.#session(message.sessionId);
				const answer = entry.approvals.get(message.callId);
				if (!answer) throw new CommandError("unknown_approval", `No pending approval ${message.callId}.`);
				entry.approvals.delete(message.callId);
				answer(message.approved);
				return {};
			}
			case "session.close": {
				const entry = this.#session(message.sessionId);
				this.#sessions.delete(message.sessionId);
				denyAll(entry);
				await entry.session.close();
				return {};
			}
			case "shutdown":
				this.#stopping = true;
				await this.#closeAll();
				return {};
		}
	}

	async #start(cwd: string, model: string | undefined, autoApprove: boolean, backend: BackendName): Promise<string> {
		if (this.#stopping) throw new CommandError("shutting_down", "The server is shutting down.");
		if (
			!(await stat(cwd).then(
				(s) => s.isDirectory(),
				() => false,
			))
		)
			throw new CommandError("invalid_cwd", `Working directory does not exist: ${cwd}`);
		const approvals = new Map<string, (approved: boolean) => void>();
		let session: Session;
		try {
			session = await Session.start({
				backend: await this.#options.createBackend(backend),
				cwd,
				...(model === undefined ? {} : { model }),
				tools: this.#options.tools,
				systemPromptAppend: this.#options.systemPromptAppend,
				autoApprove,
				approve: ({ callId }) => new Promise<boolean>((resolve) => approvals.set(callId, resolve)),
				odd: true,
				subagents: {
					agents: this.#options.subagents ?? BUILTIN_AGENTS,
					createBackend: () => this.#options.createBackend(backend),
				},
			});
		} catch (error) {
			if (error instanceof MissingApiKeyError || error instanceof KeychainError)
				throw new CommandError(error.code, error.message);
			throw new CommandError("session_start_failed", describeError(error));
		}
		if (this.#stopping) {
			await session.close();
			throw new CommandError("shutting_down", "The server is shutting down.");
		}
		const sessionId = this.#createId();
		this.#sessions.set(sessionId, { session, approvals });
		return sessionId;
	}

	async #runTurn(sessionId: string, entry: ServerSession, prompt: string, turnId: string): Promise<void> {
		try {
			for await (const event of entry.session.send(prompt, turnId)) this.#send({ type: "event", sessionId, event });
		} finally {
			denyAll(entry);
		}
	}

	async #closeAll(): Promise<void> {
		const entries = [...this.#sessions.values()];
		this.#sessions.clear();
		for (const entry of entries) denyAll(entry);
		await Promise.allSettled(entries.map((entry) => entry.session.close()));
	}
}

function denyAll(entry: ServerSession): void {
	for (const answer of entry.approvals.values()) answer(false);
	entry.approvals.clear();
}
