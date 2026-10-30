import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeImage } from "../src/images.ts";

const picture = () => sharp({ create: { width: 3, height: 2, channels: 3, background: "#2468ac" } });

describe("image normalization", () => {
	it.each(["png", "jpeg", "gif", "webp"] as const)("decodes %s and returns a bounded image", async (format) => {
		const result = await normalizeImage(await picture().toFormat(format).toBuffer());
		const bytes = Buffer.from(result.image.data, "base64");
		expect(result).toMatchObject({ width: 3, height: 2, animated: false });
		expect(await sharp(bytes).metadata()).toMatchObject({ width: 3, height: 2 });
		expect(bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(result.image.mimeType).toMatch(/^image\/(png|jpeg)$/);
	});

	it("keeps the smaller PNG or JPEG, even when both fit", async () => {
		const input = await picture().png().toBuffer();
		const png = await sharp(input)
			.rotate()
			.resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
			.png()
			.toBuffer();
		const jpeg = await sharp(input)
			.rotate()
			.resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
			.flatten({ background: "white" })
			.jpeg({ quality: 85 })
			.toBuffer();
		const { image } = await normalizeImage(input);
		expect(Buffer.from(image.data, "base64").length).toBe(Math.min(png.length, jpeg.length));
	});

	it("chooses JPEG when PNG fits but is larger", async () => {
		const raw = Buffer.alloc(64 * 64 * 3);
		let seed = 42;
		for (let index = 0; index < raw.length; index++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			raw[index] = seed >>> 24;
		}
		const input = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } })
			.png()
			.toBuffer();
		const { image } = await normalizeImage(input);
		expect(input.length).toBeLessThan(4 * 1024 * 1024);
		expect(image.mimeType).toBe("image/jpeg");
		expect(Buffer.from(image.data, "base64").length).toBeLessThan(input.length);
	});

	it("preserves alpha as PNG even when a JPEG would be smaller", async () => {
		const raw = Buffer.alloc(64 * 64 * 4);
		let seed = 42;
		for (let index = 0; index < raw.length; index++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			raw[index] = index % 4 === 3 ? (index % 8 === 3 ? 0 : 128) : seed >>> 24;
		}
		const input = await sharp(raw, { raw: { width: 64, height: 64, channels: 4 } })
			.png()
			.toBuffer();
		const jpeg = await sharp(input).flatten({ background: "white" }).jpeg({ quality: 85 }).toBuffer();
		expect(jpeg.length).toBeLessThan(input.length);
		const { image } = await normalizeImage(input);
		expect(image.mimeType).toBe("image/png");
		const bytes = Buffer.from(image.data, "base64");
		expect((await sharp(bytes).metadata()).hasAlpha).toBe(true);
		const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
		expect([...pixels].filter((_, index) => index % 4 === 3)).toEqual([...raw].filter((_, index) => index % 4 === 3));
	});

	it("applies EXIF orientation and removes metadata", async () => {
		const input = await picture().jpeg().withMetadata({ orientation: 6 }).toBuffer();
		const result = await normalizeImage(input);
		expect(result).toMatchObject({ width: 2, height: 3 });
		const metadata = await sharp(Buffer.from(result.image.data, "base64")).metadata();
		expect(metadata.exif).toBeUndefined();
		expect(metadata.orientation).toBeUndefined();
	});

	it("reduces dimensions without enlarging small pictures", async () => {
		const input = await sharp({ create: { width: 2050, height: 1, channels: 3, background: "white" } })
			.png()
			.toBuffer();
		expect(await normalizeImage(input)).toMatchObject({ width: 2048, height: 1 });
	});

	it("rejects huge decoded dimensions even in a tiny encoded file", async () => {
		const input = await picture().png().toBuffer();
		input.writeUInt32BE(10_000, 16);
		input.writeUInt32BE(5_000, 20);
		input.writeUInt32BE(crc32(input.subarray(12, 29)), 29);
		expect(input.length).toBeLessThan(200);
		await expect(normalizeImage(input)).rejects.toThrow("Image exceeds the 40,000,000-pixel limit.");
	});

	it("rejects unsupported content and oversized input", async () => {
		await expect(normalizeImage(Buffer.from("not an image"))).rejects.toThrow("Invalid image.");
		await expect(normalizeImage(Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toThrow(
			"Image exceeds the 20 MiB input limit.",
		);
	});

	it("returns only the first animation frame and reports that frames were omitted", async () => {
		const input = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
			raw: { width: 1, height: 2, pageHeight: 1, channels: 3 },
		})
			.gif()
			.toBuffer();
		expect((await sharp(input).metadata()).pages).toBe(2);
		const result = await normalizeImage(input);
		expect(result).toMatchObject({ width: 1, height: 1, animated: true });
		const pixels = await sharp(Buffer.from(result.image.data, "base64")).removeAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([255, 0, 0]);
	});

	it("rejects corrupt image bytes even when their signature is valid", async () => {
		const input = (await picture().png().toBuffer()).subarray(0, 35);
		await expect(normalizeImage(input)).rejects.toThrow("Invalid image.");
	});

	it("only accepts TIFF from the clipboard", async () => {
		const input = await picture().tiff().toBuffer();
		await expect(normalizeImage(input)).rejects.toThrow("Invalid image.");
		expect(await normalizeImage(input, { clipboard: true })).toMatchObject({ width: 3, height: 2 });
	});
});
