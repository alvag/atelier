import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend } from "../src/fake-backend.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";
import { Session } from "../src/session.ts";
import { createReadTool, readTool } from "../src/tools/read.ts";

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "read-images-"));
});
afterEach(async () => {
	useModelData(new ModelData());
	await rm(cwd, { recursive: true, force: true });
});

describe("read images", () => {
	it.each(["claude-sonnet-5-5", "unlisted-model"])("routes image results through Session for %s", async (model) => {
		await writeFile(
			join(cwd, "capture"),
			await sharp({ create: { width: 2, height: 1, channels: 3, background: "red" } })
				.png()
				.toBuffer(),
		);
		const backend = new FakeBackend([[{ toolCall: { tool: "read", input: { path: "capture" } } }]], "anthropic-api");
		const session = await Session.start({ cwd, backend, model, tools: [readTool] });
		try {
			for await (const _event of session.send("Inspect the screenshot")) {
				/* consume the public event stream */
			}
			if (model === "claude-sonnet-5-5")
				expect(backend.toolResults[0]).toMatchObject({
					ok: true,
					images: [{ mimeType: "image/png", data: expect.any(String) }],
				});
			else
				expect(backend.toolResults[0]).toEqual({
					ok: false,
					output: "Image input support is unknown for anthropic-api/unlisted-model.",
				});
		} finally {
			await session.close();
		}
	});
	it.each([
		{ id: "anthropic-api", images: true },
		{ id: "anthropic-api", images: false },
		{ id: "opencode-go", images: true },
		{ id: "opencode-go", images: false },
		{ id: "openai-codex", images: true },
		{ id: "openai-codex", images: false },
	])("honors catalog image input $images for $id outside the static list", async ({ id, images }) => {
		useModelData(new ModelData({ [id]: [{ id: "catalog-model", images }] }));
		await writeFile(
			join(cwd, "capture"),
			await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
				.png()
				.toBuffer(),
		);
		const backend = new FakeBackend([[{ toolCall: { tool: "read", input: { path: "capture" } } }]], id);
		const session = await Session.start({ cwd, backend, model: "catalog-model", tools: [readTool] });
		try {
			const events = [];
			for await (const event of session.send("Inspect")) events.push(event);
			expect(backend.toolResults[0]?.ok).toBe(images);
			if (!images) {
				expect(backend.toolResults[0]).toEqual({
					ok: false,
					output: `Image input is not supported by ${id}/catalog-model.`,
				});
				expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_finished", ok: false }));
			} else expect(backend.toolResults[0]?.images).toHaveLength(1);
		} finally {
			await session.close();
		}
	});

	it("keeps protected image paths and symlinks closed", async () => {
		await mkdir(join(cwd, ".ssh"));
		await writeFile(
			join(cwd, ".ssh/capture.png"),
			await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
				.png()
				.toBuffer(),
		);
		await symlink(join(cwd, ".ssh/capture.png"), join(cwd, "alias.png"));
		for (const path of [".ssh/capture.png", "alias.png"]) {
			const result = await createReadTool({ outside: true, home: cwd }).execute({ path }, { cwd });
			expect(result).toMatchObject({ ok: false, output: expect.stringContaining("protected secret location") });
			expect(result.images).toBeUndefined();
		}
	});

	it("rejects an oversized encoded file before decoding", async () => {
		await writeFile(
			join(cwd, "capture.png"),
			await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
				.png()
				.toBuffer(),
		);
		await truncate(join(cwd, "capture.png"), 20 * 1024 * 1024 + 1);
		expect(await readTool.execute({ path: "capture.png" }, { cwd })).toMatchObject({
			ok: false,
			output: "Image exceeds the 20 MiB input limit.",
		});
	});

	it("returns pixels separately from display text, detecting content without an extension", async () => {
		await writeFile(
			join(cwd, "screenshot"),
			await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
				.png()
				.toBuffer(),
		);
		const result = await readTool.execute({ path: "screenshot" }, { cwd });
		expect(result).toMatchObject({
			ok: true,
			truncated: false,
			output: "Image: 3×2 (image/png)",
			images: [{ mimeType: "image/png", data: expect.any(String) }],
		});
		expect(result.output).not.toContain("base64");
	});

	it("rejects special files before opening them", async () => {
		execFileSync("mkfifo", [join(cwd, "capture.png")]);
		expect(await readTool.execute({ path: "capture.png" }, { cwd })).toMatchObject({
			ok: false,
			output: "Not a file: capture.png",
		});
	});

	it("keeps ordinary binary and numbered text behavior", async () => {
		await writeFile(join(cwd, "data"), Buffer.from([0, 1, 2]));
		await writeFile(join(cwd, "note"), "one\ntwo\n");
		expect(await readTool.execute({ path: "data" }, { cwd })).toMatchObject({ ok: false, output: "Binary file: data" });
		expect(await readTool.execute({ path: "note", offset: 2 }, { cwd })).toMatchObject({ ok: true, output: "2\ttwo" });
	});
});
