/**
 * Invisible or reordering characters that could make a command look different
 * from what runs: C0/C1 controls (except tab and newline), zero-width
 * characters, and bidirectional controls.
 */
const HIDDEN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Shows hidden characters as visible markers (␛ for escape, ⟨U+XXXX⟩ otherwise), so what you read is what runs. */
export function visibleText(text: string): { text: string; hadHidden: boolean } {
	let hadHidden = false;
	const shown = text.replace(HIDDEN, (char) => {
		hadHidden = true;
		if (char === "\u001b") return "␛";
		return `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
	});
	return { text: shown, hadHidden };
}
