import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/backends/anthropic-api/system-prompt.ts";
import { SYSTEM_PROMPT_APPEND } from "../src/prompt.ts";

const LANGUAGE_RULE =
	"Write everything you tell the user in the language the user writes in: your messages between tool calls, your questions, your final answer and the reasons you give when you ask for approval. Code, comments, commit messages, docs and pull request descriptions follow the project's instructions; without them, the language the user asks for, else the one the project already uses. What you write to subagents may stay in English.";

describe("the shared system prompt", () => {
	it("says read and grep reach outside the working directory and edit there asks first", () => {
		expect(SYSTEM_PROMPT_APPEND).toBe(
			`You are running inside Atelier. Use only the Atelier tools. Paths are relative to the working directory; read and grep also take absolute and ../ paths outside it (except the user's secrets), and edit and write outside it ask for approval. Use edit to change a file that exists and write to create one or replace it whole. bash commands may need the user's approval; if one is denied, do not retry it. Use web_fetch to read a web page and web_search to look something up, not curl or wget in bash; never put secrets or private code in a URL or a search query.\n\n${LANGUAGE_RULE}`,
		);
	});

	it("tells the agent to answer in the user's language and leaves artifacts to the project", () => {
		expect(SYSTEM_PROMPT_APPEND).toContain(LANGUAGE_RULE);
		// The anthropic-api backend sends the append inside its own system prompt; Claude Code appends it to its preset.
		expect(systemPrompt("/work", SYSTEM_PROMPT_APPEND)).toContain(LANGUAGE_RULE);
	});
});
