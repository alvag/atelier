import { type SavedEntry, type UserQuestion, visibleText } from "@atelier/core";
import { type AskOutcome, finishedOutcome, questionsOf } from "./tui/answered-block.ts";

/** An `ask_user` batch of the main agent in a saved turn, and what it came to; none when the file ends before it settled. */
interface SavedAsk {
	callId: string;
	questions: UserQuestion[];
	outcome?: AskOutcome;
}

/** One answered prompt of a saved session: what the user asked, what they steered with, and the main agent's last text of the turn. */
interface SavedTurn {
	turnId: string;
	prompt: string;
	steers: string[];
	asked: SavedAsk[];
	answer?: string;
}

/** The batch `callId` of `turn`, a new one when the turn has none yet. */
function askOf(turn: SavedTurn, callId: string): SavedAsk {
	let ask = turn.asked.find((candidate) => candidate.callId === callId);
	if (ask === undefined) {
		ask = { callId, questions: [] };
		turn.asked.push(ask);
	}
	return ask;
}

/** What a saved event of the main agent's `ask_user` call says of its batch. */
function asking(turn: SavedTurn, event: Extract<SavedEntry, { type: "event" }>["event"]): void {
	if (event.parentCallId !== undefined) return;
	if (event.type === "tool_call_started" && event.tool === "ask_user")
		askOf(turn, event.callId).questions = questionsOf(event.input);
	else if (event.type === "user_question_requested") askOf(turn, event.callId).questions = event.questions;
	else if (event.type === "user_question_resolved") askOf(turn, event.callId).outcome = event.result;
	else if (event.type === "tool_call_finished") {
		// A batch the core ended without asking it, or whose call failed, has no resolution of its own.
		const ask = turn.asked.find((candidate) => candidate.callId === event.callId);
		if (ask !== undefined) ask.outcome ??= finishedOutcome(event);
	}
}

/** Restore visible attachment counts without adding markers already present in an older transcript. */
function promptWithImages(text: string, count = 0): string {
	const present = new Set(text.match(/\[Image #[1-9]\d*\]/g) ?? []);
	const missing: string[] = [];
	for (let next = 1; present.size + missing.length < count; next++) {
		const marker = `[Image #${next}]`;
		if (!present.has(marker)) missing.push(marker);
	}
	if (missing.length === 0) return text;
	return `${text}${text !== "" && !/\s$/.test(text) ? " " : ""}${missing.join(" ")}`;
}

/** The prompts of a saved session, each with the final text the main agent wrote in that turn. */
function turnsOf(entries: readonly SavedEntry[]): SavedTurn[] {
	const turns: SavedTurn[] = [];
	for (const entry of entries) {
		if (entry.type === "prompt")
			turns.push({
				turnId: entry.turnId,
				prompt: promptWithImages(entry.text, entry.imageCount),
				steers: [],
				asked: [],
			});
		else if (entry.type === "text" && entry.agent === undefined && entry.parentCallId === undefined) {
			const turn = turns.at(-1);
			if (turn?.turnId === entry.turnId) turn.answer = entry.text;
		} else if (entry.type === "event") {
			const turn = turns.at(-1);
			if (turn?.turnId !== entry.event.turnId) continue;
			if (entry.event.type === "queued_message") turn.steers.push(entry.event.text);
			else asking(turn, entry.event);
		}
	}
	return turns;
}

/** A prompt after `> `, its other lines lined up under it. */
const promptLine = (text: string) => `> ${visibleText(text).text.replace(/\n/g, "\n  ")}\n`;

/** A piece of a resumed session's transcript: text as it is printed, or an `ask_user` batch the TUI shows as a block. */
export type SavedPart = { text: string } | { questions: UserQuestion[]; outcome: AskOutcome };

/**
 * The transcript of a resumed session in pieces: the line saying what was resumed, then each prompt (and what the user
 * steered with during its turn) as text, the `ask_user` batches that settled in the turn, and the turn's final text.
 */
export function savedParts(id: string, name: string | undefined, entries: readonly SavedEntry[]): SavedPart[] {
	const turns = turnsOf(entries);
	const label = name === undefined ? "" : ` "${visibleText(name).text}"`;
	const parts: SavedPart[] = [];
	let out = `resumed session ${id}${label}: ${turns.length} ${turns.length === 1 ? "turn" : "turns"}\n`;
	for (const turn of turns) {
		out += promptLine(turn.prompt);
		for (const steer of turn.steers) out += promptLine(steer);
		for (const { questions, outcome } of turn.asked) {
			if (outcome === undefined || (questions.length === 0 && outcome.status !== "failed")) continue;
			parts.push({ text: out });
			parts.push({ questions, outcome });
			out = "";
		}
		if (turn.answer !== undefined) out += `${visibleText(turn.answer).text.trimEnd()}\n`;
	}
	if (out !== "") parts.push({ text: out });
	return parts;
}

/**
 * What a resumed session prints before it goes on: a line saying what was resumed, then each prompt after `> `
 * (and what the user steered with during its turn, the same way) and the final text of its turn. Text that came from
 * the model or from a file is shown with control characters as markers. The questions the user answered are left to
 * the TUI, which shows them with `savedParts`.
 */
export function savedTranscript(id: string, name: string | undefined, entries: readonly SavedEntry[]): string {
	return savedParts(id, name, entries)
		.map((part) => ("text" in part ? part.text : ""))
		.join("");
}
