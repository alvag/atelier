import { readFile } from "node:fs/promises";
import { join } from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether the user's prompts go to memory: yes unless `ATELIER_MEMORY_PROMPTS=off` or `memory.prompts` in
 * `~/.atelier/settings.json` says no. A file that cannot tell (unreadable, not JSON, another kind, a value that is
 * not true or false) keeps them out: the user may have meant no.
 */
export async function memoryPromptsEnabled(
	env: Record<string, string | undefined>,
	home: string | undefined,
): Promise<boolean> {
	if (env.ATELIER_MEMORY_PROMPTS === "off") return false;
	if (home === undefined) return true;
	let text: string;
	try {
		text = await readFile(join(home, ".atelier", "settings.json"), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return false;
	}
	if (!isRecord(raw) || raw.kind !== "atelier.settings" || raw.version !== 1) return false;
	if (raw.memory === undefined) return true;
	if (!isRecord(raw.memory)) return false;
	return raw.memory.prompts === undefined || raw.memory.prompts === true;
}
