export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 20;
export const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface ImageAttachment {
	mimeType: ImageMimeType;
	data: string;
}
export interface PreparedImage {
	image: ImageAttachment;
	width: number;
	height: number;
	animated: boolean;
}

const INVALID_IMAGE = "Invalid image. Supported formats: PNG, JPEG, GIF and WebP.";

interface NormalizeImageOptions {
	clipboard?: boolean;
	/** Injected in tests; the native binding is otherwise loaded only by an image operation. */
	loadSharp?: () => Promise<typeof import("sharp")>;
}

/** Sniff bytes, never trust a filename or a caller's declared MIME type. */
export function imageMimeType(bytes: Uint8Array): ImageMimeType | undefined {
	const head = Buffer.from(bytes.subarray(0, 12));
	if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP")
		return "image/webp";
	return undefined;
}

/** Decode only the first frame, with the pixel limit enforced by the decoder as well as by metadata. */
export async function normalizeImage(bytes: Uint8Array, options: NormalizeImageOptions = {}): Promise<PreparedImage> {
	if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error("Image exceeds the 20 MiB input limit.");
	const tiff = ["49492a00", "4d4d002a"].includes(Buffer.from(bytes.subarray(0, 4)).toString("hex"));
	if (imageMimeType(bytes) === undefined && !(options.clipboard && tiff)) throw new Error(INVALID_IMAGE);
	let sharp: typeof import("sharp");
	try {
		sharp = await (options.loadSharp ?? (async () => (await import("sharp")).default))();
	} catch (error) {
		throw new Error(`image support unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const source = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
		const metadata = await source.metadata();
		const height = metadata.pageHeight ?? metadata.height;
		if (!metadata.width || !height) throw new Error(INVALID_IMAGE);
		if (metadata.width * height > MAX_IMAGE_PIXELS) throw new Error("Image exceeds the 40,000,000-pixel limit.");
		for (let edge = 2048; edge >= 64; edge = Math.floor(edge * 0.75)) {
			const resized = source.clone().rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true });
			const png = await resized.clone().png().toBuffer({ resolveWithObject: true });
			const jpeg = metadata.hasAlpha
				? undefined
				: await resized.clone().jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
			const smallest = jpeg !== undefined && jpeg.data.length < png.data.length ? jpeg : png;
			if (smallest.data.length > MAX_IMAGE_BYTES) continue;
			return {
				image: { mimeType: smallest === png ? "image/png" : "image/jpeg", data: smallest.data.toString("base64") },
				width: smallest.info.width,
				height: smallest.info.height,
				animated: (metadata.pages ?? 1) > 1,
			};
		}
		throw new Error("Image could not be reduced to 4 MiB.");
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (/pixel limit/i.test(message)) throw new Error("Image exceeds the 40,000,000-pixel limit.");
		if (message.startsWith("Image ")) throw error;
		throw new Error(INVALID_IMAGE);
	}
}
