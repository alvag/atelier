import { SessionStore } from "@atelier/core";

export const AGENT = "atelier";

/** The command that resumes the saved session `id`; Herdr runs it as it is. */
export const resumeArgv = (id: string): string[] => [AGENT, "--resume", id];

/**
 * The line that resumes saved session `id` from the shell's directory `cwd`, or undefined when it cannot: a new session
 * needs a recorded prompt in its file; a resumed one only needs a file that loads. A read that takes longer than
 * `timeoutMs` gives no line.
 */
export async function resumeHint(
	home: string,
	cwd: string,
	id: string,
	resumed: boolean,
	timeoutMs: number,
): Promise<string | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const gaveUp = new Promise<undefined>((resolve) => {
			timer = setTimeout(resolve, timeoutMs, undefined);
		});
		const loaded = await Promise.race([new SessionStore(home).load(cwd, id), gaveUp]);
		if (loaded === undefined) return undefined;
		if (!resumed && loaded.turns === 0) return undefined;
		return `${resumeArgv(id).join(" ")}\n`;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
