import { z } from "zod";
import { PERMISSION_MODES } from "../modes.ts";
import { THINKING_LEVELS } from "../thinking.ts";
import {
	BACKEND_NAMES,
	type ClientMessage,
	isSavedSessionId,
	MAX_COMPACT_INSTRUCTIONS_BYTES,
	MAX_SESSION_NAME_CHARS,
	type ServerMessage,
} from "./types.ts";

/**
 * Splits a stream of text into lines on "\n" only (other Unicode line
 * separators may appear inside JSON strings), drops a trailing "\r" and
 * skips blank lines.
 */
export class LineSplitter {
	#pending = "";

	push(chunk: string): string[] {
		const parts = (this.#pending + chunk).split("\n");
		this.#pending = parts.pop() ?? "";
		return parts.map(stripCarriageReturn).filter((line) => line !== "");
	}

	/** Returns the last line when the stream ended without a newline. */
	flush(): string[] {
		const line = stripCarriageReturn(this.#pending);
		this.#pending = "";
		return line === "" ? [] : [line];
	}
}

function stripCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** One message per line: JSON.stringify never emits a raw newline. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
	return `${JSON.stringify(message)}\n`;
}

const id = z.string().min(1);
const sessionId = z.string().min(1);
/** A saved session's id names a file: only the characters of the ids the core makes. */
const savedId = z
	.string()
	.refine(isSavedSessionId, { message: "must be a saved session id (letters, digits, - and _)" });
const savedName = z.string().refine((name) => name.trim() !== "" && name.trim().length <= MAX_SESSION_NAME_CHARS, {
	message: `must have 1 to ${MAX_SESSION_NAME_CHARS} characters`,
});

const commandSchema = z.discriminatedUnion("command", [
	z.object({
		command: z.literal("session.start"),
		cwd: z.string().min(1),
		model: z.string().min(1).optional(),
		autoApprove: z.boolean().optional(),
		mode: z.enum(PERMISSION_MODES).optional(),
		backend: z.enum(BACKEND_NAMES).optional(),
		review: z.boolean().optional(),
		noSandbox: z.boolean().optional(),
		profile: z.string().min(1).optional(),
		noSession: z.boolean().optional(),
	}),
	z.object({ command: z.literal("profiles.list"), cwd: z.string().min(1).optional() }),
	z.object({ command: z.literal("session.send"), sessionId, prompt: z.string().min(1) }),
	z.object({ command: z.literal("session.interrupt"), sessionId }),
	z.object({ command: z.literal("session.approve"), sessionId, callId: z.string().min(1), approved: z.boolean() }),
	z.object({ command: z.literal("session.review"), sessionId, ref: z.string().min(1).optional() }),
	z.object({
		command: z.literal("session.review_consent"),
		sessionId,
		reviewId: z.string().min(1),
		answer: z.enum(["granted", "declined"]),
	}),
	z.object({ command: z.literal("session.undo_correction"), sessionId, reviewId: z.string().min(1).optional() }),
	z.object({
		command: z.literal("session.compact"),
		sessionId,
		instructions: z
			.string()
			.refine((text) => new TextEncoder().encode(text).length <= MAX_COMPACT_INSTRUCTIONS_BYTES, {
				message: `instructions must be at most ${MAX_COMPACT_INSTRUCTIONS_BYTES} bytes`,
			})
			.optional(),
	}),
	z.object({ command: z.literal("session.set_mode"), sessionId, mode: z.enum(PERMISSION_MODES) }),
	z.object({ command: z.literal("session.set_model"), sessionId, model: z.string().min(1) }),
	z.object({ command: z.literal("session.set_effort"), sessionId, effort: z.enum(THINKING_LEVELS) }),
	z.object({ command: z.literal("session.set_profile"), sessionId, profile: z.string().min(1) }),
	z.object({
		command: z.literal("session.set_backend"),
		sessionId,
		backend: z.enum(BACKEND_NAMES),
		model: z.string().min(1).optional(),
	}),
	z.object({ command: z.literal("options.list"), cwd: z.string().min(1).optional() }),
	z.object({ command: z.literal("sessions.list"), cwd: z.string().min(1) }),
	z.object({ command: z.literal("session.resume"), sessionId: savedId, cwd: z.string().min(1) }),
	z.object({ command: z.literal("session.rename"), sessionId: savedId, cwd: z.string().min(1), name: savedName }),
	z.object({ command: z.literal("session.delete"), sessionId: savedId, cwd: z.string().min(1) }),
	z.object({ command: z.literal("session.close"), sessionId }),
	z.object({ command: z.literal("shutdown") }),
]);

const clientMessageSchema = z.intersection(z.object({ type: z.literal("command"), id }), commandSchema);

export type DecodedClientMessage =
	| { ok: true; message: ClientMessage }
	/** `id` is present when the line was a command we can answer. */
	| { ok: false; id?: string; message: string };

export function decodeClientMessage(line: string): DecodedClientMessage {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { ok: false, message: "Invalid JSON." };
	}
	const parsed = clientMessageSchema.safeParse(value);
	if (parsed.success) return { ok: true, message: parsed.data as ClientMessage };
	const candidate = value as { type?: unknown; id?: unknown } | null;
	const answerable =
		typeof candidate === "object" &&
		candidate !== null &&
		candidate.type === "command" &&
		typeof candidate.id === "string" &&
		candidate.id !== "";
	const message = `Invalid command: ${z.prettifyError(parsed.error)}`;
	return answerable ? { ok: false, id: candidate.id as string, message } : { ok: false, message };
}

const serverMessageSchema = z.union([
	z.object({ type: z.literal("hello"), protocol: z.number(), core: z.string() }),
	z.object({ type: z.literal("response"), id, ok: z.literal(true), result: z.record(z.string(), z.json()) }),
	z.object({
		type: z.literal("response"),
		id,
		ok: z.literal(false),
		error: z.object({ code: z.string(), message: z.string() }),
	}),
	z.object({
		type: z.literal("event"),
		sessionId,
		event: z.looseObject({ type: z.string(), seq: z.number(), turnId: z.string() }),
	}),
	z.object({ type: z.literal("protocol_error"), message: z.string() }),
]);

/** Tolerant: never throws; anything it cannot read comes back as `unknown`. */
export function decodeServerMessage(line: string): ServerMessage | { type: "unknown"; line: string } {
	try {
		const parsed = serverMessageSchema.safeParse(JSON.parse(line));
		if (parsed.success) return parsed.data as ServerMessage;
	} catch {}
	return { type: "unknown", line };
}
