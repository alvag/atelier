import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { normalizeImage } from "../src/images.ts";

it("reports an injected codec loader failure only when an image is requested", async () => {
	const input = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
		.png()
		.toBuffer();
	let calls = 0;
	const loadSharp = async () => {
		calls++;
		throw new Error("prebuilt codec missing");
	};
	expect(calls).toBe(0);
	await expect(normalizeImage(input, { loadSharp })).rejects.toThrow(
		"image support unavailable: prebuilt codec missing",
	);
	expect(calls).toBe(1);
});

it("loads image helpers and reads text even when the native codec cannot be imported", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "image-availability-"));
	try {
		await writeFile(join(cwd, "note.txt"), "still works\n");
		const input = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		const program = `
			import { registerHooks } from "node:module";
			registerHooks({ resolve(specifier, context, next) {
				if (specifier === "sharp") throw new Error("platform codec missing");
				return next(specifier, context);
			} });
			const { imageMimeType, normalizeImage } = await import(${JSON.stringify(new URL("../src/images.ts", import.meta.url).href)});
			const { readTool } = await import(${JSON.stringify(new URL("../src/tools/read.ts", import.meta.url).href)});
			let problem;
			try { await normalizeImage(Buffer.from(process.argv[2], "base64")); }
			catch (error) { problem = error.message; }
			const result = await readTool.execute({ path: "note.txt" }, { cwd: process.argv[1] });
			console.log(JSON.stringify({ problem, result, detected: imageMimeType(Buffer.from([0xff, 0xd8, 0xff])) }));
		`;
		const output = execFileSync(
			process.execPath,
			["--input-type=module", "-e", program, cwd, input.toString("base64")],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(output)).toMatchObject({
			detected: "image/jpeg",
			problem: "image support unavailable: platform codec missing",
			result: { ok: true, output: "1\tstill works" },
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
