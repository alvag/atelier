import { type SavedEntry, visibleText } from "@atelier/core";

/** One answered prompt of a saved session: what the user asked and the main agent's last text of the turn. */
interface SavedTurn {
	turnId: string;
	prompt: string;
	answer?: string;
}

/** The prompts of a saved session, each with the final text the main agent wrote in that turn. */
function turnsOf(entries: readonly SavedEntry[]): SavedTurn[] {
	const turns: SavedTurn[] = [];
	for (const entry of entries) {
		if (entry.type === "prompt") turns.push({ turnId: entry.turnId, prompt: entry.text });
		else if (entry.type === "text" && entry.agent === undefined && entry.parentCallId === undefined) {
			const turn = turns.at(-1);
			if (turn?.turnId === entry.turnId) turn.answer = entry.text;
		}
	}
	return turns;
}

/**
 * What a resumed session prints before it goes on: a line saying what was resumed, then each prompt after `> ` and
 * the final text of its turn. Text that came from the model or from a file is shown with control characters as markers.
 */
export function savedTranscript(id: string, name: string | undefined, entries: readonly SavedEntry[]): string {
	const turns = turnsOf(entries);
	const label = name === undefined ? "" : ` "${visibleText(name).text}"`;
	let out = `resumed session ${id}${label}: ${turns.length} ${turns.length === 1 ? "turn" : "turns"}\n`;
	for (const turn of turns) {
		out += `> ${visibleText(turn.prompt).text.replace(/\n/g, "\n  ")}\n`;
		if (turn.answer !== undefined) out += `${visibleText(turn.answer).text.trimEnd()}\n`;
	}
	return out;
}
