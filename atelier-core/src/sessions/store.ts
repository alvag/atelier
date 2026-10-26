import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ResumeState } from "../backend.ts";
import { isSavedSessionId, MAX_SESSION_NAME_CHARS } from "../protocol/types.ts";
import {
	folderKey,
	parseSessionFile,
	type Replayed,
	replay,
	type SavedConfig,
	type SavedEntry,
	SESSION_KIND,
	SESSION_VERSION,
	SessionFileError,
	type SessionHeader,
} from "./format.ts";
import { SessionRecorder } from "./recorder.ts";

/** The longest last prompt a listing carries. */
export const LAST_PROMPT_CHARS = 80;

/** One saved session as a listing shows it. */
export interface SavedSessionInfo {
	id: string;
	name?: string;
	createdAt: string;
	/** When the file was last written. */
	updatedAt: string;
	turns: number;
	/** The last prompt on one line, cut at 80 characters. */
	lastPrompt?: string;
	backend?: string;
	model?: string;
	/** False when the file cannot be resumed; `problem` says why. */
	resumable: boolean;
	problem?: string;
}

/** A session file read whole, ready to start a session from. */
export interface LoadedSession {
	header: SessionHeader;
	name?: string;
	config: SavedConfig;
	/** Absent for a session that never finished a turn: it starts empty with the saved configuration. */
	resume?: ResumeState;
	/** Everything the transcript shows again; the backend state is left out. */
	entries: SavedEntry[];
	turns: number;
}

/**
 * Sessions saved under `<home>/.atelier/sessions/<folder key>/<id>.jsonl`. The home is always given, never looked up,
 * so tests and servers choose where sessions live. Nothing here rewrites a session's file: a rename appends.
 */
export class SessionStore {
	readonly #root: string;

	constructor(home: string) {
		this.#root = join(home, ".atelier", "sessions");
	}

	folder(cwd: string): string {
		return join(this.#root, folderKey(cwd));
	}

	/** The file of the saved session `id` of the folder `cwd`. */
	path(cwd: string, id: string): string {
		if (!isSavedSessionId(id)) throw new SessionFileError("not_found", `No saved session "${id}".`);
		return join(this.folder(cwd), `${id}.jsonl`);
	}

	/** A recorder for a new session; the file appears with its first entry. */
	create(cwd: string, options: { name?: string } = {}): SessionRecorder {
		const id = randomUUID();
		return new SessionRecorder({
			path: this.path(cwd, id),
			root: this.#root,
			header: {
				kind: SESSION_KIND,
				version: SESSION_VERSION,
				id,
				cwd: resolve(cwd),
				createdAt: new Date().toISOString(),
				...(options.name === undefined ? {} : { name: options.name }),
			},
		});
	}

	/** A recorder that goes on with a loaded session's file. */
	continue(cwd: string, loaded: LoadedSession): SessionRecorder {
		return new SessionRecorder({
			path: this.path(cwd, loaded.header.id),
			root: this.#root,
			...(loaded.resume === undefined ? {} : { known: loaded.resume }),
		});
	}

	/** The folder's sessions, newest first; a file that cannot be resumed is listed with the reason. */
	async list(cwd: string): Promise<SavedSessionInfo[]> {
		const folder = this.folder(cwd);
		let names: string[];
		try {
			names = await readdir(folder);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const found = await Promise.all(
			names
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => this.#describe(cwd, name.slice(0, -".jsonl".length))),
		);
		return found
			.filter((info) => info !== undefined)
			.sort(
				(a, b) =>
					b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
			);
	}

	async #describe(cwd: string, id: string): Promise<SavedSessionInfo | undefined> {
		const path = join(this.folder(cwd), `${id}.jsonl`);
		let text: string;
		let updatedAt: string;
		try {
			[text, updatedAt] = await Promise.all([readFile(path, "utf8"), stat(path).then((s) => s.mtime.toISOString())]);
		} catch {
			return undefined;
		}
		const parsed = parseSessionFile(text, id);
		// The key can be shared by another folder; the header says whose the file is, and an unreadable one says nothing.
		if (!parsed.ok && parsed.cwd !== resolve(cwd)) return undefined;
		if (!parsed.ok)
			return {
				id,
				createdAt: parsed.createdAt ?? updatedAt,
				updatedAt,
				turns: 0,
				resumable: false,
				problem: parsed.message,
			};
		if (parsed.header.cwd !== resolve(cwd)) return undefined;
		const replayed = replay(parsed.header, parsed.entries);
		return {
			id,
			...(replayed.name === undefined ? {} : { name: replayed.name }),
			createdAt: parsed.header.createdAt,
			updatedAt,
			turns: replayed.turns,
			...(replayed.lastPrompt === undefined ? {} : { lastPrompt: oneLine(replayed.lastPrompt) }),
			...(replayed.config === undefined ? {} : { backend: replayed.config.backend }),
			...(replayed.config?.model === undefined ? {} : { model: replayed.config.model }),
			resumable: replayed.config !== undefined,
			...(replayed.config === undefined ? { problem: "it records no configuration" } : {}),
		};
	}

	/** Reads a session to resume it; rejects with a `SessionFileError` when the file is missing, from a newer format or corrupt. */
	async load(cwd: string, id: string): Promise<LoadedSession> {
		const parsed = await this.#read(cwd, id);
		const replayed: Replayed = replay(parsed.header, parsed.entries);
		if (replayed.config === undefined)
			throw new SessionFileError("corrupt", `Saved session ${id} is corrupt: it records no configuration.`);
		return {
			header: parsed.header,
			...(replayed.name === undefined ? {} : { name: replayed.name }),
			config: replayed.config,
			...(replayed.resume === undefined ? {} : { resume: replayed.resume }),
			entries: parsed.entries.filter((entry) => entry.type !== "state"),
			turns: replayed.turns,
		};
	}

	async #read(cwd: string, id: string) {
		const path = this.path(cwd, id);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(id, cwd);
			throw new SessionFileError("corrupt", `Saved session ${id} cannot be read: ${(error as Error).message}`);
		}
		const parsed = parseSessionFile(text, id);
		if (!parsed.ok) {
			if (parsed.code === "unsupported_version")
				throw new SessionFileError("unsupported_version", `Saved session ${id} cannot be resumed: ${parsed.message}.`);
			throw new SessionFileError("corrupt", `Saved session ${id} is corrupt: ${parsed.message}.`);
		}
		if (parsed.header.cwd !== resolve(cwd)) throw notFound(id, cwd);
		return parsed;
	}

	/** Gives the session a name by appending it to its file. Only a session this Atelier can read is renamed. */
	async rename(cwd: string, id: string, name: string): Promise<void> {
		const trimmed = name.trim();
		if (trimmed === "" || trimmed.length > MAX_SESSION_NAME_CHARS)
			throw new SessionFileError("invalid_name", `A name has 1 to ${MAX_SESSION_NAME_CHARS} characters.`);
		await this.#read(cwd, id);
		const recorder = new SessionRecorder({ path: this.path(cwd, id), root: this.#root });
		recorder.name(trimmed);
		await recorder.flush();
		const failure = recorder.takeFailure();
		if (failure !== undefined) throw new SessionFileError("write_failed", `Could not rename session ${id}: ${failure}`);
	}

	/** Removes a session's file, whatever state it is in. */
	async delete(cwd: string, id: string): Promise<void> {
		const path = this.path(cwd, id);
		try {
			await stat(path);
		} catch {
			throw notFound(id, cwd);
		}
		// A file in another folder's key that only shares the name is not this folder's, nor is one whose owner is unknown.
		const parsed = parseSessionFile(await readFile(path, "utf8"), id);
		if ((parsed.ok ? parsed.header.cwd : parsed.cwd) !== resolve(cwd)) throw notFound(id, cwd);
		await rm(path, { force: true });
	}
}

function notFound(id: string, cwd: string): SessionFileError {
	return new SessionFileError("not_found", `No saved session "${id}" for ${resolve(cwd)}.`);
}

/** One line of at most 80 characters: whitespace runs become one space, a longer prompt ends in an ellipsis. */
function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > LAST_PROMPT_CHARS ? `${line.slice(0, LAST_PROMPT_CHARS - 1)}…` : line;
}
