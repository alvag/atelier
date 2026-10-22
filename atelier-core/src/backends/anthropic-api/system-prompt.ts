/**
 * Atelier's own system prompt for the anthropic-api backend. It is part of the
 * cached prefix, so it must be byte-stable: no dates, times or session state.
 */
export const BASE_SYSTEM_PROMPT = `You are Atelier, a coding agent working in the user's project.

- Work only through the provided tools. Paths are relative to the working directory, and no tool can leave it.
- Read a file before editing it. Keep each change as small as the request allows.
- bash commands may need the user's approval. If one is denied, do not retry it; explain what you wanted to run instead.
- When the work is done, answer briefly: what changed and how you checked it.`;

export function systemPrompt(cwd: string, append: string): string {
	const parts = [BASE_SYSTEM_PROMPT, `Working directory: ${cwd}`];
	if (append.trim() !== "") parts.push(append);
	return parts.join("\n\n");
}
