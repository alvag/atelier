import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { errorMessage, failure, takeHead } from "./limits.ts";
import { resolveReadable } from "./paths.ts";
import { defineTool } from "./types.ts";

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
			const content = await readFile(absolute, "utf8");
			const lines = content.split("\n");
			if (content.endsWith("\n")) lines.pop();
			const total = lines.length;
			const start = offset ?? 1;
			if (start > Math.max(total, 1)) return failure(`Offset ${start} is beyond the end of ${path} (${total} lines).`);

			const end = limit === undefined ? total : Math.min(total, start + limit - 1);
			const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`);
			const shown = takeHead(numbered);
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
