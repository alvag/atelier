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
		[{ type: "command", id: "h1", command: "session.set_model", sessionId: "s1", model: "sonnet" }],
		[{ type: "command", id: "h2", command: "session.set_effort", sessionId: "s1", effort: "xhigh" }],
		[{ type: "command", id: "h3", command: "session.set_effort", sessionId: "s1", effort: "off" }],
		[{ type: "command", id: "h6", command: "session.set_profile", sessionId: "s1", profile: "cheap" }],
		[{ type: "command", id: "b1", command: "session.set_backend", sessionId: "s1", backend: "anthropic-api" }],
		[
			{
				type: "command",
				id: "b2",
				command: "session.set_backend",
				sessionId: "s1",
				backend: "claude-code",
				model: "opus",
			},
		],
		[{ type: "command", id: "k1", command: "session.start", cwd: "/w", noSession: true }],
		[{ type: "command", id: "k2", command: "sessions.list", cwd: "/w" }],
		[{ type: "command", id: "k3", command: "session.resume", sessionId: "7f1c-AB_9", cwd: "/w" }],
		[{ type: "command", id: "k4", command: "session.rename", sessionId: "abc", cwd: "/w", name: "the fix" }],
		[{ type: "command", id: "k5", command: "session.delete", sessionId: "abc", cwd: "/w" }],
		[{ type: "command", id: "h4", command: "options.list" }],
		[{ type: "command", id: "h5", command: "options.list", cwd: "/w" }],
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
		[
			{
				type: "command",
				id: "c12",
				command: "session.review_consent",
				sessionId: "s1",
				reviewId: "r1",
				answer: "granted_for_session",
			},
		],
	])("accepts %j", (message) => {
		expect(decodeClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
	});

	it.each([
		[{ command: "session.start", cwd: "/w", mode: "strict" }],
		[{ command: "session.set_mode", sessionId: "s1", mode: "strict" }],
		[{ command: "session.set_mode", sessionId: "s1" }],
		[{ command: "session.set_model", sessionId: "s1" }],
		[{ command: "session.set_model", sessionId: "s1", model: "" }],
		[{ command: "session.set_model", model: "sonnet" }],
		[{ command: "session.set_effort", sessionId: "s1", effort: "turbo" }],
		[{ command: "session.set_effort", sessionId: "s1" }],
		[{ command: "session.set_profile", sessionId: "s1" }],
		[{ command: "session.set_profile", sessionId: "s1", profile: "" }],
		[{ command: "session.set_profile", profile: "cheap" }],
		[{ command: "session.set_backend", sessionId: "s1", backend: "gemini" }],
		[{ command: "session.set_backend", sessionId: "s1" }],
		[{ command: "session.set_backend", sessionId: "s1", backend: "claude-code", model: "" }],
		[{ command: "session.set_backend", backend: "claude-code" }],
		[{ command: "options.list", cwd: "" }],
		[{ command: "session.start", cwd: "/w", noSession: "yes" }],
		[{ command: "sessions.list" }],
		[{ command: "sessions.list", cwd: "" }],
		[{ command: "session.resume", cwd: "/w" }],
		[{ command: "session.resume", sessionId: "abc" }],
		[{ command: "session.resume", sessionId: "../../etc/passwd", cwd: "/w" }],
		[{ command: "session.resume", sessionId: "a/b", cwd: "/w" }],
		[{ command: "session.delete", sessionId: "", cwd: "/w" }],
		[{ command: "session.delete", sessionId: "..", cwd: "/w" }],
		[{ command: "session.rename", sessionId: "abc", cwd: "/w" }],
		[{ command: "session.rename", sessionId: "abc", cwd: "/w", name: "  " }],
		[{ command: "session.rename", sessionId: "abc", cwd: "/w", name: "x".repeat(201) }],
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
