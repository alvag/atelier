import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_APPEND } from "../src/prompt.ts";

describe("the shared system prompt", () => {
	it("says read and grep reach outside the working directory and edit there asks first", () => {
		expect(SYSTEM_PROMPT_APPEND).toBe(
			"You are running inside Atelier. Use only the Atelier tools. Paths are relative to the working directory; read and grep also take absolute and ../ paths outside it (except the user's secrets), and edit and write outside it ask for approval. Use edit to change a file that exists and write to create one or replace it whole. bash commands may need the user's approval; if one is denied, do not retry it.",
		);
	});
});
