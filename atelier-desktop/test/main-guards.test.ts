import { describe, expect, it } from "vitest";
import { externalUrl, parseCommand } from "../src/main/guards.ts";

describe("parseCommand", () => {
	it("accepts a valid command and drops envelope fields", () => {
		expect(parseCommand({ command: "session.send", sessionId: "s1", prompt: "hi", id: "x", type: "y" })).toEqual({
			ok: true,
			command: { command: "session.send", sessionId: "s1", prompt: "hi" },
		});
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
