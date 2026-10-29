import { basename } from "node:path";
import type { AtelierEvent } from "@atelier/core";
import { oneLine, settledState } from "./program-status.ts";
import { target } from "./tool-card.ts";

/** The longest session name or first prompt the terminal's title shows. */
export const MAX_TITLE_NAME_CHARS = 50;

/** `Atelier - <name> - <working directory name>`, or without the name when there is none yet. */
export function terminalTitle(cwd: string, name: string | undefined): string {
	const folder = oneLine(basename(cwd));
	const named = oneLine(name ?? "", MAX_TITLE_NAME_CHARS);
	return named === "" ? `Atelier - ${folder}` : `Atelier - ${named} - ${folder}`;
}

/**
 * What the main agent is doing, for the terminal's agent row: the call it runs, else the ODD task in progress, while a
 * turn runs; the first line of its last text when the turn ends, or of the error that ended it.
 */
export class StatusLine {
	#call: { id: string; line: string } | undefined;
	#task: string | undefined;
	/** The main agent's last text, and whether a call came after it, so its next text starts a new one. */
	#text = "";
	#textEnded = false;
	#error: string | undefined;

	/** A turn starts: what the turn before said is not its. */
	started() {
		this.#call = undefined;
		this.#text = "";
		this.#textEnded = false;
		this.#error = undefined;
	}

	event(event: AtelierEvent) {
		// A subagent's work shows as the task call that runs it.
		if (event.parentCallId !== undefined) return;
		if (event.type === "tool_call_started") {
			this.#call = { id: event.callId, line: `${event.tool} ${target(event.input)}`.trim() };
			this.#textEnded = true;
		} else if (event.type === "tool_call_finished" && event.callId === this.#call?.id) this.#call = undefined;
		else if (event.type === "text_delta") {
			// Spaces alone after a call do not start a new text.
			if (this.#textEnded && event.text.trim() === "") return;
			if (this.#textEnded) this.#text = "";
			this.#textEnded = false;
			this.#text += event.text;
		} else if (event.type === "error") this.#error = event.message;
		else if (event.type === "feature_changed") {
			const task = event.tasks.find((each) => each.status === "in_progress");
			this.#task = task === undefined ? undefined : `${task.id} ${task.title}`;
		}
	}

	/** The line while the turn runs; empty when there is nothing to say. */
	working(): string {
		return oneLine(this.#call?.line ?? this.#task ?? "");
	}

	/** The state a turn leaves behind and its line. */
	settled(stopReason: string): { state: ReturnType<typeof settledState>; message: string } {
		const state = settledState(stopReason);
		if (state === "done") return { state, message: oneLine(this.#text) };
		if (state === "idle") return { state, message: "interrupted" };
		return { state, message: oneLine(this.#error ?? "") };
	}
}
