import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptHistory } from "../src/tui/prompt-history.ts";

const faults = vi.hoisted(() => ({ removeRecords: false, publish: false, scan: false }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const rm: typeof fs.rm = async (...args) => {
		if (faults.removeRecords && String(args[0]).endsWith(".json"))
			throw Object.assign(new Error("EACCES: record deletion refused"), { code: "EACCES" });
		return fs.rm(...args);
	};
	const rename: typeof fs.rename = async (...args) => {
		if (faults.publish) throw Object.assign(new Error("EIO: publication refused"), { code: "EIO" });
		return fs.rename(...args);
	};
	const readdir: typeof fs.readdir = ((...args: Parameters<typeof fs.readdir>) => {
		if (faults.scan) return Promise.reject(Object.assign(new Error("EACCES: scan refused"), { code: "EACCES" }));
		return fs.readdir(...args);
	}) as typeof fs.readdir;
	return { ...fs, rm, rename, readdir, default: { ...fs, rm, rename, readdir } };
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
	faults.publish = false;
	faults.scan = false;
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
	expect(warnings[0]).toContain("could not delete old prompt history entries");
	expect(warnings[0]).toContain(JSON.stringify(dir));
	expect(warnings[0]).toContain("delete them manually");
	expect(warnings[0]).not.toContain("not saved");
	await history.add("fresh");
	await history.add("again");
	expect(history.entries).toEqual(["same", "other", "fresh", "again"]);
	expect(warnings).toHaveLength(1);
	expect(await readdir(dir)).toHaveLength(5);
});

it.each(["cleanup", "save"])("keeps save and cleanup warnings independent when %s fails first", async (first) => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	for (const kind of [first, first === "cleanup" ? "save" : "cleanup", "cleanup", "save"]) {
		if (kind === "cleanup") {
			await record(1, "same");
			await record(2, "same");
			faults.removeRecords = true;
			await history.add("saved");
		} else {
			faults.publish = true;
			await history.add("not saved");
			faults.publish = false;
		}
	}
	expect(warnings).toHaveLength(2);
	expect(warnings[first === "cleanup" ? 0 : 1]).toContain("could not delete old prompt history entries");
	expect(warnings[first === "cleanup" ? 0 : 1]).toContain(JSON.stringify(dir));
	expect(warnings[first === "save" ? 0 : 1]).toBe("prompt history is not saved: EIO: publication refused");
	const texts = await Promise.all(
		(await readdir(dir)).map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")).text),
	);
	expect(texts).toContain("saved");
	expect(texts).not.toContain("not saved");
});

it("does not call a post-publication cleanup scan failure a save failure", async () => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	faults.scan = true;
	await history.add("saved");
	expect(history.entries).toEqual(["saved"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("could not delete old prompt history entries");
	expect(warnings[0]).not.toContain("not saved");
	faults.scan = false;
	expect((await PromptHistory.open(home, cwd, undefined, { readOnly: true })).entries).toEqual(["saved"]);
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
