import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptHistory } from "../src/tui/prompt-history.ts";

const faults = vi.hoisted(() => ({ removeRecords: false }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const rm: typeof fs.rm = async (...args) => {
		if (faults.removeRecords && String(args[0]).endsWith(".json"))
			throw Object.assign(new Error("EACCES: record deletion refused"), { code: "EACCES" });
		return fs.rm(...args);
	};
	return { ...fs, rm, default: { ...fs, rm } };
});

let home: string;
let cwd: string;
let dir: string;
beforeEach(async () => {
	home = await mkdtemp(join(fileURLToPath(new URL("../../", import.meta.url)), ".test-history-fault-"));
	cwd = join(home, "project");
	await mkdir(cwd);
	await PromptHistory.open(home, cwd);
	const root = join(home, ".atelier", "prompt-history");
	const [project] = await readdir(root);
	dir = join(root, project as string);
});
afterEach(async () => {
	faults.removeRecords = false;
	await rm(home, { recursive: true, force: true });
});

async function record(createdAt: number, text: string): Promise<void> {
	await writeFile(
		join(dir, `${String(createdAt).padStart(15, "0")}-${randomUUID()}.json`),
		JSON.stringify({ version: 1, createdAt, text }),
	);
}

it("warns once for failed duplicate cleanup without losing recall or blocking new submissions", async () => {
	await record(1, "same");
	await record(2, "same");
	await record(3, "other");
	faults.removeRecords = true;
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(history.entries).toEqual(["same", "other"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toMatch(/prompt history is not saved: .*EACCES/);
	await history.add("fresh");
	await history.add("again");
	expect(history.entries).toEqual(["same", "other", "fresh", "again"]);
	expect(warnings).toHaveLength(1);
	expect(await readdir(dir)).toHaveLength(5);
});

it("warns once when an old over-limit record cannot be removed", async () => {
	for (let index = 0; index < 101; index++) await record(index, `p${index}`);
	faults.removeRecords = true;
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(history.entries).toHaveLength(100);
	expect(history.entries[0]).toBe("p1");
	expect(warnings).toHaveLength(1);
	await history.add("latest");
	expect(history.entries).toHaveLength(100);
	expect(history.entries.at(-1)).toBe("latest");
	expect(warnings).toHaveLength(1);
	expect(await readdir(dir)).toHaveLength(102);
});
