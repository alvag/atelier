import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isFeatureDocument, type Location, locate, writeAtomic } from "./edit.ts";
import { errorMessage, failure, MAX_WRITE_BYTES } from "./limits.ts";
import { PathProtectedError } from "./paths.ts";
import { defineTool, type ToolContext, type ToolDefinition } from "./types.ts";

const NEW_FILE_MODE = 0o644;

const notApproved = (real: string) =>
	`Not written: ${real} is outside the working directory and the user did not approve writing it.`;

const tooLarge = (bytes: number) =>
	`Not written: the content is ${bytes} bytes and write takes at most ${MAX_WRITE_BYTES} (${MAX_WRITE_BYTES / 1024 / 1024} MiB); write the file in parts or generate it with bash.`;

/** True when the path, as written or as resolved, is the project's `.atelier` or inside it, in any letter case. */
async function isProjectConfig(cwd: string, path: string, real: string): Promise<boolean> {
	const root = await realpath(cwd);
	const under = (from: string, file: string) => {
		const rel = relative(from, file).split(sep).join("/").toLowerCase();
		return rel === ".atelier" || rel.startsWith(".atelier/");
	};
	return under(cwd, resolve(cwd, path)) || under(root, real);
}

/** Why the file is never written, approved or not; undefined when it may be. */
async function refusalFor(cwd: string, path: string, real: string): Promise<string | undefined> {
	// Feature documents change only through the feature tool, which keeps them well formed.
	if (await isFeatureDocument(cwd, path, real))
		return `${path} is a feature document: change it with the feature tool, not write.`;
	if (await isProjectConfig(cwd, path, real))
		return `${path} is project configuration: the agent does not write .atelier/.`;
	return undefined;
}

/** Whether the file is there and is not a regular file: a folder, a socket. */
const existsAsOther = (real: string) =>
	stat(real).then(
		(info) => !info.isFile(),
		() => false,
	);

export interface WriteOptions {
	/** The home whose secret directories stay closed and whose configuration lists writable directories; defaults to the user's. */
	home?: string;
}

export function createWriteTool(options: WriteOptions = {}): ToolDefinition {
	const home = options.home ?? homedir();
	return defineTool({
		name: "write",
		description:
			"Create a file, or replace an existing one whole, with the given content; missing folders are created. Use edit to change part of a file that exists and write to create a file or replace it entirely. Paths inside the working directory are written directly; a file anywhere else needs the user's approval, once per file for the session, and the user's secret files are never written. Content over 1 MiB is refused.",
		inputShape: {
			path: z.string().describe("File path, absolute or relative to the working directory"),
			content: z.string().describe("The whole content of the file"),
		},
		async gate({ path, content }, context: ToolContext) {
			const bytes = Buffer.byteLength(content);
			if (bytes > MAX_WRITE_BYTES) return { refusal: { output: tooLarge(bytes), summary: tooLarge(bytes) } };
			let location: Location;
			try {
				location = await locate(context.cwd, path, context, home);
				const message = await refusalFor(context.cwd, path, location.real);
				if (message !== undefined) return { refusal: { output: message, summary: message } };
			} catch (error) {
				// Nobody is asked about what is never written; execute says why.
				if (error instanceof PathProtectedError) return { refusal: { output: error.message, summary: error.message } };
				return {};
			}
			if (location.allowed) return {};
			// A folder is not worth a question: execute reports it.
			if (await existsAsOther(location.real)) return {};
			return {
				approval: {
					command: `write ${location.real}`,
					reason: "outside the working directory",
					always: true,
					tool: "write",
					grant: location.real,
					denial: notApproved(location.real),
				},
			};
		},
		async execute({ path, content }, context) {
			const { cwd } = context;
			try {
				const bytes = Buffer.byteLength(content);
				if (bytes > MAX_WRITE_BYTES) return failure(tooLarge(bytes));
				const { real, allowed } = await locate(cwd, path, context, home);
				const message = await refusalFor(cwd, path, real);
				if (message !== undefined) return failure(message);
				if (await existsAsOther(real)) return failure(`Not a file: ${path}`);
				// The approval covers one real path: a link swapped since the question leads to a file nobody approved.
				if (!allowed) return failure(notApproved(real));
				const mode = await stat(real).then(
					(info) => info.mode & 0o7777,
					() => NEW_FILE_MODE,
				);
				await mkdir(resolve(real, ".."), { recursive: true });
				await writeAtomic(real, content, mode);
				const size = `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
				return { ok: true, output: `Wrote ${path} (${size}).`, summary: `${path} (${size})`, truncated: false };
			} catch (error) {
				return failure(errorMessage(error));
			}
		},
	});
}

export const writeTool = createWriteTool();
