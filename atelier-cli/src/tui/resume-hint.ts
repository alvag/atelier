import { SessionStore } from "@atelier/core";

export const AGENT = "atelier";

/** The command that resumes the saved session `id`; Herdr runs it as it is. */
export const resumeArgv = (id: string): string[] => [AGENT, "--resume", id];

/**
 * The line that tells how to resume the saved session `id` of `cwd`, or undefined when it cannot be: a new session
 * needs a recorded prompt in its file; a resumed one only needs a file that loads.
 */
export async function resumeHint(home: string, cwd: string, id: string, resumed: boolean): Promise<string | undefined> {
	try {
		const loaded = await new SessionStore(home).load(cwd, id);
		if (!resumed && loaded.turns === 0) return undefined;
		return `${resumeArgv(id).join(" ")}\n`;
	} catch {
		return undefined;
	}
}
