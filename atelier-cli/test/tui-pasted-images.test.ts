import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import * as core from "@atelier/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { preparePastedImages } from "../src/tui/pasted-images.ts";

function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const PNG = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	pngChunk("IHDR", header),
	pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
	pngChunk("IEND", Buffer.alloc(0)),
]);
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(fileURLToPath(new URL("../../", import.meta.url)), ".test-pasted-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

it("reads a path with spaces, raw, quoted or escaped, relative or absolute", async () => {
	await mkdir(join(dir, "my shots"));
	const file = join(dir, "my shots", "a b.png");
	await writeFile(file, PNG);
	for (const text of [file, `'${file}'`, `"${file}"\n`, file.replaceAll(" ", "\\ "), "my\\ shots/a\\ b.png"]) {
		const images = await preparePastedImages(text, { cwd: dir });
		expect(images).toHaveLength(1);
		expect(images?.[0]).toMatchObject({ image: { mimeType: "image/png" }, width: 1, height: 1, animated: false });
	}
});

it("reads file URLs and home-relative paths", async () => {
	await writeFile(join(dir, "a.png"), PNG);
	expect(await preparePastedImages(pathToFileURL(join(dir, "a.png")).href, { cwd: "/" })).toHaveLength(1);
	expect(await preparePastedImages("~/a.png", { cwd: "/", home: dir })).toHaveLength(1);
});

it("reads several quoted paths", async () => {
	await writeFile(join(dir, "a.png"), PNG);
	await writeFile(join(dir, "b c.png"), PNG);
	expect(await preparePastedImages("a.png 'b c.png'", { cwd: dir })).toHaveLength(2);
});

it("leaves ordinary text, missing paths, non-images and mixed text alone", async () => {
	await writeFile(join(dir, "a.png"), PNG);
	await writeFile(join(dir, "notes.png"), "just text");
	await writeFile(join(dir, "b.txt"), "x");
	for (const text of [
		"",
		"hello world",
		Array(100).fill("ordinary text").join(" "),
		"see a.png please",
		"a.png missing.png",
		"a.png b.txt",
		"'a.png",
		"nope.png",
		"notes.png",
	])
		expect(await preparePastedImages(text, { cwd: dir })).toBeUndefined();
});

it("sniffs the bytes, not the extension", async () => {
	await writeFile(join(dir, "shot.txt"), PNG);
	const images = await preparePastedImages("shot.txt", { cwd: dir });
	expect(images?.[0]?.image.mimeType).toBe("image/png");
});

it("refuses directories and FIFOs without opening them", async () => {
	await mkdir(join(dir, "folder.png"));
	expect(await preparePastedImages("folder.png", { cwd: dir })).toBeUndefined();
	expect(spawnSync("mkfifo", [join(dir, "pipe.png")]).status).toBe(0);
	expect(await preparePastedImages("pipe.png", { cwd: dir })).toBeUndefined();
});

it("reports a corrupt image instead of attaching it", async () => {
	await writeFile(join(dir, "bad.png"), Buffer.concat([PNG.subarray(0, 12), Buffer.from("garbage")]));
	await expect(preparePastedImages("bad.png", { cwd: dir })).rejects.toThrow(/Invalid image/);
});

it("bounds the aggregate normalized bytes, accepting the exact limit", async () => {
	await writeFile(join(dir, "a.png"), PNG);
	vi.spyOn(core, "readImageFile").mockResolvedValue({
		image: { mimeType: "image/png", data: Buffer.alloc(4 * 1024 * 1024).toString("base64") },
		width: 1,
		height: 1,
		animated: false,
	});
	expect(await preparePastedImages(Array(5).fill("a.png").join(" "), { cwd: dir })).toHaveLength(5);
	await expect(preparePastedImages(Array(6).fill("a.png").join(" "), { cwd: dir })).rejects.toThrow(/20 MiB/);
});

it("accepts at most 20 images", async () => {
	await writeFile(join(dir, "a.png"), PNG);
	expect(await preparePastedImages(Array(20).fill("a.png").join(" "), { cwd: dir })).toHaveLength(20);
	for (const count of [21, 22, 100])
		await expect(preparePastedImages(Array(count).fill("a.png").join(" "), { cwd: dir })).rejects.toThrow(/at most 20/);
});
