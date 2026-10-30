import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_IMAGE_INPUT_BYTES } from "@atelier/core";

const OSASCRIPT = "/usr/bin/osascript";
const READ_TIMEOUT_MS = 3_000;
// The image limit as base64 text (4 bytes per 3), with room for the trailing newline.
const MAX_OUTPUT_BYTES = Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 + 1024;

// Prints the clipboard image as base64, preferring PNG over TIFF; prints nothing when there is none.
const SCRIPT = `ObjC.import("AppKit");
const board = $.NSPasteboard.generalPasteboard;
let data = board.dataForType($.NSPasteboardTypePNG);
if (!data || data.isNil()) data = board.dataForType($.NSPasteboardTypeTIFF);
if (data && !data.isNil() && Number(data.length) > ${MAX_IMAGE_INPUT_BYTES})
	throw new Error("The clipboard image exceeds the 20 MiB input limit.");
data && !data.isNil() ? data.base64EncodedStringWithOptions(0).js : "";`;

export interface ClipboardRunnerOptions {
	timeout: number;
	maxBuffer: number;
	signal: AbortSignal;
}

/** Runs a program and resolves with its standard output; rejects on a failed exit, timeout, overflow or abort. */
export type ClipboardRunner = (
	file: string,
	args: string[],
	options: ClipboardRunnerOptions,
) => Promise<{ stdout: string }>;

const runFile = promisify(execFile);

const defaultRunner: ClipboardRunner = (file, args, options) =>
	runFile(file, args, { ...options, killSignal: "SIGKILL", encoding: "utf8" });

/** Builds the reader with its subprocess runner and platform injectable, so tests never touch the clipboard. */
export function createClipboardImageReader(
	deps: { runner?: ClipboardRunner; platform?: NodeJS.Platform } = {},
): (signal: AbortSignal) => Promise<Uint8Array | undefined> {
	const runner = deps.runner ?? defaultRunner;
	const platform = deps.platform ?? process.platform;
	return async (signal) => {
		if (platform !== "darwin") return undefined;
		signal.throwIfAborted();
		let stdout: string;
		try {
			({ stdout } = await runner(OSASCRIPT, ["-l", "JavaScript", "-e", SCRIPT], {
				timeout: READ_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
				signal,
			}));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not read the clipboard image: ${reason}`, { cause: error });
		}
		signal.throwIfAborted();
		const text = stdout.trim();
		if (text === "") return undefined;
		if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text))
			throw new Error("The clipboard image could not be decoded.");
		const bytes = Buffer.from(text, "base64");
		if (bytes.toString("base64") !== text) throw new Error("The clipboard image could not be decoded.");
		if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error("The clipboard image exceeds the 20 MiB input limit.");
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
	};
}

/** Reads the macOS clipboard image as PNG or TIFF bytes; undefined elsewhere or when it holds no image. */
export const readClipboardImage = createClipboardImageReader();
