import { z } from "zod";
import type { ClientMessage, ServerMessage } from "./types.ts";

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

const commandSchema = z.discriminatedUnion("command", [
	z.object({
		command: z.literal("session.start"),
		cwd: z.string().min(1),
		model: z.string().min(1).optional(),
		autoApprove: z.boolean().optional(),
	}),
	z.object({ command: z.literal("session.send"), sessionId, prompt: z.string().min(1) }),
	z.object({ command: z.literal("session.interrupt"), sessionId }),
	z.object({ command: z.literal("session.approve"), sessionId, callId: z.string().min(1), approved: z.boolean() }),
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
