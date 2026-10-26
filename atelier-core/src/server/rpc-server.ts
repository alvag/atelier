import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { AgentBackend } from "../backend.ts";
import { KeychainError, MissingApiKeyError } from "../credentials.ts";
import { type AtelierEvent, describeError, type JsonValue } from "../events.ts";
import type { MemoryPort } from "../memory/index.ts";
import {
	freezeProfile,
	orchestratorBackend,
	type PinPlaces,
	pinPlaces,
	readProfiles,
	resolveProfile,
	roleStartMessage,
	sessionBackend,
} from "../profiles/index.ts";
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
import { loadSandboxAdditions, SandboxConfigError } from "../tools/sandbox-config.ts";
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
	/** Connects long-term memory for a session folder. Without it sessions have no memory. */
	connectMemory?: (cwd: string) => Promise<MemoryPort>;
	tools: readonly ToolDefinition[];
	systemPromptAppend: string;
	/** Where the walk up from a session's folder for AGENTS.md / CLAUDE.md stops (excluded). Without it none are read. */
	home?: string;
	/** Sessions may review their changes (RDD). Off unless given; `serve` passes `reviewEnabled(process.env)`. */
	review?: boolean;
	/** Every session runs `bash` without the sandbox (`serve` passes `!sandboxEnabled(process.env)`). */
	noSandbox?: boolean;
	/** Where a folder's profile pins are; defaults to asking git. Tests make it slow. */
	pinPlaces?: (cwd: string) => Promise<PinPlaces>;
	onShutdown?: () => void;
	createId?: () => string;
}

/** RDD is on unless `ATELIER_REVIEW=off`. */
export function reviewEnabled(env: Record<string, string | undefined>): boolean {
	return env.ATELIER_REVIEW !== "off";
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
	/** Review questions waiting for session.review_consent, by reviewId. */
	consents: Map<string, (answer: "granted" | "declined") => void>;
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
						message.backend,
						message.review,
						message.noSandbox === true || this.#options.noSandbox === true,
						message.profile,
					),
				};
			case "profiles.list":
				return this.#profiles(message.cwd);
			case "session.send": {
				const entry = this.#session(message.sessionId);
				if (entry.session.busy) throw new CommandError("busy", "A turn is already running in this session.");
				const turnId = this.#createId();
				const prompt = message.prompt;
				this.#runTurn(message.sessionId, entry, () => entry.session.send(prompt, turnId)).catch((error: unknown) =>
					process.stderr.write(`atelier-core: turn ${turnId} stopped: ${describeError(error)}\n`),
				);
				return { turnId };
			}
			case "session.review": {
				const entry = this.#session(message.sessionId);
				if (entry.session.busy) throw new CommandError("busy", "A turn is already running in this session.");
				const turnId = this.#createId();
				this.#runTurn(message.sessionId, entry, () => entry.session.review(turnId)).catch((error: unknown) =>
					process.stderr.write(`atelier-core: review turn ${turnId} stopped: ${describeError(error)}\n`),
				);
				return { turnId };
			}
			case "session.undo_correction": {
				const entry = this.#session(message.sessionId);
				if (entry.session.busy) throw new CommandError("busy", "A turn is already running in this session.");
				const turnId = this.#createId();
				const reviewId = message.reviewId;
				this.#runTurn(message.sessionId, entry, () => entry.session.undoCorrection(reviewId, turnId)).catch(
					(error: unknown) =>
						process.stderr.write(`atelier-core: undo turn ${turnId} stopped: ${describeError(error)}\n`),
				);
				return { turnId };
			}
			case "session.compact": {
				const entry = this.#session(message.sessionId);
				if (entry.session.busy) throw new CommandError("busy", "A turn is already running in this session.");
				const turnId = this.#createId();
				const instructions = message.instructions;
				this.#runTurn(message.sessionId, entry, () => entry.session.compact(instructions, turnId)).catch(
					(error: unknown) =>
						process.stderr.write(`atelier-core: compaction turn ${turnId} stopped: ${describeError(error)}\n`),
				);
				return { turnId };
			}
			case "session.review_consent": {
				const entry = this.#session(message.sessionId);
				const answer = entry.consents.get(message.reviewId);
				if (!answer) throw new CommandError("unknown_review", `No pending review question ${message.reviewId}.`);
				entry.consents.delete(message.reviewId);
				answer(message.answer);
				return {};
			}
			case "session.interrupt": {
				const entry = this.#session(message.sessionId);
				denyAll(entry);
				await entry.session.interrupt();
				// An interrupted question is not a refusal: the session drops it and offers the review again.
				entry.consents.clear();
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
				declineAll(entry);
				await entry.session.close();
				return {};
			}
			case "shutdown":
				this.#stopping = true;
				await this.#closeAll();
				return {};
		}
	}

	/** The profile names for a selector, the global `active`, and the profile a session in `cwd` would take without a choice. */
	async #profiles(cwd: string | undefined): Promise<Result> {
		const home = this.#options.home;
		if (home === undefined) return { profiles: [] };
		const read = await readProfiles(home);
		const names = read.valid ? [...read.file.profiles.keys()] : [];
		const active = read.valid ? read.file.active : undefined;
		// One read of the file serves the names, `active` and the resolution.
		const resolved =
			cwd === undefined
				? undefined
				: await resolveProfile({ cwd, home, profiles: read, pins: await this.#pinPlaces(cwd) });
		return {
			profiles: names,
			...(active === undefined ? {} : { active }),
			...(resolved === undefined
				? {}
				: {
						effective: {
							...(resolved.name === undefined ? {} : { name: resolved.name }),
							origin: resolved.origin,
						},
					}),
		};
	}

	#pinPlaces(cwd: string): Promise<PinPlaces> {
		return (this.#options.pinPlaces ?? pinPlaces)(cwd);
	}

	async #start(
		cwd: string,
		model: string | undefined,
		autoApprove: boolean,
		/** Absent: the orchestrator's backend in the profile, then the default. */
		requestedBackend: BackendName | undefined,
		/** Absent means the server's default; an explicit true the server cannot honor is refused, never dropped. */
		requested: boolean | undefined,
		noSandbox: boolean,
		/** The client's profile: the first layer of the resolution. */
		choice: string | undefined,
	): Promise<string> {
		if (this.#stopping) throw new CommandError("shutting_down", "The server is shutting down.");
		// A chosen profile the server cannot read is refused, never dropped.
		if (choice !== undefined && this.#options.home === undefined)
			throw new CommandError("profile_unavailable", "This server reads no profiles: it has no home directory.");
		if (requested === true && !this.#options.review)
			throw new CommandError("review_unavailable", "Review is off on this server (ATELIER_REVIEW=off).");
		const review = (requested ?? true) && this.#options.review === true;
		if (
			!(await stat(cwd).then(
				(s) => s.isDirectory(),
				() => false,
			))
		)
			throw new CommandError("invalid_cwd", `Working directory does not exist: ${cwd}`);
		// A broken sandbox file stops the session: ignoring it would silently widen or narrow what commands may do.
		// With the sandbox off the files are not used, so they are not validated either (same as the CLI).
		if (!noSandbox && this.#options.home !== undefined) {
			try {
				loadSandboxAdditions({ cwd, home: this.#options.home });
			} catch (error) {
				if (error instanceof SandboxConfigError) throw new CommandError("session_start_failed", error.message);
				throw error;
			}
		}
		// The profile is resolved once, here, and the session keeps it. Without a home there are no profile files to read.
		const profile =
			this.#options.home === undefined
				? undefined
				: await freezeProfile({
						cwd,
						home: this.#options.home,
						pins: await this.#pinPlaces(cwd),
						...(choice === undefined ? {} : { choice }),
					});
		const backend = sessionBackend(profile, requestedBackend, DEFAULT_BACKEND);
		const approvals = new Map<string, (approved: boolean) => void>();
		const consents = new Map<string, (answer: "granted" | "declined") => void>();
		// Memory is optional: a session that cannot connect it starts anyway and says why.
		let memory: MemoryPort | undefined;
		let memoryUnavailable: string | undefined;
		if (this.#options.connectMemory)
			memory = await Promise.resolve()
				.then(() => this.#options.connectMemory?.(cwd))
				.catch((error: unknown) => {
					memoryUnavailable = describeError(error);
					return undefined;
				});
		let session: Session;
		try {
			session = await Session.start({
				...(memory ? { memory } : {}),
				...(memoryUnavailable === undefined ? {} : { memoryUnavailable }),
				backend: await this.#options.createBackend(backend),
				...(profile === undefined ? {} : { profile }),
				cwd,
				...(model === undefined ? {} : { model }),
				tools: this.#options.tools,
				systemPromptAppend: this.#options.systemPromptAppend,
				autoApprove,
				...(noSandbox ? { noSandbox: true } : {}),
				approve: ({ callId }) => new Promise<boolean>((resolve) => approvals.set(callId, resolve)),
				odd: true,
				...(this.#options.home === undefined ? {} : { projectInstructions: { home: this.#options.home } }),
				...(review
					? {
							review: {
								createBackend: (name) => this.#options.createBackend(name ?? backend),
								consent: ({ reviewId }) => new Promise((resolve) => consents.set(reviewId, resolve)),
							},
						}
					: {
							reviewUnavailable: this.#options.review
								? "Review is off for this session."
								: "Review is off on this server (ATELIER_REVIEW=off).",
						}),
				subagents: {
					agents: this.#options.subagents ?? BUILTIN_AGENTS,
					createBackend: (name) => this.#options.createBackend(name ?? backend),
				},
			});
		} catch (error) {
			await memory?.close().catch(() => {});
			// A backend the profile chose for the orchestrator fails naming the role and the backend.
			const named = requestedBackend === undefined ? orchestratorBackend(profile) : undefined;
			if (named !== undefined && (error instanceof MissingApiKeyError || error instanceof KeychainError))
				throw new CommandError(error.code, roleStartMessage("orchestrator", named, error));
			if (named !== undefined)
				throw new CommandError("session_start_failed", roleStartMessage("orchestrator", named, error));
			if (error instanceof MissingApiKeyError || error instanceof KeychainError)
				throw new CommandError(error.code, error.message);
			throw new CommandError("session_start_failed", describeError(error));
		}
		if (this.#stopping) {
			await session.close();
			throw new CommandError("shutting_down", "The server is shutting down.");
		}
		const sessionId = this.#createId();
		this.#sessions.set(sessionId, { session, approvals, consents });
		return sessionId;
	}

	/** Forwards one turn's events: a prompt, a review or a compaction. */
	async #runTurn(sessionId: string, entry: ServerSession, turn: () => AsyncIterable<AtelierEvent>): Promise<void> {
		try {
			for await (const event of turn()) this.#send({ type: "event", sessionId, event });
		} finally {
			denyAll(entry);
			entry.consents.clear();
		}
	}

	async #closeAll(): Promise<void> {
		const entries = [...this.#sessions.values()];
		this.#sessions.clear();
		for (const entry of entries) {
			denyAll(entry);
			declineAll(entry);
		}
		await Promise.allSettled(entries.map((entry) => entry.session.close()));
	}
}

function denyAll(entry: ServerSession): void {
	for (const answer of entry.approvals.values()) answer(false);
	entry.approvals.clear();
}

function declineAll(entry: ServerSession): void {
	for (const answer of entry.consents.values()) answer("declined");
	entry.consents.clear();
}
