import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Readable } from "node:stream";
import type { AgentBackend } from "../backend.ts";
import { KeychainError, MissingApiKeyError } from "../credentials.ts";
import { type AtelierEvent, describeError, type JsonValue } from "../events.ts";
import type { McpManager } from "../mcp/index.ts";
import type { MemoryPort } from "../memory/index.ts";
import { PERMISSION_MODES } from "../modes.ts";
import { BACKEND_MODELS, BASE_CATALOG, type ModelCatalog } from "../options.ts";
import { type DefaultPermissionMode, readDefaultPermissionMode } from "../permission-mode.ts";
import { PermissionRules } from "../permission-rules.ts";
import {
	closestName,
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
	BACKEND_NAMES,
	type BackendName,
	type ClientMessage,
	DEFAULT_BACKEND,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "../protocol/types.ts";
import type { ReviewConsentAnswer } from "../review/session-review.ts";
import {
	type ApprovalAnswer,
	ConfigureError,
	type MainChange,
	type PermissionMode,
	Session,
	type SessionConfiguration,
} from "../session.ts";
import { type LoadedSession, SessionFileError, type SessionRecorder, SessionStore } from "../sessions/index.ts";
import { BUILTIN_AGENTS, type SubagentDefinition } from "../subagents/definitions.ts";
import { THINKING_LEVELS } from "../thinking.ts";
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
	/** Opens the user's MCP servers for a session folder; they connect in the background. Without it sessions have none. */
	connectMcp?: (cwd: string) => McpManager;
	tools: readonly ToolDefinition[];
	systemPromptAppend: string;
	/** Where the walk up from a session's folder for AGENTS.md / CLAUDE.md stops (excluded). Without it none are read. */
	home?: string;
	/** Sessions may review their changes (RDD). Off unless given; `serve` passes `reviewEnabled(process.env)`. */
	review?: boolean;
	/** Every session runs `bash` without the sandbox (`serve` passes `!sandboxEnabled(process.env)`). */
	noSandbox?: boolean;
	/**
	 * Saves the sessions it starts under `home` and serves `sessions.list`, `session.resume`, `session.rename` and
	 * `session.delete`. On by default when there is a `home`; `serve` turns it off for the echo backend.
	 */
	sessions?: boolean;
	/** Where `options.list` takes each backend's models from; the lists in the code by default. */
	catalog?: ModelCatalog;
	/**
	 * The backends with a sign-in or a key, whose models `options.list` offers; asked at each `options.list`, so a
	 * `/login` shows at the next one. Without it none is offered.
	 */
	signedIn?: () => Promise<readonly BackendName[]>;
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
	/** The folder the session works in: where its profile pins are. */
	cwd: string;
	/** The recorder of the saved session; its file is not resumed or deleted while this session runs. */
	recorder?: SessionRecorder;
	/** Approval questions waiting for session.approve, by callId. */
	approvals: Map<string, (answer: ApprovalAnswer) => void>;
	/** Review questions waiting for session.review_consent, by reviewId. */
	consents: Map<string, (answer: ReviewConsentAnswer) => void>;
}

type Result = { [key: string]: JsonValue };

/** What `#start` needs, from `session.start` or from a saved session. */
interface StartRequest {
	cwd: string;
	model?: string | undefined;
	/** Absent: the saved session's, else the orchestrator's backend in the profile, then the default. */
	backend?: BackendName | undefined;
	/** Absent means the server's default; an explicit true the server cannot honor is refused, never dropped. */
	review?: boolean | undefined;
	noSandbox: boolean;
	/** The client's profile: the first layer of the resolution. */
	profile?: string | undefined;
	/** Absent: the saved session's, else the saved default mode. */
	mode?: PermissionMode | undefined;
	/** The session is not saved. */
	noSession?: boolean | undefined;
	/** Starts from this saved session and goes on writing its file. */
	resumed?: { loaded: LoadedSession; store: SessionStore } | undefined;
}

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
	/** Files of saved sessions this server writes: one writer per file. */
	readonly #writing = new Set<string>();
	readonly #store: SessionStore | undefined;
	#stopping = false;

	constructor(options: RpcServerOptions) {
		this.#options = options;
		this.#createId = options.createId ?? randomUUID;
		if (options.home !== undefined && options.sessions !== false) this.#store = new SessionStore(options.home);
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

	/** The session's rules as the protocol carries them. */
	async #rules(sessionId: string): Promise<JsonValue[]> {
		const rules = await this.#session(sessionId).session.permissionRules();
		return rules.map(({ id, scope, kind, value }) => ({ id, scope, kind, value }));
	}

	#session(sessionId: string): ServerSession {
		const entry = this.#sessions.get(sessionId);
		if (!entry) throw new CommandError("unknown_session", `No session ${sessionId}.`);
		return entry;
	}

	async #execute(message: ClientMessage): Promise<Result> {
		switch (message.command) {
			case "session.start": {
				const started = await this.#start({
					cwd: message.cwd,
					model: message.model,
					backend: message.backend,
					review: message.review,
					noSandbox: message.noSandbox === true || this.#options.noSandbox === true,
					profile: message.profile,
					mode: message.mode,
					noSession: message.noSession === true,
				});
				return {
					sessionId: started.sessionId,
					...(started.savedId === undefined ? {} : { savedId: started.savedId }),
					configuration: configurationResult(started.session.configuration()),
				};
			}
			case "sessions.list":
				return this.#saved(async (store) => ({
					sessions: JSON.parse(JSON.stringify(await store.list(message.cwd))) as JsonValue[],
				}));
			case "session.resume":
				return this.#resume(message.cwd, message.sessionId);
			case "session.rename":
				return this.#saved(async (store) => {
					await store.rename(message.cwd, message.sessionId, message.name);
					return {};
				});
			case "session.delete":
				return this.#saved(async (store) => {
					if (this.#writing.has(store.path(message.cwd, message.sessionId)))
						throw new CommandError(
							"session_in_use",
							`Session ${message.sessionId} is running in this server; close it first.`,
						);
					await store.delete(message.cwd, message.sessionId);
					return {};
				});
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
			case "session.queue": {
				const entry = this.#session(message.sessionId);
				let id: string;
				try {
					({ id } = entry.session.queue(message.kind, message.text));
				} catch (error) {
					// A turn that is ending interrupted or failed takes nothing more: the client keeps the message.
					if (error instanceof ConfigureError) throw new CommandError(error.code, error.message);
					throw error;
				}
				if (entry.session.busy) return { id };
				// Nothing runs to queue it behind: it starts its turn now.
				const turnId = this.#createId();
				this.#runQueued(message.sessionId, entry, turnId);
				return { id, turnId };
			}
			case "session.queue_edit": {
				const entry = this.#session(message.sessionId);
				if (!entry.session.editQueued(message.messageId, message.text))
					throw new CommandError(
						"not_queued",
						`No queued message ${message.messageId}; it may have been sent already.`,
					);
				return {};
			}
			case "session.unqueue": {
				const entry = this.#session(message.sessionId);
				return { messages: entry.session.unqueue(message.messageId).map((queued) => ({ ...queued })) };
			}
			case "session.review": {
				const entry = this.#session(message.sessionId);
				if (entry.session.busy) throw new CommandError("busy", "A turn is already running in this session.");
				const turnId = this.#createId();
				const ref = message.ref;
				this.#runTurn(message.sessionId, entry, () => entry.session.review(turnId, ref)).catch((error: unknown) =>
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
			case "session.mcp":
				return { ...(this.#session(message.sessionId).session.mcpStatus() ?? { servers: [], problems: [] }) };
			case "session.mcp_login":
			case "session.mcp_logout": {
				const { session } = this.#session(message.sessionId);
				try {
					if (message.command === "session.mcp_login") await session.mcpLogin(message.server);
					else await session.mcpLogout(message.server);
				} catch (error) {
					throw new CommandError("mcp_failed", describeError(error));
				}
				return { ...(session.mcpStatus() ?? { servers: [], problems: [] }) };
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
				answer(message.approved && message.remember !== undefined ? { remember: message.remember } : message.approved);
				return {};
			}
			case "session.permissions":
				return { rules: await this.#rules(message.sessionId) };
			case "session.permissions_remove": {
				const { session } = this.#session(message.sessionId);
				const removed = await session.removePermissionRule(message.ruleId).catch((error: unknown) => {
					throw new CommandError("rules_not_saved", describeError(error));
				});
				if (!removed) throw new CommandError("unknown_rule", `No rule ${message.ruleId}.`);
				return { rules: await this.#rules(message.sessionId) };
			}
			case "session.set_mode": {
				this.#session(message.sessionId).session.setPermissionMode(message.mode);
				return { mode: message.mode };
			}
			case "session.set_model":
				return this.#configure(message.sessionId, { model: message.model });
			case "session.set_effort":
				return this.#configure(message.sessionId, { thinking: message.effort });
			case "session.set_profile":
				return this.#setProfile(message.sessionId, message.profile);
			case "session.set_backend":
				return this.#setBackend(message.sessionId, message.backend, message.model);
			case "options.list":
				return this.#optionsList(message.cwd);
			case "session.close": {
				const entry = this.#session(message.sessionId);
				this.#sessions.delete(message.sessionId);
				denyAll(entry);
				declineAll(entry);
				try {
					await entry.session.close();
				} finally {
					this.#release(entry);
				}
				return {};
			}
			case "shutdown":
				this.#stopping = true;
				await this.#closeAll();
				return {};
		}
	}

	/** Changes the main agent's model or level and answers the configuration the next turn runs with. */
	async #configure(sessionId: string, change: MainChange): Promise<Result> {
		const session = this.#session(sessionId).session;
		return this.#changing(() => session.configure(change));
	}

	/** Creates the backend as `session.start` does, refusing what it cannot create, and moves the session to it. */
	async #setBackend(sessionId: string, name: BackendName, model: string | undefined): Promise<Result> {
		const session = this.#session(sessionId).session;
		let backend: AgentBackend;
		try {
			backend = await this.#options.createBackend(name);
		} catch (error) {
			if (error instanceof MissingApiKeyError || error instanceof KeychainError)
				throw new CommandError(error.code, error.message);
			throw new CommandError("backend_start_failed", `${name} could not start: ${describeError(error)}`);
		}
		return this.#changing(() => session.setBackend(backend, model));
	}

	/**
	 * Freezes the profile `name` again, as `session.start` does, and gives it to the session. A name the server cannot
	 * find is refused, never dropped for another layer's profile.
	 */
	async #setProfile(sessionId: string, name: string): Promise<Result> {
		const { session, cwd } = this.#session(sessionId);
		const home = this.#options.home;
		if (home === undefined)
			throw new CommandError("profile_unavailable", "This server reads no profiles: it has no home directory.");
		const read = await readProfiles(home);
		const known = read.valid ? [...read.file.profiles.keys()] : [];
		if (!known.includes(name)) {
			const near = closestName(name, known);
			const missing = `No profile "${name}" in ~/.atelier/profiles.json`;
			throw new CommandError(
				"unknown_profile",
				near === undefined ? `${missing}.` : `${missing}; did you mean "${near}"?`,
			);
		}
		const profile = await freezeProfile({ cwd, home, pins: await this.#pinPlaces(cwd), choice: name });
		return this.#changing(() => session.setProfile(profile));
	}

	/** Answers the configuration a change leaves, or the error code the session refused it with. */
	async #changing(change: () => Promise<SessionConfiguration>): Promise<Result> {
		try {
			return configurationResult(await change());
		} catch (error) {
			if (error instanceof ConfigureError) throw new CommandError(error.code, error.message);
			throw error;
		}
	}

	/**
	 * What the selectors of a client offer: the backends with their models, the models of the backends signed in to,
	 * the effort levels, the modes and the profiles.
	 */
	async #optionsList(cwd: string | undefined): Promise<Result> {
		const catalog = this.#options.catalog ?? BASE_CATALOG;
		const [lists, signedIn] = await Promise.all([
			// A catalog that fails for a backend leaves it its list in the code: options.list never fails for it.
			Promise.all(
				BACKEND_NAMES.map((name) =>
					Promise.resolve()
						.then(() => catalog.models(name))
						.catch(() => BACKEND_MODELS[name]),
				),
			),
			// The sign-ins only narrow the models offered: when they cannot be read, the rest of the answer still serves.
			(this.#options.signedIn?.() ?? Promise.resolve<readonly BackendName[]>([])).catch(
				(): readonly BackendName[] => [],
			),
		]);
		const backends = BACKEND_NAMES.map((name, index) => ({ name, models: [...(lists[index] ?? [])] }));
		return {
			backends,
			models: backends
				.filter(({ name }) => signedIn.includes(name))
				.flatMap(({ name, models }) => models.map((model) => ({ provider: name, model }))),
			efforts: [...THINKING_LEVELS],
			modes: [...PERMISSION_MODES],
			...(await this.#profiles(cwd)),
		};
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

	/** Runs a saved-session command; a file problem is answered with its own code. */
	async #saved(run: (store: SessionStore) => Promise<Result>): Promise<Result> {
		const store = this.#store;
		if (store === undefined)
			throw new CommandError("sessions_unavailable", "This server does not save sessions: it has no home directory.");
		try {
			return await run(store);
		} catch (error) {
			if (error instanceof SessionFileError) throw new CommandError(error.code, error.message);
			throw error;
		}
	}

	/** Starts a session from a saved one and answers what a client needs to show it again. */
	async #resume(cwd: string, savedId: string): Promise<Result> {
		return this.#saved(async (store) => {
			const loaded = await store.load(cwd, savedId);
			const started = await this.#start({
				cwd,
				noSandbox: this.#options.noSandbox === true,
				resumed: { loaded, store },
			});
			return {
				sessionId: started.sessionId,
				savedId,
				...(loaded.name === undefined ? {} : { name: loaded.name }),
				createdAt: loaded.header.createdAt,
				configuration: configurationResult(started.session.configuration()),
				entries: loaded.entries as unknown as JsonValue[],
			};
		});
	}

	#release(entry: ServerSession): void {
		if (entry.recorder) this.#writing.delete(entry.recorder.path);
	}

	async #start(request: StartRequest): Promise<{ sessionId: string; session: Session; savedId?: string }> {
		const { cwd, resumed, noSandbox, review: requested } = request;
		const saved = resumed?.loaded;
		// A saved session restores what it ran with; what the client asks for wins.
		const model = request.model ?? saved?.config.model;
		const requestedBackend = request.backend ?? saved?.config.backend;
		const choice = request.profile ?? saved?.config.profile;
		const requestedMode = request.mode ?? saved?.config.mode;
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
		// An explicit mode skips the file, so a broken default is not reported when it does not matter.
		const modeRead: DefaultPermissionMode =
			requestedMode === undefined
				? await readDefaultPermissionMode(this.#options.home ?? homedir())
				: { mode: requestedMode };
		// One writer per saved session: a second resume of the same file would interleave with the first.
		let recorder: SessionRecorder | undefined;
		if (resumed) recorder = resumed.store.continue(cwd, resumed.loaded);
		else if (this.#store && !request.noSession) recorder = this.#store.create(cwd);
		if (recorder && this.#writing.has(recorder.path))
			throw new CommandError("session_in_use", `Session ${recorder.id} is already running in this server.`);
		if (recorder) {
			this.#writing.add(recorder.path);
			// Another process may hold the file: the lock says so.
			try {
				await recorder.lock();
			} catch (error) {
				this.#writing.delete(recorder.path);
				throw new CommandError(
					error instanceof SessionFileError ? error.code : "session_start_failed",
					describeError(error),
				);
			}
		}
		const approvals = new Map<string, (answer: ApprovalAnswer) => void>();
		const consents = new Map<string, (answer: ReviewConsentAnswer) => void>();
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
		const mcp = this.#options.connectMcp?.(cwd);
		let session: Session;
		try {
			session = await Session.start({
				...(memory ? { memory } : {}),
				...(mcp ? { mcp } : {}),
				...(memoryUnavailable === undefined ? {} : { memoryUnavailable }),
				backend: await this.#options.createBackend(backend),
				...(profile === undefined ? {} : { profile }),
				cwd,
				permissionMode: modeRead.mode,
				...(modeRead.problem === undefined ? {} : { permissionModeProblem: modeRead.problem }),
				...(model === undefined ? {} : { model }),
				...(saved?.config.thinking === undefined ? {} : { thinking: saved.config.thinking }),
				...(saved?.resume === undefined ? {} : { resume: saved.resume }),
				...(recorder === undefined ? {} : { record: recorder }),
				tools: this.#options.tools,
				systemPromptAppend: this.#options.systemPromptAppend,
				...(noSandbox ? { noSandbox: true } : {}),
				approve: ({ callId }) => new Promise<ApprovalAnswer>((resolve) => approvals.set(callId, resolve)),
				permissionRules: new PermissionRules({ home: this.#options.home ?? homedir() }),
				permissionClassifier: { createBackend: (name) => this.#options.createBackend(name ?? backend) },
				odd: true,
				...(this.#options.home === undefined
					? {}
					: { projectInstructions: { home: this.#options.home }, skills: { home: this.#options.home } }),
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
			if (recorder) this.#writing.delete(recorder.path);
			await recorder?.release();
			await memory?.close().catch(() => {});
			await mcp?.close().catch(() => {});
			// A backend the profile chose for the orchestrator fails naming the role and the backend.
			const named = requestedBackend === undefined ? orchestratorBackend(profile) : undefined;
			if (named !== undefined && (error instanceof MissingApiKeyError || error instanceof KeychainError))
				throw new CommandError(error.code, roleStartMessage("orchestrator", named, error));
			if (named !== undefined)
				throw new CommandError("session_start_failed", roleStartMessage("orchestrator", named, error));
			if (error instanceof MissingApiKeyError || error instanceof KeychainError)
				throw new CommandError(error.code, error.message);
			if (saved)
				throw new CommandError(
					"session_resume_failed",
					`Could not resume session ${saved.header.id}: ${describeError(error)}`,
				);
			throw new CommandError("session_start_failed", describeError(error));
		}
		if (this.#stopping) {
			await session.close();
			if (recorder) this.#writing.delete(recorder.path);
			throw new CommandError("shutting_down", "The server is shutting down.");
		}
		const sessionId = this.#createId();
		this.#sessions.set(sessionId, {
			session,
			cwd,
			approvals,
			consents,
			...(recorder === undefined ? {} : { recorder }),
		});
		return { sessionId, session, ...(recorder === undefined ? {} : { savedId: recorder.id }) };
	}

	/** Forwards one turn's events: a prompt, a review or a compaction; then runs what was queued meanwhile. */
	async #runTurn(sessionId: string, entry: ServerSession, turn: () => AsyncIterable<AtelierEvent>): Promise<void> {
		try {
			for await (const event of turn()) this.#send({ type: "event", sessionId, event });
		} finally {
			denyAll(entry);
			entry.consents.clear();
		}
		// A turn that was interrupted or failed has given its queue back, so nothing follows it.
		if (this.#sessions.get(sessionId) === entry && !entry.session.busy) this.#runQueued(sessionId, entry);
	}

	/** Runs the next queued message of the session as a turn, when there is one. */
	#runQueued(sessionId: string, entry: ServerSession, turnId: string = this.#createId()): void {
		const next = entry.session.nextQueued(turnId);
		if (!next) return;
		this.#runTurn(sessionId, entry, () => next).catch((error: unknown) =>
			process.stderr.write(`atelier-core: queued turn ${turnId} stopped: ${describeError(error)}\n`),
		);
	}

	async #closeAll(): Promise<void> {
		const entries = [...this.#sessions.values()];
		this.#sessions.clear();
		for (const entry of entries) {
			denyAll(entry);
			declineAll(entry);
		}
		await Promise.allSettled(entries.map((entry) => entry.session.close()));
		for (const entry of entries) this.#release(entry);
	}
}

/** The answer of a configuration command: the session's configuration as plain JSON. */
function configurationResult(configuration: SessionConfiguration): Result {
	return JSON.parse(JSON.stringify(configuration)) as Result;
}

function denyAll(entry: ServerSession): void {
	for (const answer of entry.approvals.values()) answer(false);
	entry.approvals.clear();
}

function declineAll(entry: ServerSession): void {
	for (const answer of entry.consents.values()) answer("declined");
	entry.consents.clear();
}
