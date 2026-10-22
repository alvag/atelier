import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { errorMessage, failure, MAX_BYTES, MAX_LINES, takeHead } from "./limits.ts";
import { resolveReadable } from "./paths.ts";
import { defineTool } from "./types.ts";

const NEWLINE = 0x0a;

interface Scan {
	/** Lines from `start` on, as many as fit; each keeps at most MAX_BYTES bytes. */
	lines: string[];
	total: number;
	binary: boolean;
}

/**
 * Streams the file once: counts every line, keeps only the requested ones, and
 * never holds more than about MAX_BYTES of any line, so huge files and huge
 * lines use bounded memory.
 */
async function scan(path: string, start: number, end: number): Promise<Scan> {
	const lines: string[] = [];
	let collectedBytes = 0;
	let total = 0;
	let parts: Buffer[] = [];
	let partBytes = 0;
	let partial = false;

	const wanted = () =>
		total + 1 >= start && total + 1 <= end && lines.length < MAX_LINES && collectedBytes <= MAX_BYTES;
	const keep = (piece: Buffer) => {
		if (piece.length === 0 || !wanted()) return;
		const room = MAX_BYTES - partBytes;
		if (room <= 0) return;
		const kept = piece.length > room ? piece.subarray(0, room) : piece;
		parts.push(kept);
		partBytes += kept.length;
	};
	const endLine = () => {
		if (wanted()) {
			lines.push(Buffer.concat(parts).toString("utf8"));
			collectedBytes += partBytes + 1;
		}
		total++;
		parts = [];
		partBytes = 0;
		partial = false;
	};

	const stream = createReadStream(path);
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			if (chunk.includes(0)) return { lines: [], total: 0, binary: true };
			let position = 0;
			while (position < chunk.length) {
				const newline = chunk.indexOf(NEWLINE, position);
				if (newline === -1) {
					keep(chunk.subarray(position));
					partial = true;
					break;
				}
				keep(chunk.subarray(position, newline));
				endLine();
				position = newline + 1;
			}
		}
	} finally {
		stream.destroy();
	}
	if (partial) endLine();
	return { lines, total, binary: false };
}

export const readTool = defineTool({
	name: "read",
	description:
		"Read a text file inside the working directory. Lines are numbered. Long files are truncated; use offset and limit to page through them.",
	inputShape: {
		path: z.string().describe("File path, relative to the working directory"),
		offset: z.number().int().min(1).optional().describe("First line to read, 1-based"),
		limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
	},
	async execute({ path, offset, limit }, { cwd, scratchDir }) {
		try {
			const absolute = await resolveReadable(cwd, path, scratchDir);
			if ((await stat(absolute)).isDirectory()) return failure(`Not a file: ${path}`);
			const start = offset ?? 1;
			const end = limit === undefined ? Number.POSITIVE_INFINITY : start + limit - 1;
			const { lines, total, binary } = await scan(absolute, start, end);
			if (binary) return failure(`Binary file: ${path}`);
			if (start > Math.max(total, 1)) return failure(`Offset ${start} is beyond the end of ${path} (${total} lines).`);

			const shown = takeHead(lines.map((line, i) => `${start + i}\t${line}`));
			const last = start + shown.lines.length - 1;
			let output = shown.lines.join("\n");
			if (last < total)
				output += `\n\n[Showing lines ${start}-${last} of ${total}. Use offset=${last + 1} to continue.]`;
			else if (shown.clipped)
				output += `\n\n[Line ${last} is too long and was clipped. Use grep or bash to inspect it.]`;
			const truncated = last < total || shown.clipped;
			return { ok: true, output, summary: `${path} (${total} lines)`, truncated };
		} catch (error) {
			return failure(errorMessage(error));
		}
	},
});
