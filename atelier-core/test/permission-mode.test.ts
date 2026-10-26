import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDefaultPermissionMode, writeDefaultPermissionMode } from "../src/index.ts";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-mode-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const file = () => join(home, ".atelier", "permission-mode.json");
const put = async (text: string) => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(file(), text);
};

const WRONG_KIND = 'expected kind "atelier.permission_mode" and version 1';
const WRONG_DEFAULT = '"default" must be normal, auto or yolo';

describe("readDefaultPermissionMode", () => {
	it("is normal, without a problem, when there is no file", async () => {
		expect(await readDefaultPermissionMode(home)).toEqual({ mode: "normal" });
	});

	it.each(["normal", "auto", "yolo"] as const)("reads %s from a valid file", async (mode) => {
		await put(JSON.stringify({ kind: "atelier.permission_mode", version: 1, default: mode }));
		expect(await readDefaultPermissionMode(home)).toEqual({ mode });
	});

	it.each([
		["not valid JSON", "{nope", "not valid JSON"],
		["a non-object", "[]", WRONG_KIND],
		["another kind", JSON.stringify({ kind: "atelier.profiles", version: 1, default: "yolo" }), WRONG_KIND],
		["another version", JSON.stringify({ kind: "atelier.permission_mode", version: 2, default: "yolo" }), WRONG_KIND],
		[
			"an unknown default",
			JSON.stringify({ kind: "atelier.permission_mode", version: 1, default: "strict" }),
			WRONG_DEFAULT,
		],
		["a missing default", JSON.stringify({ kind: "atelier.permission_mode", version: 1 }), WRONG_DEFAULT],
	])("falls back to normal and names the problem for %s", async (_name, text, reason) => {
		await put(text);
		expect(await readDefaultPermissionMode(home)).toEqual({
			mode: "normal",
			problem: `${file()}: ${reason}; using normal`,
		});
	});

	it("falls back to normal when the file cannot be read", async () => {
		await mkdir(file(), { recursive: true });
		const read = await readDefaultPermissionMode(home);
		expect(read.mode).toBe("normal");
		expect(read.problem?.startsWith(`${file()}: cannot read it: `)).toBe(true);
		expect(read.problem?.endsWith("; using normal")).toBe(true);
	});
});

describe("writeDefaultPermissionMode", () => {
	it("creates the folder and writes a file that reads back", async () => {
		await writeDefaultPermissionMode(home, "auto");
		expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
			kind: "atelier.permission_mode",
			version: 1,
			default: "auto",
		});
		expect(await readDefaultPermissionMode(home)).toEqual({ mode: "auto" });
	});

	it("replaces an earlier default", async () => {
		await writeDefaultPermissionMode(home, "yolo");
		await writeDefaultPermissionMode(home, "normal");
		expect(await readDefaultPermissionMode(home)).toEqual({ mode: "normal" });
	});
});
