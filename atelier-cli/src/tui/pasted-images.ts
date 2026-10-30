import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, type PreparedImage, readImageFile } from "@atelier/core";

interface PasteOptions {
	cwd: string;
	home?: string;
}

/** Split like a shell would, without evaluating anything; undefined for an unterminated quote. */
function shellWords(text: string): string[] | undefined {
	const words: string[] = [];
	let word: string | undefined;
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
		} else if (c === "\\" && i + 1 < text.length && (quote === undefined || '"\\$`'.includes(text[i + 1] as string))) {
			word = (word ?? "") + text[++i];
		} else if (quote === '"' && c === '"') {
			quote = undefined;
		} else if (quote === undefined && (c === "'" || c === '"')) {
			quote = c;
			word ??= "";
		} else if (quote === undefined && /\s/.test(c)) {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else {
			word = (word ?? "") + c;
		}
	}
	if (quote !== undefined) return undefined;
	if (word !== undefined) words.push(word);
	return words;
}

function resolvePath(word: string, { cwd, home = homedir() }: PasteOptions): string | undefined {
	if (word.startsWith("file://")) {
		try {
			return fileURLToPath(word);
		} catch {
			return undefined;
		}
	}
	if (word === "~" || word.startsWith("~/")) return join(home, word.slice(1));
	return isAbsolute(word) ? word : resolve(cwd, word);
}

/** Only an existing regular file counts; anything else is left to be pasted as text, and never opened. */
async function regularFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function existingFiles(words: string[], options: PasteOptions): Promise<string[] | undefined> {
	// One extra path proves the batch is too large without probing an unbounded list.
	const paths = words.slice(0, MAX_PROMPT_IMAGES + 1).map((word) => resolvePath(word, options));
	if (paths.length === 0) return undefined;
	for (const path of paths) if (path === undefined || !(await regularFile(path))) return undefined;
	return paths as string[];
}

/**
 * Images named by a whole paste: one path (raw, quoted or escaped) or several quoted ones.
 * Undefined means the paste is ordinary text and the caller keeps it; bad image bytes throw.
 */
export async function preparePastedImages(text: string, options: PasteOptions): Promise<PreparedImage[] | undefined> {
	const trimmed = text.trim();
	const words = shellWords(trimmed);
	const paths = (await existingFiles([trimmed], options)) ?? (words && (await existingFiles(words, options)));
	if (!paths) return undefined;
	if (paths.length > MAX_PROMPT_IMAGES) throw new Error(`A prompt accepts at most ${MAX_PROMPT_IMAGES} images.`);
	const images: PreparedImage[] = [];
	let bytes = 0;
	for (const path of paths) {
		const image = await readImageFile(path);
		if (image === undefined) return undefined;
		bytes += Buffer.byteLength(image.image.data, "base64");
		if (bytes > MAX_PROMPT_IMAGE_BYTES) throw new Error("Pasted images exceed the 20 MiB prompt limit.");
		images.push(image);
	}
	return images;
}
