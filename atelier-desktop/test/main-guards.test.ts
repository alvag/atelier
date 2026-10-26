import { describe, expect, it } from "vitest";
import { externalUrl, parseCommand } from "../src/main/guards.ts";

describe("parseCommand", () => {
	it("accepts a valid command and drops envelope fields", () => {
		expect(parseCommand({ command: "session.send", sessionId: "s1", prompt: "hi", id: "x", type: "y" })).toEqual({
			ok: true,
			command: { command: "session.send", sessionId: "s1", prompt: "hi" },
		});
	});

	it("passes the mode of session.start and session.set_mode, and rejects an unknown one", () => {
		const start = { command: "session.start", cwd: "/w", mode: "yolo" };
		expect(parseCommand(start)).toEqual({ ok: true, command: start });
		const set = { command: "session.set_mode", sessionId: "s1", mode: "auto" };
		expect(parseCommand(set)).toEqual({ ok: true, command: set });
		expect(parseCommand({ ...set, mode: "strict" })).toMatchObject({ ok: false, error: { code: "invalid_command" } });
	});

	it.each([
		["not an object", "session.start"],
		["null", null],
		["an unknown command", { command: "explode" }],
		["a missing field", { command: "session.send", sessionId: "s1" }],
		["a wrong type", { command: "session.approve", sessionId: "s1", callId: "c", approved: "yes" }],
	])("rejects %s with invalid_command", (_name, payload) => {
		expect(parseCommand(payload)).toMatchObject({ ok: false, error: { code: "invalid_command" } });
	});
});

describe("parseCommand: review commands", () => {
	const consent = {
		command: "session.review_consent",
		sessionId: "s1",
		reviewId: "0b6e5f3a-1c2d-4e8f-9a7b-3d4c5e6f7a8b",
	};

	it.each(["granted", "declined"])("accepts a review answer of %s", (answer) => {
		expect(parseCommand({ ...consent, answer })).toEqual({ ok: true, command: { ...consent, answer } });
	});

	it("accepts a session.review for a session", () => {
		expect(parseCommand({ command: "session.review", sessionId: "s1" })).toEqual({
			ok: true,
			command: { command: "session.review", sessionId: "s1" },
		});
	});

	it("accepts a session.undo_correction with or without a review id", () => {
		const undo = { command: "session.undo_correction", sessionId: "s1" };
		expect(parseCommand(undo)).toEqual({ ok: true, command: undo });
		expect(parseCommand({ ...undo, reviewId: consent.reviewId })).toEqual({
			ok: true,
			command: { ...undo, reviewId: consent.reviewId },
		});
	});

	it.each([
		["an undo with a review id with a path", { command: "session.undo_correction", sessionId: "s1", reviewId: "../x" }],
		["an answer outside the enum", { ...consent, answer: "maybe" }],
		["a boolean answer", { ...consent, answer: true }],
		["no answer", consent],
		["an empty review id", { ...consent, reviewId: "", answer: "granted" }],
		["a review id with a path", { ...consent, reviewId: "../../etc", answer: "granted" }],
		["a review id with spaces or control characters", { ...consent, reviewId: "a b\n", answer: "granted" }],
		["a very long review id", { ...consent, reviewId: "a".repeat(129), answer: "granted" }],
		["a numeric review id", { ...consent, reviewId: 7, answer: "granted" }],
		["a session.review without a session", { command: "session.review" }],
	])("rejects %s with invalid_command", (_name, payload) => {
		expect(parseCommand(payload)).toMatchObject({ ok: false, error: { code: "invalid_command" } });
	});
});

describe("externalUrl", () => {
	it.each(["https://example.com/a?b=c", "http://localhost:3000"])("opens %s outside", (url) => {
		expect(externalUrl(url)).toBe(url);
	});

	it.each(["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "data:text/html,x", "not a url"])(
		"refuses %s",
		(url) => {
			expect(externalUrl(url)).toBeUndefined();
		},
	);
});
