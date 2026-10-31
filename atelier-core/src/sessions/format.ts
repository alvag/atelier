import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ResumeState } from "../backend.ts";
import type { AtelierEvent, JsonValue } from "../events.ts";
import { MAX_PROMPT_IMAGES } from "../images.ts";
import { PERMISSION_MODES, type PermissionMode } from "../modes.ts";
import { BACKEND_NAMES, type BackendName } from "../protocol/types.ts";
import { type ShellResult, shellResultProblem } from "../shell-result.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../thinking.ts";

export const SESSION_KIND = "atelier.session";
export const SESSION_VERSION = 1;

/** The first line of a session file. */
export interface SessionHeader {
	kind: typeof SESSION_KIND;
	version: number;
	id: string;
	cwd: string;
	createdAt: string;
	name?: string;
}

/** What a session runs with: the configuration a resumed session starts from. */
export interface SavedConfig {
	backend: BackendName;
	model?: string;
	thinking?: ThinkingLevel;
	mode: PermissionMode;
	/** The profile's name; the profile is frozen again from the files as they are when the session resumes. */
	profile?: string;
}

/**
 * One line after the header. `text` is the main agent's text of a turn segment, merged from its deltas; `event` is
 * any other event as the clients got it; `state` is what the backend needs to resume: Claude Code's session id, or
 * the messages of `anthropic-api` (`replace`: they are the whole history, otherwise they follow the ones before).
 * A `prompt`'s optional `shellResults` are the execution ids of the user's shell results its turn carried to the
 * model; `shell_result` is a finished one as the client reported it (written when it arrives, even during a turn).
 * `response` says that a further backend response of the main agent starts in that turn (a step of the automatic
 * review: the risk declaration or a correction), so its text is not read as the earlier response's.
 * Files saved before these existed read as before, and an Atelier that does not know them skips the entry.
 * A state's optional `yoloTold` says whether the model was last told it runs in yolo (`null`: unknown, after a note
 * the backend failed on), written when that changes; a state without it keeps what an earlier one said.
 */
export type SavedEntry =
	| ({ type: "config" } & SavedConfig)
	| { type: "prompt"; turnId: string; text: string; imageCount?: number; shellResults?: string[] }
	| { type: "shell_result"; result: ShellResult }
	| { type: "response"; turnId: string }
	| { type: "text"; turnId: string; text: string; agent?: string; parentCallId?: string }
	| { type: "event"; event: AtelierEvent }
	| { type: "name"; name: string }
	| { type: "state"; backend: string; sessionId: string; yoloTold?: boolean | null }
	| { type: "state"; backend: string; messages: JsonValue[]; replace: boolean; yoloTold?: boolean | null };

/** A session file that cannot be listed, read or changed; `code` is what the protocol answers. */
export class SessionFileError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** The longest folder name kept in a key, in UTF-8 bytes: file names are limited in bytes (255), not characters. */
const MAX_KEY_BYTES = 200;
/**
 * The folder name of a working directory, as pi encodes it: the path without its leading separator, separators and
 * colons as `-`, between `--`. Two folders can share a key (`/a-b` and `/a/b`); each file says its own `cwd`, and
 * listing skips the ones that are not this folder's. A key too long for a file name ends in a hash of the path.
 */
export function folderKey(cwd: string): string {
	const path = resolve(cwd);
	const flat = path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	if (Buffer.byteLength(flat) <= MAX_KEY_BYTES) return `--${flat}--`;
	const hash = createHash("sha1").update(path).digest("hex").slice(0, 12);
	return `--${cutAtBytes(flat, MAX_KEY_BYTES)}-${hash}--`;
}

/** The longest start of `text` within `limit` bytes that ends on a whole character. */
function cutAtBytes(text: string, limit: number): string {
	let bytes = 0;
	let cut = "";
	for (const character of text) {
		bytes += Buffer.byteLength(character);
		if (bytes > limit) break;
		cut += character;
	}
	return cut;
}

export type ParsedFile =
	| { ok: true; header: SessionHeader; entries: SavedEntry[] }
	| {
			ok: false;
			code: "unsupported_version" | "corrupt";
			message: string;
			/** What the header still says when it could be read. */
			createdAt?: string;
			/** The working directory the header names, whatever else is wrong with the file. */
			cwd?: string;
	  };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a session file's text. A last line cut short by a crash (it has no newline and is not JSON) is ignored; an
 * unreadable line anywhere else is corruption. A version this code does not know is reported before the rest is read.
 */
export function parseSessionFile(text: string, id: string): ParsedFile {
	const lines = text.split("\n");
	const last = lines.pop() ?? "";
	// A last line that ends the text is whole; an unterminated one counts only when it parses.
	if (last !== "") lines.push(last);
	const owner = headerOwner(lines[0]);
	const values: unknown[] = [];
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		try {
			values.push(JSON.parse(line));
		} catch {
			const torn = index === lines.length - 1 && last !== "";
			if (torn) break;
			return { ok: false, code: "corrupt", message: `line ${index + 1} is not valid JSON`, ...owner };
		}
	}
	const [header, ...rest] = values;
	if (!isObject(header) || header.kind !== SESSION_KIND)
		return { ok: false, code: "corrupt", message: `the first line is not an ${SESSION_KIND} header` };
	const createdAt = typeof header.createdAt === "string" ? header.createdAt : undefined;
	if (header.version !== SESSION_VERSION)
		return {
			ok: false,
			code: "unsupported_version",
			message: `it was saved with session format version ${String(header.version)}, and this Atelier reads version ${SESSION_VERSION}`,
			...(createdAt === undefined ? {} : { createdAt }),
			...owner,
		};
	if (header.id !== id)
		return {
			ok: false,
			code: "corrupt",
			message: `the header names session ${String(header.id)}, not ${id}`,
			...owner,
		};
	if (typeof header.cwd !== "string" || createdAt === undefined || Number.isNaN(Date.parse(createdAt)))
		return { ok: false, code: "corrupt", message: "the header lacks a working directory or a creation time", ...owner };
	const entries: SavedEntry[] = [];
	for (const [index, value] of rest.entries()) {
		const problem = entryProblem(value);
		if (problem !== undefined)
			return { ok: false, code: "corrupt", message: `entry ${index + 2}: ${problem}`, ...owner };
		// Types a later Atelier adds inside this version are skipped, not fatal.
		if (KNOWN_ENTRIES.has((value as { type: string }).type)) entries.push(value as SavedEntry);
	}
	return {
		ok: true,
		header: {
			kind: SESSION_KIND,
			version: SESSION_VERSION,
			id,
			cwd: header.cwd,
			createdAt,
			...(typeof header.name === "string" ? { name: header.name } : {}),
		},
		entries,
	};
}

/** The working directory a file's first line names, when that line is a readable header of ours of any version. */
function headerOwner(line: string | undefined): { cwd?: string } {
	try {
		const header: unknown = JSON.parse(line ?? "");
		if (isObject(header) && header.kind === SESSION_KIND && typeof header.cwd === "string") return { cwd: header.cwd };
	} catch {}
	return {};
}

const KNOWN_ENTRIES: ReadonlySet<string> = new Set([
	"config",
	"prompt",
	"text",
	"event",
	"name",
	"state",
	"shell_result",
	"response",
]);

const isString = (value: unknown): value is string => typeof value === "string";
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
	list.some((item) => item === value);

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** Why an entry cannot be used, or undefined when it can (or when this version does not know its type). */
function entryProblem(value: unknown): string | undefined {
	if (!isObject(value) || !isString(value.type)) return "is not an object with a type";
	switch (value.type) {
		case "config":
			if (!isOneOf(BACKEND_NAMES, value.backend)) return "config names an unknown backend";
			if (!isOneOf(PERMISSION_MODES, value.mode)) return "config names an unknown mode";
			if (value.thinking !== undefined && !isOneOf(THINKING_LEVELS, value.thinking))
				return "config names an unknown thinking level";
			if (value.model !== undefined && !isString(value.model)) return "config has a model that is not text";
			if (value.profile !== undefined && !isString(value.profile)) return "config has a profile that is not text";
			return undefined;
		case "prompt":
			if (
				value.imageCount !== undefined &&
				(typeof value.imageCount !== "number" ||
					!Number.isInteger(value.imageCount) ||
					value.imageCount < 0 ||
					value.imageCount > MAX_PROMPT_IMAGES)
			)
				return "prompt has an invalid image count";
			if (value.shellResults !== undefined && !isIdList(value.shellResults)) return "prompt has invalid shell results";
			return isString(value.turnId) && isString(value.text) ? undefined : "prompt lacks its turn or its text";
		case "shell_result": {
			const problem = shellResultProblem(value.result);
			return problem === undefined ? undefined : `shell_result: ${problem}`;
		}
		case "response":
			return isString(value.turnId) ? undefined : "response lacks its turn";
		case "text":
			return isString(value.turnId) && isString(value.text) ? undefined : "text lacks its turn or its text";
		case "event":
			return isObject(value.event) && isString(value.event.type) ? undefined : "event lacks its event";
		case "name":
			return isString(value.name) ? undefined : "name lacks its text";
		case "state":
			if (!isString(value.backend)) return "state lacks its backend";
			if (value.yoloTold !== undefined && value.yoloTold !== null && typeof value.yoloTold !== "boolean")
				return "state has a yoloTold that is not true, false or null";
			if (isString(value.sessionId)) return undefined;
			return Array.isArray(value.messages) && typeof value.replace === "boolean"
				? undefined
				: "state has neither a session id nor messages";
		default:
			return undefined;
	}
}

/** What the file says about the session now, from its entries. */
export interface Replayed {
	config?: SavedConfig;
	resume?: ResumeState;
	/** Whether the model was last told it runs in yolo (`null`: unknown); absent when no state says, as in a file saved before it was kept. */
	yoloTold?: boolean | null;
	name?: string;
	turns: number;
	lastPrompt?: string;
}

/**
 * The configuration to resume with and the backend state, replaying the entries in order. The state belongs to the
 * backend that wrote it, so the configuration is the last one for that backend: a backend change whose turn never
 * finished is not resumed.
 */
export function replay(header: SessionHeader, entries: readonly SavedEntry[]): Replayed {
	let name = header.name;
	let turns = 0;
	let lastPrompt: string | undefined;
	let yoloTold: boolean | null | undefined;
	let state: { backend: string; sessionId?: string; messages?: JsonValue[] } | undefined;
	const configs: SavedConfig[] = [];
	for (const entry of entries) {
		if (entry.type === "name") name = entry.name;
		else if (entry.type === "prompt") {
			turns++;
			lastPrompt = entry.text;
		} else if (entry.type === "config") {
			const { type: _type, ...config } = entry;
			configs.push(config);
		} else if (entry.type === "state") {
			if (entry.yoloTold !== undefined) yoloTold = entry.yoloTold;
			if ("sessionId" in entry) state = { backend: entry.backend, sessionId: entry.sessionId };
			else {
				const before = state?.backend === entry.backend ? (state.messages ?? []) : [];
				state = { backend: entry.backend, messages: entry.replace ? entry.messages : [...before, ...entry.messages] };
			}
		}
	}
	const config =
		state === undefined ? configs.at(-1) : (configs.findLast((c) => c.backend === state.backend) ?? configs.at(-1));
	const resume: ResumeState | undefined =
		state === undefined
			? undefined
			: state.sessionId !== undefined
				? { sessionId: state.sessionId }
				: { messages: state.messages ?? [] };
	return {
		...(config === undefined ? {} : { config }),
		...(resume === undefined ? {} : { resume }),
		...(yoloTold === undefined ? {} : { yoloTold }),
		...(name === undefined ? {} : { name }),
		turns,
		...(lastPrompt === undefined ? {} : { lastPrompt }),
	};
}

/** A short digest of a message, to tell later which ones the file already holds. */
export function digest(message: JsonValue): string {
	return createHash("sha1").update(JSON.stringify(message)).digest("hex");
}

/** The shell results a saved session still owes its model, and every execution id it has seen. */
export interface ShellHistory {
	/** Every id of a result in the file, excluded ones too: a repeated one is ignored. */
	seen: string[];
	/** Results for the model that no accepted prompt carried yet, in the order they arrived. */
	pending: ShellResult[];
}

/**
 * Replays the shell entries in order. A prompt took the results it lists when the backend accepted it, the same
 * criterion as a live turn: its turn has main text, thinking (the file keeps one empty delta), a tool call, or an end
 * other than an error or an interrupt.
 */
export function shellHistory(entries: readonly SavedEntry[]): ShellHistory {
	const arrived: ShellResult[] = [];
	const seen = new Set<string>();
	const taken = new Set<string>();
	let carried: { turnId: string; ids: readonly string[] } | undefined;
	for (const entry of entries) {
		if (entry.type === "shell_result") {
			if (seen.has(entry.result.executionId)) continue;
			seen.add(entry.result.executionId);
			if (!entry.result.excludeFromContext) arrived.push(entry.result);
		} else if (entry.type === "prompt") carried = { turnId: entry.turnId, ids: entry.shellResults ?? [] };
		else if (carried && acceptedFor(entry, carried.turnId)) {
			for (const id of carried.ids) taken.add(id);
			carried = undefined;
		}
	}
	return { seen: [...seen], pending: arrived.filter((result) => !taken.has(result.executionId)) };
}

/** Whether a saved entry shows that the backend took the prompt of `turnId`. */
function acceptedFor(entry: SavedEntry, turnId: string): boolean {
	if (entry.type === "text") return entry.turnId === turnId;
	if (entry.type !== "event" || entry.event.turnId !== turnId) return false;
	const event = entry.event;
	if (event.type === "turn_finished") return event.stopReason !== "error" && event.stopReason !== "interrupted";
	return event.type === "tool_call_started" || event.type === "thinking_delta";
}
