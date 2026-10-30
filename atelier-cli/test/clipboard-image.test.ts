import { runInNewContext } from "node:vm";
import { MAX_IMAGE_INPUT_BYTES } from "@atelier/core";
import { describe, expect, it, vi } from "vitest";
import { type ClipboardRunner, createClipboardImageReader } from "../src/tui/clipboard-image.ts";
import { png } from "./support/png.ts";

const image = new Uint8Array(png());
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const reader = (runner: ClipboardRunner, platform: NodeJS.Platform = "darwin") =>
	createClipboardImageReader({ runner, platform });

describe("clipboard image reader", () => {
	it("runs osascript with a bounded JXA script and decodes the base64 image", async () => {
		const runner = vi.fn<ClipboardRunner>(async () => ({ stdout: `${base64(image)}\n` }));
		const signal = new AbortController().signal;
		expect(await reader(runner)(signal)).toEqual(image);
		const [file, args, options] = runner.mock.calls[0] ?? [];
		expect(file).toBe("/usr/bin/osascript");
		expect(args?.slice(0, 2)).toEqual(["-l", "JavaScript"]);
		expect(args?.[2]).toBe("-e");
		expect(args?.[3]).toContain("NSPasteboardTypePNG");
		expect(args?.[3]).toContain("NSPasteboardTypeTIFF");
		expect(options?.signal).toBe(signal);
		expect(options?.timeout).toBeGreaterThan(0);
		expect(options?.timeout).toBeLessThanOrEqual(5_000);
		expect(options?.maxBuffer).toBeGreaterThan((MAX_IMAGE_INPUT_BYTES * 4) / 3);
		expect(options?.maxBuffer).toBeLessThan(MAX_IMAGE_INPUT_BYTES * 2);
	});

	it("returns undefined when the clipboard holds no image", async () => {
		expect(await reader(async () => ({ stdout: "\n" }))(new AbortController().signal)).toBeUndefined();
	});

	it("does not start a process outside macOS", async () => {
		const runner = vi.fn<ClipboardRunner>();
		for (const platform of ["linux", "win32"] as const)
			expect(await reader(runner, platform)(new AbortController().signal)).toBeUndefined();
		expect(runner).not.toHaveBeenCalled();
	});

	it("does not start a process when already aborted", async () => {
		const runner = vi.fn<ClipboardRunner>();
		const controller = new AbortController();
		controller.abort();
		await expect(reader(runner)(controller.signal)).rejects.toThrow(/aborted/i);
		expect(runner).not.toHaveBeenCalled();
	});

	it("rejects with the abort when the signal fires during the read", async () => {
		const controller = new AbortController();
		const runner: ClipboardRunner = (_file, _args, { signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
			});
		const pending = reader(runner)(controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/Could not read the clipboard image.*aborted/i);
	});

	it("never returns bytes after cancellation, even if the runner resolves", async () => {
		const controller = new AbortController();
		const runner: ClipboardRunner = async () => {
			controller.abort();
			return { stdout: base64(image) };
		};
		await expect(reader(runner)(controller.signal)).rejects.toThrow(/aborted/i);
	});

	it("rejects non-canonical base64 output", async () => {
		await expect(reader(async () => ({ stdout: "AB==" }))(new AbortController().signal)).rejects.toThrow(
			"The clipboard image could not be decoded.",
		);
	});

	it.each(["png", "tiff", "none", "oversized"])(
		"executes the JXA program for %s without a real clipboard",
		async (format) => {
			const probes: string[] = [];
			const encode = vi.fn(() => ({ js: base64(image) }));
			const runner: ClipboardRunner = async (_file, args) => ({
				stdout: runInNewContext(args[3] ?? "", {
					ObjC: { import: () => {} },
					$: {
						NSPasteboardTypePNG: "png",
						NSPasteboardTypeTIFF: "tiff",
						NSPasteboard: {
							generalPasteboard: {
								dataForType: (type: string) => {
									probes.push(type);
									return {
										isNil: () => type !== (format === "oversized" ? "png" : format),
										length: format === "oversized" ? MAX_IMAGE_INPUT_BYTES + 1 : image.byteLength,
										base64EncodedStringWithOptions: encode,
									};
								},
							},
						},
					},
				}),
			});
			const pending = reader(runner)(new AbortController().signal);
			if (format === "oversized") {
				await expect(pending).rejects.toThrow("20 MiB input limit");
				expect(encode).not.toHaveBeenCalled();
			} else expect(await pending).toEqual(format === "none" ? undefined : image);
			expect(probes).toEqual(format === "png" || format === "oversized" ? ["png"] : ["png", "tiff"]);
		},
	);

	it("explains a subprocess failure", async () => {
		const runner: ClipboardRunner = async () => {
			throw new Error("spawn failed");
		};
		await expect(reader(runner)(new AbortController().signal)).rejects.toThrow(
			"Could not read the clipboard image: spawn failed",
		);
	});

	it("rejects output that is not base64", async () => {
		await expect(reader(async () => ({ stdout: "not base64!" }))(new AbortController().signal)).rejects.toThrow(
			"The clipboard image could not be decoded.",
		);
	});

	it("rejects an image over the input limit", async () => {
		const big = Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1).toString("base64");
		await expect(reader(async () => ({ stdout: big }))(new AbortController().signal)).rejects.toThrow(
			"The clipboard image exceeds the 20 MiB input limit.",
		);
	});
});
