export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
/** Room kept for the notes tools append, so the whole output stays within MAX_BYTES. */
const NOTE_RESERVE = 512;
const CONTENT_BYTES = MAX_BYTES - NOTE_RESERVE;
export const MAX_GREP_MATCHES = 100;
export const MAX_LINE_CHARS = 500;

/** First `maxBytes` bytes of `text`, never splitting a UTF-8 character. */
export function headBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

/** Last `maxBytes` bytes of `text`, never splitting a UTF-8 character. */
export function tailBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return text;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

/** Keeps the first lines that fit in MAX_LINES and MAX_BYTES; a first line that alone is too long is clipped. */
export function takeHead(lines: readonly string[], maxBytes = CONTENT_BYTES): { lines: string[]; clipped: boolean } {
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (kept.length >= MAX_LINES) break;
		const size = Buffer.byteLength(line) + 1;
		if (bytes + size > maxBytes) {
			if (kept.length === 0) return { lines: [`${headBytes(line, maxBytes)} [line truncated]`], clipped: true };
			break;
		}
		kept.push(line);
		bytes += size;
	}
	return { lines: kept, clipped: false };
}

/** Keeps the last lines of `text` that fit in MAX_LINES and MAX_BYTES. */
export function takeTail(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		const size = Buffer.byteLength(line) + 1;
		if (kept.length >= MAX_LINES || bytes + size > CONTENT_BYTES) {
			if (kept.length === 0) return { text: `[line truncated] ${tailBytes(line, CONTENT_BYTES)}`, truncated: true };
			break;
		}
		kept.unshift(line);
		bytes += size;
	}
	return { text: kept.join("\n"), truncated: kept.length < lines.length };
}

export function failure(
	output: string,
	summary = output,
): {
	ok: false;
	output: string;
	summary: string;
	truncated: false;
} {
	return { ok: false, output, summary, truncated: false };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
