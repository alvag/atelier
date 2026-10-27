import { type SavedEntry, visibleText } from "@atelier/core";

/** One answered prompt of a saved session: what the user asked, what they steered with, and the main agent's last text of the turn. */
interface SavedTurn {
	turnId: string;
	prompt: string;
	steers: string[];
	answer?: string;
}

/** The prompts of a saved session, each with the final text the main agent wrote in that turn. */
function turnsOf(entries: readonly SavedEntry[]): SavedTurn[] {
	const turns: SavedTurn[] = [];
	for (const entry of entries) {
		if (entry.type === "prompt") turns.push({ turnId: entry.turnId, prompt: entry.text, steers: [] });
		else if (entry.type === "text" && entry.agent === undefined && entry.parentCallId === undefined) {
			const turn = turns.at(-1);
			if (turn?.turnId === entry.turnId) turn.answer = entry.text;
		} else if (entry.type === "event" && entry.event.type === "queued_message") {
			const turn = turns.at(-1);
			if (turn?.turnId === entry.event.turnId) turn.steers.push(entry.event.text);
		}
	}
	return turns;
}

/** A prompt after `> `, its other lines lined up under it. */
const promptLine = (text: string) => `> ${visibleText(text).text.replace(/\n/g, "\n  ")}\n`;

/**
 * What a resumed session prints before it goes on: a line saying what was resumed, then each prompt after `> `
 * (and what the user steered with during its turn, the same way) and the final text of its turn. Text that came from
 * the model or from a file is shown with control characters as markers.
 */
export function savedTranscript(id: string, name: string | undefined, entries: readonly SavedEntry[]): string {
	const turns = turnsOf(entries);
	const label = name === undefined ? "" : ` "${visibleText(name).text}"`;
	let out = `resumed session ${id}${label}: ${turns.length} ${turns.length === 1 ? "turn" : "turns"}\n`;
	for (const turn of turns) {
		out += promptLine(turn.prompt);
		for (const steer of turn.steers) out += promptLine(steer);
		if (turn.answer !== undefined) out += `${visibleText(turn.answer).text.trimEnd()}\n`;
	}
	return out;
}
