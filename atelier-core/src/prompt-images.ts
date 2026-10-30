import {
	type ImageAttachment,
	MAX_IMAGE_INPUT_BYTES,
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGES,
	normalizeImage,
} from "./images.ts";

const MAX_ENCODED_LENGTH = Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4;
const INPUT_LIMIT = "Image exceeds the 20 MiB input limit.";

/** Decode only canonical standard base64: the re-encoded bytes must equal the input. */
function decodeBase64(data: string): Buffer {
	if (data.length > MAX_ENCODED_LENGTH) throw new Error(INPUT_LIMIT);
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== data) throw new Error("Image data is not canonical base64.");
	if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error(INPUT_LIMIT);
	return bytes;
}

/** Normalize prompt images one at a time, bounding their count and total size. */
export async function normalizePromptImages(
	images: readonly ImageAttachment[],
	options: { signal?: AbortSignal; normalize?: typeof normalizeImage } = {},
): Promise<ImageAttachment[]> {
	if (images.length > MAX_PROMPT_IMAGES) throw new Error(`A prompt accepts at most ${MAX_PROMPT_IMAGES} images.`);
	const normalize = options.normalize ?? normalizeImage;
	const result: ImageAttachment[] = [];
	let total = 0;
	for (const image of images) {
		options.signal?.throwIfAborted();
		const prepared = await normalize(decodeBase64(image.data));
		options.signal?.throwIfAborted();
		total += Buffer.from(prepared.image.data, "base64").length;
		if (total > MAX_PROMPT_IMAGE_BYTES) throw new Error("Prompt images exceed the 20 MiB total limit.");
		result.push({ mimeType: prepared.image.mimeType, data: prepared.image.data });
	}
	return result;
}
