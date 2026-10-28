import { homedir } from "node:os";
import { expect, it } from "vitest";
import { bundledClaudeCode } from "../src/claude-code-auth.ts";
import { forbiddenCommand, REAL_HOME } from "./support/credential-guard.ts";

it("forbids the real Claude Code and the Keychain's command, and nothing else", () => {
	expect(forbiddenCommand(bundledClaudeCode() ?? "/x/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).toBe(true);
	expect(forbiddenCommand("claude")).toBe(true);
	expect(forbiddenCommand("/usr/bin/security")).toBe(true);
	expect(forbiddenCommand("/tmp/atelier-test/claude")).toBe(false);
	expect(forbiddenCommand("git")).toBe(false);
});

it("runs every test with an empty home of its own, not the real one", () => {
	expect(homedir()).not.toBe(REAL_HOME);
	expect(process.env.HOME).not.toBe(REAL_HOME);
});
