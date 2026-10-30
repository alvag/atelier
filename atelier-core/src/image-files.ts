import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { imageMimeType, MAX_IMAGE_INPUT_BYTES, normalizeImage, type PreparedImage } from "./images.ts";

/** Check before opening, then check the opened descriptor too; nonblocking prevents a replaced FIFO from hanging. */
export async function readImageFile(path: string): Promise<PreparedImage | undefined> {
	const before = await stat(path);
	if (!before.isFile()) throw new Error("Cannot attach image: not a regular file.");
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const opened = await file.stat();
		if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
			throw new Error("Cannot attach image: not a regular file.");
		const head = Buffer.alloc(12);
		await file.read(head, 0, head.length, 0);
		if (imageMimeType(head) === undefined) return undefined;
		if (opened.size > MAX_IMAGE_INPUT_BYTES) throw new Error("Image exceeds the 20 MiB input limit.");
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of file.createReadStream({ start: 0, end: MAX_IMAGE_INPUT_BYTES, autoClose: false })) {
			size += chunk.length;
			if (size > MAX_IMAGE_INPUT_BYTES) throw new Error("Image exceeds the 20 MiB input limit.");
			chunks.push(chunk);
		}
		return await normalizeImage(Buffer.concat(chunks));
	} finally {
		await file.close();
	}
}
