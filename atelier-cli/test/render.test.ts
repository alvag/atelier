import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { Renderer } from "../src/render.ts";

function render(bodies: AtelierEventBody[]) {
	let stdout = "";
	let stderr = "";
	const renderer = new Renderer({ stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), color: false });
	for (const [i, body] of bodies.entries()) renderer.render({ ...body, seq: i + 1, turnId: "t" } as AtelierEvent);
	return { stdout, stderr, renderer };
}

const usage = { input: 1200, output: 85, cacheRead: 9000, cacheWrite: 3100 };

describe("Renderer", () => {
	it("streams text, one line per tool and the turn's tokens", () => {
		const { stdout, stderr } = render([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
			{ type: "thinking_delta", text: "hmm" },
			{ type: "text_delta", text: "Let me " },
			{ type: "text_delta", text: "look." },
			{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "src/user.ts" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "src/user.ts (12 lines)", truncated: false },
			{ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "npm test" } },
			{ type: "tool_call_finished", callId: "c2", ok: false, summary: "npm test (exit 1)", truncated: true },
			{ type: "text_delta", text: "Fixed." },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.0421 },
		]);
		expect(stdout).toBe(
			[
				"atelier · claude-code · claude-opus-5-5 · subscription",
				"Let me look.",
				"▸ read src/user.ts (12 lines) ✓",
				"▸ bash npm test (exit 1) ✗ (truncated)",
				"Fixed.",
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · $0.0421",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("");
	});

	it("warns when the session is not using a subscription", () => {
		const { stderr } = render([{ type: "session_started", backend: "claude-code", model: "m", authSource: "api_key" }]);
		expect(stderr).toBe("warning: not using a Claude subscription (auth: api_key); usage may be billed separately.\n");
	});

	it("prints errors to stderr and remembers them", () => {
		const { stdout, stderr, renderer } = render([
			{ type: "text_delta", text: "partial" },
			{ type: "error", code: "not_logged_in", message: "Claude Code is not logged in.", recoverable: false },
			{ type: "turn_finished", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		]);
		expect(stdout).toBe("partial\ntokens: input 0 · output 0 · cache read 0 · cache write 0\n");
		expect(stderr).toBe("error: Claude Code is not logged in.\n");
		expect(renderer.failed).toBe(true);
	});

	it("does not count recoverable errors as a failed turn", () => {
		const { renderer } = render([
			{ type: "error", code: "busy", message: "busy", recoverable: true },
			{ type: "turn_finished", stopReason: "end_turn", usage },
		]);
		expect(renderer.failed).toBe(false);
	});

	it("shows rate limits only when they matter", () => {
		const quiet = render([{ type: "rate_limit", status: "allowed", window: "five_hour" }]);
		expect(quiet.stderr).toBe("");
		const loud = render([{ type: "rate_limit", status: "allowed_warning", window: "five_hour", resetsAt: 1792000000 }]);
		expect(loud.stderr).toMatch(/^rate limit: allowed_warning \(five_hour, resets .+\)\n$/);
	});
});
