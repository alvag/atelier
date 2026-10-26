import { describe, expect, it } from "vitest";
import {
	decodeClientMessage,
	decodeServerMessage,
	encodeMessage,
	LineSplitter,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "../src/protocol/index.ts";

describe("LineSplitter", () => {
	it("returns complete lines and keeps the rest for later", () => {
		const splitter = new LineSplitter();
		expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
		expect(splitter.push(":2}\n\n")).toEqual(['{"b":2}']);
		expect(splitter.flush()).toEqual([]);
	});

	it("drops a trailing \\r and skips blank lines", () => {
		const splitter = new LineSplitter();
		expect(splitter.push("one\r\n\r\ntwo\r\n")).toEqual(["one", "two"]);
	});

	it("only splits on \\n, never on other line separators", () => {
		const splitter = new LineSplitter();
		expect(splitter.push('{"text":"a\u2028b"}\n')).toEqual(['{"text":"a\u2028b"}']);
	});

	it("flushes a last line without newline", () => {
		const splitter = new LineSplitter();
		expect(splitter.push("partial")).toEqual([]);
		expect(splitter.flush()).toEqual(["partial"]);
		expect(splitter.flush()).toEqual([]);
	});
});

describe("encodeMessage", () => {
	it("writes one JSON object per line", () => {
		const line = encodeMessage({ type: "hello", protocol: PROTOCOL_VERSION, core: "0.0.0" });
		expect(line).toBe('{"type":"hello","protocol":6,"core":"0.0.0"}\n');
	});

	it("escapes newlines inside strings, so a message is always one line", () => {
		const line = encodeMessage({ type: "protocol_error", message: "a\nb" });
		expect(line.indexOf("\n")).toBe(line.length - 1);
	});
});

describe("decodeClientMessage", () => {
	it.each([
		[{ type: "command", id: "c1", command: "session.start", cwd: "/w" }],
		[{ type: "command", id: "c2", command: "session.start", cwd: "/w", model: "sonnet", autoApprove: true }],
		[{ type: "command", id: "c3", command: "session.send", sessionId: "s1", prompt: "hi" }],
		[{ type: "command", id: "c4", command: "session.interrupt", sessionId: "s1" }],
		[{ type: "command", id: "c5", command: "session.approve", sessionId: "s1", callId: "k", approved: false }],
		[{ type: "command", id: "c6", command: "session.close", sessionId: "s1" }],
		[{ type: "command", id: "c7", command: "shutdown" }],
		[{ type: "command", id: "c8", command: "session.start", cwd: "/w", review: false }],
		[{ type: "command", id: "c9", command: "session.review", sessionId: "s1" }],
		[{ type: "command", id: "m1", command: "session.start", cwd: "/w", mode: "auto" }],
		[{ type: "command", id: "m2", command: "session.set_mode", sessionId: "s1", mode: "yolo" }],
		[
			{
				type: "command",
				id: "c10",
				command: "session.review_consent",
				sessionId: "s1",
				reviewId: "r1",
				answer: "granted",
			},
		],
		[
			{
				type: "command",
				id: "c11",
				command: "session.review_consent",
				sessionId: "s1",
				reviewId: "r1",
				answer: "declined",
			},
		],
	])("accepts %j", (message) => {
		expect(decodeClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
	});

	it.each([
		[{ command: "session.start", cwd: "/w", mode: "strict" }],
		[{ command: "session.set_mode", sessionId: "s1", mode: "strict" }],
		[{ command: "session.set_mode", sessionId: "s1" }],
	])("rejects %j, keeping its id", (command) => {
		const result = decodeClientMessage(JSON.stringify({ type: "command", id: "m3", ...command }));
		expect(result).toMatchObject({ ok: false, id: "m3" });
	});

	it("rejects invalid JSON without an id", () => {
		expect(decodeClientMessage("{not json")).toEqual({ ok: false, message: "Invalid JSON." });
	});

	it("keeps the id of an invalid command so it can be answered", () => {
		const result = decodeClientMessage(JSON.stringify({ type: "command", id: "c9", command: "session.send" }));
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ id: "c9" });
		expect(result.ok === false && result.message).toMatch(/^Invalid command:/);
	});

	it("rejects an unknown command, keeping its id", () => {
		expect(decodeClientMessage(JSON.stringify({ type: "command", id: "c1", command: "explode" }))).toMatchObject({
			ok: false,
			id: "c1",
		});
	});

	it("rejects messages that are not commands", () => {
		expect(decodeClientMessage(JSON.stringify({ type: "hello" }))).toMatchObject({ ok: false });
		expect(decodeClientMessage("[1,2]")).toMatchObject({ ok: false });
		expect(decodeClientMessage('"text"')).toMatchObject({ ok: false });
	});

	it("rejects a review answer that is neither granted nor declined, or lacks the review id", () => {
		const consent = { type: "command", id: "c", command: "session.review_consent", sessionId: "s", reviewId: "r" };
		expect(decodeClientMessage(JSON.stringify({ ...consent, answer: "maybe" })).ok).toBe(false);
		expect(decodeClientMessage(JSON.stringify({ ...consent, reviewId: "", answer: "granted" })).ok).toBe(false);
		expect(
			decodeClientMessage(
				JSON.stringify({ type: "command", id: "c", command: "session.start", cwd: "/w", review: "no" }),
			).ok,
		).toBe(false);
	});

	it("rejects empty ids and empty prompts", () => {
		expect(decodeClientMessage(JSON.stringify({ type: "command", id: "", command: "shutdown" })).ok).toBe(false);
		expect(
			decodeClientMessage(
				JSON.stringify({ type: "command", id: "c", command: "session.send", sessionId: "s", prompt: "" }),
			).ok,
		).toBe(false);
	});
});

describe("decodeServerMessage", () => {
	const messages: ServerMessage[] = [
		{ type: "hello", protocol: 6, core: "0.0.0" },
		{ type: "response", id: "c1", ok: true, result: { sessionId: "s1" } },
		{ type: "response", id: "c2", ok: false, error: { code: "unknown_session", message: "No session s9." } },
		{
			type: "event",
			sessionId: "s1",
			event: { type: "text_delta", text: "hi", seq: 1, turnId: "t1" },
		},
		{ type: "protocol_error", message: "Invalid JSON." },
	];

	it.each(messages)("round-trips %j", (message) => {
		expect(decodeServerMessage(encodeMessage(message).trimEnd())).toEqual(message);
	});

	it("never throws: unreadable or unknown lines come back as unknown", () => {
		for (const line of ["{oops", "42", '{"type":"later"}', '{"type":"response","id":"c1"}', '{"type":"event"}']) {
			expect(decodeServerMessage(line)).toEqual({ type: "unknown", line });
		}
	});
});
