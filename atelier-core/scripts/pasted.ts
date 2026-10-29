/**
 * Whether a delegation prompt pastes code: a line of the prompt that repeats a
 * long line of the source, trimmed, counts as pasted. Short lines (`}`, an
 * import of one name) are left out, since any prompt may share them.
 */

const MIN_LENGTH = 25;

/** The source's lines long enough to count, trimmed. */
export function sourceLines(files: readonly string[]): Set<string> {
	const lines = new Set<string>();
	for (const file of files)
		for (const line of file.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length >= MIN_LENGTH) lines.add(trimmed);
		}
	return lines;
}

export function pastedLines(prompt: string, source: ReadonlySet<string>): number {
	return prompt.split("\n").filter((line) => source.has(line.trim())).length;
}
