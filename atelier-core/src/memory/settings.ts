import { readFile } from "node:fs/promises";
import { join } from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether the user's prompts go to memory, and why not when the settings file could not tell. */
export interface MemoryPromptsSetting {
	enabled: boolean;
	warning?: string;
}

/**
 * Whether the user's prompts go to memory: yes unless `ATELIER_MEMORY_PROMPTS=off` or `memory.prompts` in
 * `~/.atelier/settings.json` says no. A file that cannot tell (unreadable, not JSON, another kind, a value that is
 * not true or false) keeps them out, since the user may have meant no, and the warning says why.
 */
export async function memoryPromptsEnabled(
	env: Record<string, string | undefined>,
	home: string | undefined,
): Promise<MemoryPromptsSetting> {
	if (env.ATELIER_MEMORY_PROMPTS === "off") return { enabled: false };
	if (home === undefined) return { enabled: true };
	const path = join(home, ".atelier", "settings.json");
	const off = (reason: string): MemoryPromptsSetting => ({
		enabled: false,
		warning: `${path}: ${reason}; your prompts are not saved to memory`,
	});
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
		return off(`cannot read it: ${(error as Error).message}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return off("not valid JSON");
	}
	if (!isRecord(raw) || raw.kind !== "atelier.settings" || raw.version !== 1)
		return off('expected kind "atelier.settings" and version 1');
	if (raw.memory === undefined) return { enabled: true };
	if (!isRecord(raw.memory)) return off('"memory" must be an object');
	const { prompts } = raw.memory;
	if (prompts === undefined || prompts === true) return { enabled: true };
	if (prompts === false) return { enabled: false };
	return off('"memory.prompts" must be true or false');
}
