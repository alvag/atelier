import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
	type ImageAttachment,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_INPUT_BYTES,
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGES,
} from "../src/images.ts";
import { normalizePromptImages } from "../src/prompt-images.ts";

const png = () =>
	sharp({ create: { width: 3, height: 2, channels: 3, background: "#2468ac" } })
		.png()
		.toBuffer();
const attach = (bytes: Uint8Array, mimeType: ImageAttachment["mimeType"] = "image/png"): ImageAttachment => ({
	mimeType,
	data: Buffer.from(bytes).toString("base64"),
});
const fake = (size: number) =>
	vi.fn(async () => ({
		image: { mimeType: "image/png" as const, data: Buffer.alloc(size).toString("base64") },
		width: 1,
		height: 1,
		animated: false,
	}));

describe("prompt image normalization", () => {
	it("normalizes canonical images by sniffed bytes, not declared MIME", async () => {
		const input = [attach(await png(), "image/gif")];
		const copy = structuredClone(input);
		const [out] = await normalizePromptImages(input);
		expect(await sharp(Buffer.from(out?.data ?? "", "base64")).metadata()).toMatchObject({ width: 3, height: 2 });
		expect(input).toEqual(copy);
	});

	it.each(["", "not base64!", "QUJD\n", "QUJ", "QUJD=", " QUJD"])("rejects invalid base64 %j", async (data) => {
		await expect(normalizePromptImages([{ mimeType: "image/png", data }])).rejects.toThrow(/base64/i);
	});

	it("rejects non-image bytes", async () => {
		await expect(normalizePromptImages([attach(Buffer.from("hello"))])).rejects.toThrow(/Invalid image/);
	});

	it("rejects more than the image count limit", async () => {
		const normalize = fake(1);
		const images = Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => attach(Buffer.from("a")));
		await expect(normalizePromptImages(images, { normalize })).rejects.toThrow(/at most 20/);
		expect(normalize).not.toHaveBeenCalled();
	});

	it("rejects oversized encoded data before decoding", async () => {
		const spy = vi.spyOn(Buffer, "from");
		const data = "A".repeat(Math.ceil((MAX_IMAGE_INPUT_BYTES * 4) / 3) + 8);
		await expect(normalizePromptImages([{ mimeType: "image/png", data }])).rejects.toThrow(/20 MiB/);
		expect(spy.mock.calls.some(([value]) => value === data)).toBe(false);
		spy.mockRestore();
	});

	it("rejects decoded bytes over the input limit", async () => {
		const normalize = fake(1);
		const image = attach(Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1));
		expect(image.data.length).toBe(Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4);
		await expect(normalizePromptImages([image], { normalize })).rejects.toThrow(/20 MiB/);
		expect(normalize).not.toHaveBeenCalled();
	});

	it("limits the aggregate normalized size", async () => {
		const count = MAX_PROMPT_IMAGE_BYTES / MAX_IMAGE_BYTES;
		const image = attach(await png());
		const images = Array.from({ length: count }, () => image);
		await expect(normalizePromptImages(images, { normalize: fake(MAX_IMAGE_BYTES) })).resolves.toHaveLength(count);
		await expect(normalizePromptImages([...images, image], { normalize: fake(MAX_IMAGE_BYTES) })).rejects.toThrow(
			/total/i,
		);
	});

	it("normalizes sequentially and stops when aborted", async () => {
		const controller = new AbortController();
		const normalize = fake(1);
		normalize.mockImplementationOnce(async () => {
			controller.abort(new Error("canceled"));
			return { image: { mimeType: "image/png", data: "AA==" }, width: 1, height: 1, animated: false };
		});
		const images = [attach(Buffer.from("a")), attach(Buffer.from("b"))];
		await expect(normalizePromptImages(images, { normalize, signal: controller.signal })).rejects.toThrow("canceled");
		expect(normalize).toHaveBeenCalledTimes(1);
		const before = new AbortController();
		before.abort(new Error("early"));
		await expect(normalizePromptImages(images, { normalize, signal: before.signal })).rejects.toThrow("early");
		expect(normalize).toHaveBeenCalledTimes(1);
	});
});
