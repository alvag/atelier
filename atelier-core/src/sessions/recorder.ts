import { appendFile, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResumeState } from "../backend.ts";
import { type AtelierEvent, describeError } from "../events.ts";
import type { ThinkingLevel } from "../thinking.ts";
import { digest, type SavedConfig, type SavedEntry, type SessionHeader } from "./format.ts";

export interface RecorderOptions {
	path: string;
	/** A session that has no file yet: its header is written with the first entry, never over an existing file. */
	header?: SessionHeader;
	/** What the file already holds of the backend's state, so the next one is written as what follows it. */
	known?: ResumeState;
}

/**
 * Appends one session's entries to its file, in the order they were recorded. A line is one write, so a crash cuts at
 * most the last line, which readers ignore; the next writer of a file cut short removes that line first. A write that
 * fails never reaches the session: the first failure waits in `takeFailure`.
 */
export class SessionRecorder {
	readonly path: string;
	#header: SessionHeader | undefined;
	#queue: Promise<void> = Promise.resolve();
	#prepared = false;
	#failure: string | undefined;
	/** The main agent's text of the segment running now, until an event of another kind or origin ends it. */
	#segment: { turnId: string; text: string; agent?: string; parentCallId?: string } | undefined;
	/** The messages the file holds of an `anthropic-api` history, by digest. */
	#messages: string[];
	#sessionId: string | undefined;

	constructor(options: RecorderOptions) {
		this.path = options.path;
		this.#header = options.header;
		const known = options.known;
		this.#messages = known !== undefined && "messages" in known ? known.messages.map(digest) : [];
		this.#sessionId = known !== undefined && "sessionId" in known ? known.sessionId : undefined;
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

	prompt(turnId: string, text: string): void {
		this.#append({ type: "prompt", turnId, text });
	}

	/** Keeps what a client needs to show the turn again: thinking is dropped and the text deltas of a segment become one entry. */
	event(event: AtelierEvent): void {
		if (event.type === "thinking_delta") return;
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
	 * conversation instead of with its square.
	 */
	state(backend: string, state: ResumeState | undefined): void {
		if (state === undefined) return;
		if ("sessionId" in state) {
			if (state.sessionId === this.#sessionId) return;
			this.#sessionId = state.sessionId;
			this.#append({ type: "state", backend, sessionId: state.sessionId });
			return;
		}
		const digests = state.messages.map(digest);
		const kept = this.#messages;
		const appended = digests.length >= kept.length && kept.every((one, index) => one === digests[index]);
		if (appended && digests.length === kept.length) return;
		this.#messages = digests;
		this.#append({
			type: "state",
			backend,
			messages: appended ? state.messages.slice(kept.length) : state.messages,
			replace: !appended,
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
		const line = `${JSON.stringify(entry)}\n`;
		this.#queue = this.#queue.then(async () => {
			try {
				await this.#prepare();
				await appendFile(this.path, line);
			} catch (error) {
				this.#failure ??= describeError(error);
			}
		});
	}

	/** Creates the file with its header, or makes an existing file end at a line boundary. */
	async #prepare(): Promise<void> {
		if (this.#prepared) return;
		await mkdir(dirname(this.path), { recursive: true });
		if (this.#header) await writeFile(this.path, `${JSON.stringify(this.#header)}\n`, { flag: "wx" });
		else await endAtLine(this.path);

		this.#prepared = true;
		this.#header = undefined;
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
