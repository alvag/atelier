import { unlinkSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResumeState } from "../backend.ts";
import { type AtelierEvent, describeError } from "../events.ts";
import type { ShellResult } from "../shell-result.ts";
import type { ThinkingLevel } from "../thinking.ts";
import { digest, type SavedConfig, type SavedEntry, SessionFileError, type SessionHeader } from "./format.ts";

/** Sessions hold prompts, tool outputs and histories: their folders and files are for their owner alone. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** A lock file nobody wrote a pid into is taken over once it is this old. */
const EMPTY_LOCK_MS = 10_000;

/** The lock files this process holds, so that a process that exits without closing its sessions lets them go. */
const held = new Set<string>();
process.on("exit", () => {
	for (const path of held) {
		try {
			unlinkSync(path);
		} catch {}
	}
});

export interface RecorderOptions {
	path: string;
	/** A session that has no file yet: its header is written with the first entry, never over an existing file. */
	header?: SessionHeader;
	/** The folder all sessions live under, made private along with the session's own folder. */
	root?: string;
	/** What the file already holds of the backend's state, so the next one is written as what follows it. */
	known?: ResumeState;
	/** What the file last said the model was told about yolo, so the next state writes it only when it changes. */
	knownYoloTold?: boolean | null;
}

/**
 * Appends one session's entries to its file, in the order they were recorded. A line is one write, so a crash cuts at
 * most the last line, which readers ignore; the next writer of a file cut short removes that line first. A write that
 * fails never reaches the session: the first failure waits in `takeFailure`.
 */
export class SessionRecorder {
	readonly path: string;
	#header: SessionHeader | undefined;
	readonly #root: string | undefined;
	#locked = false;
	#queue: Promise<void> = Promise.resolve();
	#prepared = false;
	#failure: string | undefined;
	/** The main agent's text of the segment running now, until an event of another kind or origin ends it. */
	#segment: { turnId: string; text: string; agent?: string; parentCallId?: string } | undefined;
	/** The messages the file holds of an `anthropic-api` history, by digest. */
	#messages: string[];
	#sessionId: string | undefined;
	/** What the file says the model was last told about yolo; undefined until it says it, so the first state does. */
	#yoloTold: boolean | null | undefined;
	/** The turn of the last prompt: a queued message that started it is already saved as that prompt. */
	#promptTurn: string | undefined;

	constructor(options: RecorderOptions) {
		this.path = options.path;
		this.#header = options.header;
		this.#root = options.root;
		const known = options.known;
		this.#messages = known !== undefined && "messages" in known ? known.messages.map(digest) : [];
		this.#sessionId = known !== undefined && "sessionId" in known ? known.sessionId : undefined;
		this.#yoloTold = options.knownYoloTold;
	}

	get id(): string {
		return (
			this.path
				.split(/[/\\]/)
				.at(-1)
				?.replace(/\.jsonl$/, "") ?? ""
		);
	}

	config(config: SavedConfig): void {
		this.#append({ type: "config", ...config });
	}

	/** The shell-carrying turn still needing a thinking acceptance marker. */
	#shellThinkingTurn: string | undefined;

	prompt(turnId: string, text: string, imageCount = 0, shellResults: readonly string[] = []): void {
		this.#promptTurn = turnId;
		this.#shellThinkingTurn = shellResults.length > 0 ? turnId : undefined;
		this.#append({
			type: "prompt",
			turnId,
			text,
			...(imageCount > 0 ? { imageCount } : {}),
			...(shellResults.length > 0 ? { shellResults: [...shellResults] } : {}),
		});
	}

	/** A finished shell command the user ran, saved when it is reported. */
	shellResult(result: ShellResult): Promise<void> {
		this.#endSegment();
		const written = this.#queue.then(() => this.#write({ type: "shell_result", result }));
		// A failed write is the caller's to hear of, and the entries after it still try to be written.
		this.#queue = written.catch(() => {});
		return written;
	}

	/** Keeps what a client needs to show the turn again: thinking is dropped and the text deltas of a segment become one entry. */
	event(event: AtelierEvent): void {
		// Only a shell-carrying prompt needs an empty thinking delta to persist that the backend took it.
		if (event.type === "thinking_delta") {
			if (this.#shellThinkingTurn === undefined || event.turnId !== this.#shellThinkingTurn) return;
			this.#shellThinkingTurn = undefined;
			this.#append({ type: "event", event: { ...event, text: "" } });
			return;
		}
		// What is still queued is not the conversation's yet.
		if (event.type === "queue_update") return;
		// A queued message that starts a turn is its first event, and that turn's prompt already holds it.
		if (event.type === "queued_message" && event.seq === 1 && event.turnId === this.#promptTurn) return;
		if (event.type === "text_delta") {
			const segment = this.#segment;
			if (
				segment &&
				segment.turnId === event.turnId &&
				segment.agent === event.agent &&
				segment.parentCallId === event.parentCallId
			)
				segment.text += event.text;
			else {
				this.#endSegment();
				this.#segment = {
					turnId: event.turnId,
					text: event.text,
					...(event.agent === undefined ? {} : { agent: event.agent }),
					...(event.parentCallId === undefined ? {} : { parentCallId: event.parentCallId }),
				};
			}
			return;
		}
		if (event.type === "session_configured") {
			this.config({
				backend: event.backend as SavedConfig["backend"],
				...(event.model === undefined ? {} : { model: event.model }),
				...(event.thinking === undefined ? {} : { thinking: event.thinking as ThinkingLevel }),
				mode: event.permissionMode,
				...(event.profile?.name === undefined ? {} : { profile: event.profile.name }),
			});
			return;
		}
		this.#append({ type: "event", event });
	}

	/**
	 * The backend's state after a turn. A history is written as what was added to the ones already in the file, or
	 * whole when it no longer starts with them (a compaction replaced its beginning): the file grows with the
	 * conversation instead of with its square. `yoloTold`, what the model was last told about yolo, goes with it when
	 * it changed, and makes a state worth writing by itself.
	 */
	state(backend: string, state: ResumeState | undefined, yoloTold?: boolean | null): void {
		if (state === undefined) return;
		this.#endSegment();
		// What the file holds moves forward only once the write succeeded, so a failed one is written again, in full.
		this.#enqueue(async () => {
			const changed = yoloTold !== undefined && yoloTold !== this.#yoloTold;
			const told = changed ? { yoloTold } : {};
			if ("sessionId" in state) {
				if (state.sessionId === this.#sessionId && !changed) return;
				await this.#write({ type: "state", backend, sessionId: state.sessionId, ...told });
				this.#sessionId = state.sessionId;
				if (changed) this.#yoloTold = yoloTold;
				return;
			}
			const digests = state.messages.map(digest);
			const kept = this.#messages;
			const appended = digests.length >= kept.length && kept.every((one, index) => one === digests[index]);
			if (appended && digests.length === kept.length && !changed) return;
			await this.#write({
				type: "state",
				backend,
				messages: appended ? state.messages.slice(kept.length) : state.messages,
				replace: !appended,
				...told,
			});
			this.#messages = digests;
			if (changed) this.#yoloTold = yoloTold;
		});
	}

	name(name: string): void {
		this.#append({ type: "name", name });
	}

	/** Resolves once everything recorded so far is in the file. */
	async flush(): Promise<void> {
		this.#endSegment();
		await this.#queue;
	}

	/**
	 * Takes the file for this process: `<file>.lock` is created exclusively with the pid in it, so a second process
	 * (or recorder) that wants the file is refused with `session_in_use`. The lock of a process that is gone is taken
	 * over. It is let go by `release` and when the process exits. Failing to make the lock for any other reason does
	 * not stop the session: it runs, and the failure waits in `takeFailure` like any write that failed.
	 */
	async lock(): Promise<void> {
		if (this.#locked) return;
		const lockPath = `${this.path}.lock`;
		try {
			await this.#secure();
			for (let attempt = 0; ; attempt++) {
				try {
					await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: FILE_MODE });
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const holder = await liveHolder(lockPath);
					// Taking over is tried once: a second EEXIST means another process won the race.
					if (holder !== undefined || attempt > 0) {
						const pid = holder?.pid === undefined ? "" : ` (pid ${holder.pid})`;
						throw new SessionFileError(
							"session_in_use",
							`Session ${this.id} is already in use by another Atelier process${pid}.`,
						);
					}
					await rm(lockPath, { force: true });
				}
			}
		} catch (error) {
			if (error instanceof SessionFileError) throw error;
			this.#failure ??= describeError(error);
			return;
		}
		this.#locked = true;
		held.add(lockPath);
	}

	/** Waits for what was recorded to be in the file, then lets the file go to the next writer. */
	async release(): Promise<void> {
		await this.flush();
		if (!this.#locked) return;
		this.#locked = false;
		const lockPath = `${this.path}.lock`;
		held.delete(lockPath);
		await rm(lockPath, { force: true });
	}

	/** The reason a write failed, once; the entries after it still try to be written. */
	takeFailure(): string | undefined {
		const failure = this.#failure;
		this.#failure = undefined;
		return failure;
	}

	#endSegment(): void {
		const segment = this.#segment;
		this.#segment = undefined;
		if (segment) this.#append({ type: "text", ...segment });
	}

	#append(entry: SavedEntry): void {
		// A text segment ends where the next entry begins.
		if (entry.type !== "text") this.#endSegment();
		this.#enqueue(() => this.#write(entry));
	}

	/** Runs a write after the ones before it; its failure is kept, and never stops the ones after it. */
	#enqueue(task: () => Promise<void>): void {
		this.#queue = this.#queue.then(async () => {
			try {
				await task();
			} catch (error) {
				this.#failure ??= describeError(error);
			}
		});
	}

	async #write(entry: SavedEntry): Promise<void> {
		await this.#prepare();
		await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
	}

	/** Creates the file with its header, or makes an existing file end at a line boundary. */
	async #prepare(): Promise<void> {
		if (this.#prepared) return;
		await this.#secure();
		if (this.#header) await writeFile(this.path, `${JSON.stringify(this.#header)}\n`, { flag: "wx", mode: FILE_MODE });
		else {
			await endAtLine(this.path);
			await tighten(this.path, FILE_MODE);
		}

		this.#prepared = true;
		this.#header = undefined;
	}

	/** Makes the session's folder, and the root above it, private: a looser one that exists is tightened. */
	async #secure(): Promise<void> {
		const folder = dirname(this.path);
		await mkdir(folder, { recursive: true, mode: DIRECTORY_MODE });
		if (this.#root !== undefined) await tighten(this.#root, DIRECTORY_MODE);
		await tighten(folder, DIRECTORY_MODE);
	}
}

/** Takes away the access of group and others to a folder or file that has any. */
async function tighten(path: string, mode: number): Promise<void> {
	if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, mode);
}

/** Who holds a lock file: undefined when nobody does (its process is gone, or it was never filled in and is old). */
async function liveHolder(path: string): Promise<{ pid?: number } | undefined> {
	let text: string;
	let modified: number;
	try {
		[text, modified] = await Promise.all([readFile(path, "utf8"), stat(path).then((s) => s.mtimeMs)]);
	} catch {
		return undefined;
	}
	const pid = Number.parseInt(text, 10);
	if (Number.isNaN(pid)) return Date.now() - modified > EMPTY_LOCK_MS ? undefined : {};
	try {
		process.kill(pid, 0);
		return { pid };
	} catch (error) {
		// Not allowed to signal it means it exists.
		return (error as NodeJS.ErrnoException).code === "EPERM" ? { pid } : undefined;
	}
}

/** A file whose last line was cut by a crash loses that line; one that only lacks its newline gets it. */
async function endAtLine(path: string): Promise<void> {
	const text = await readFile(path, "utf8");
	if (text === "" || text.endsWith("\n")) return;
	const whole = text.slice(0, text.lastIndexOf("\n") + 1);
	try {
		JSON.parse(text.slice(whole.length));
		await appendFile(path, "\n");
	} catch {
		await truncate(path, Buffer.byteLength(whole));
	}
}
