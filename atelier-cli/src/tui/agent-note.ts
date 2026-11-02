import { visibleText } from "@atelier/core";

const FROM = /\bfrom\s*=\s*(?:"([^"]*)"|'([^']*)')/;
/** The opening tag of a note, up to its first `>`. */
const TAG = /^\s*<hc((?:\s[^>]*)?)>/;

/** Whether `text` begins like a note from another agent: `<hc` after any whitespace, whatever follows. */
export const startsNote = (text: string): boolean => text.trimStart().startsWith("<hc");

/**
 * Where the draft in the editor came from. A bracketed paste that begins like a note taints the whole draft, even with
 * the user's own text before it, until the draft is empty, replaced or submitted: the draft is then sent as a note,
 * never run as a command. The mark goes with a submission and comes back with the draft when it is given back.
 */
export class DraftOrigin {
	tainted = false;

	/** A paste of `text` went into the draft. */
	pasted(text: string): void {
		if (startsNote(text)) this.tainted = true;
	}

	/** The draft now reads `text`; an empty one has no origin. */
	edited(text: string): void {
		if (text === "") this.tainted = false;
	}

	/** The draft is submitted: its mark, and none after. */
	take(): boolean {
		const marked = this.tainted;
		this.tainted = false;
		return marked;
	}

	/** A draft that carried the mark came back. */
	restore(marked: boolean): void {
		if (marked) this.tainted = true;
	}
}

/** `Agent note`, with ` from <sender>` when the opening tag names one; the sender is untrusted, so hidden characters show. */
export function agentNoteLabel(text: string): string {
	const attributes = TAG.exec(text)?.[1] ?? "";
	const match = FROM.exec(attributes);
	const from = visibleText((match?.[1] ?? match?.[2] ?? "").trim()).text;
	return from === "" ? "Agent note" : `Agent note from ${from}`;
}

/** The note as it is shown: its label, then all of its text, with hidden characters made visible. */
export const agentNoteText = (text: string): string => `${agentNoteLabel(text)}\n${visibleText(text).text}`;
