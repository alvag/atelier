import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptHistory } from "../src/tui/prompt-history.ts";

const faults = vi.hoisted(() => ({ write: "", rename: false, remove: false, collision: "" }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const isTemp = (path: unknown) => String(path).includes("/.tmp-");
	const fail = (code: string) => Object.assign(new Error(`${code}: injected storage failure`), { code });
	const open: typeof fs.open = async (...args) => {
		if (isTemp(args[0]) && faults.write === "collision") {
			faults.collision = String(args[0]);
			await fs.writeFile(args[0], "another writer", { mode: 0o600 });
			throw fail("EEXIST");
		}
		const file = await fs.open(...args);
		if (isTemp(args[0]) && faults.write === "partial")
			file.writeFile = async () => {
				await fs.writeFile(args[0], "partial private text");
				throw fail("ENOSPC");
			};
		return file;
	};
	const writeFile: typeof fs.writeFile = async (...args) => {
		if (isTemp(args[0]) && faults.write) {
			faults.collision = String(args[0]);
			await fs.writeFile(args[0], faults.write === "collision" ? "another writer" : "partial private text");
			throw fail(faults.write === "collision" ? "EEXIST" : "ENOSPC");
		}
		return fs.writeFile(...args);
	};
	const rename: typeof fs.rename = async (...args) => {
		if (faults.rename) throw fail("EIO");
		return fs.rename(...args);
	};
	const rm: typeof fs.rm = async (...args) => {
		if (faults.remove && isTemp(args[0])) throw fail("EACCES");
		return fs.rm(...args);
	};
	return { ...fs, open, writeFile, rename, rm, default: { ...fs, open, writeFile, rename, rm } };
});

let home: string;
let cwd: string;
let dir: string;
beforeEach(async () => {
	home = await mkdtemp(join(fileURLToPath(new URL("../../", import.meta.url)), ".test-history-temp-"));
	cwd = join(home, "project");
	await mkdir(cwd);
	await PromptHistory.open(home, cwd);
	const root = join(home, ".atelier", "prompt-history");
	const [project] = await readdir(root);
	dir = join(root, project as string);
});
afterEach(async () => {
	Object.assign(faults, { write: "", rename: false, remove: false, collision: "" });
	vi.restoreAllMocks();
	await rm(home, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	expect((await once(child, "close"))[0]).toBe(0);
	return child.pid as number;
}
async function temp(pid: number | undefined, old = true): Promise<string> {
	const name = `.tmp-${pid === undefined ? "" : `${pid}-`}${randomUUID()}`;
	await writeFile(join(dir, name), "private unfinished prompt", { mode: 0o600 });
	if (old) {
		const age = new Date(Date.now() - 48 * 60 * 60 * 1000);
		await utimes(join(dir, name), age, age);
	}
	return name;
}

it("removes its temporary after a partial write fails, keeping recall and the one warning", async () => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	faults.write = "partial";
	await expect(history.add("private prompt")).resolves.toBeUndefined();
	expect(history.entries).toEqual(["private prompt"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("ENOSPC");
	expect(await readdir(dir)).toEqual([]);
});

it("removes its temporary when publication fails", async () => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	faults.rename = true;
	await history.add("private prompt");
	expect(history.entries).toEqual(["private prompt"]);
	expect(warnings).toHaveLength(1);
	expect(await readdir(dir)).toEqual([]);
});

it("never removes an existing temporary it could not exclusively create", async () => {
	const history = await PromptHistory.open(home, cwd);
	faults.write = "collision";
	await history.add("private prompt");
	expect(await readdir(dir)).toHaveLength(1);
	expect(await readFile(faults.collision, "utf8")).toBe("another writer");
});

it("cleans only old dead-owner temporaries, preserving recent, live and legacy files", async () => {
	const pid = await deadPid();
	await temp(pid);
	const recent = await temp(pid, false);
	const live = await temp(process.pid);
	const legacy = await temp(undefined);
	await PromptHistory.open(home, cwd);
	expect((await readdir(dir)).sort()).toEqual([recent, live, legacy].sort());
});

it("preserves an old temporary when its owner cannot be checked", async () => {
	const orphan = await temp(await deadPid());
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("owner cannot be checked"), { code: "EPERM" });
	});
	const warnings: string[] = [];
	await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(await readdir(dir)).toEqual([orphan]);
	expect(warnings).toEqual([]);
});

it("never cleans abandoned temporaries during a read-only open", async () => {
	const orphan = await temp(await deadPid());
	await PromptHistory.open(home, cwd, undefined, { readOnly: true });
	expect(await readdir(dir)).toEqual([orphan]);
});

it("warns once on abandoned-temporary deletion failures without losing loaded prompts", async () => {
	await (await PromptHistory.open(home, cwd)).add("kept");
	const pid = await deadPid();
	await temp(pid);
	await temp(pid);
	faults.remove = true;
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(history.entries).toEqual(["kept"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("EACCES");
	expect(await readdir(dir)).toHaveLength(3);
});

it("lets a live writer publish even when its temporary has an old mtime", async () => {
	const script = `import { randomUUID } from 'node:crypto';
import { open, rename, utimes } from 'node:fs/promises';
import { join } from 'node:path';
const dir = process.argv[1];
const id = randomUUID();
const path = join(dir, '.tmp-' + process.pid + '-' + id);
const file = await open(path, 'wx', 0o600);
const createdAt = Date.now();
await file.writeFile(JSON.stringify({ version: 1, createdAt, text: 'active prompt' }));
const age = new Date(Date.now() - 48 * 60 * 60 * 1000);
await utimes(path, age, age);
const released = new Promise(resolve => process.stdin.once('end', resolve));
process.stdin.resume();
process.stdout.write('ready');
await released;
await file.close();
await rename(path, join(dir, String(createdAt).padStart(15, '0') + '-' + id + '.json'));
`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir]);
	const closed = once(child, "close");
	try {
		expect(String((await once(child.stdout, "data"))[0])).toBe("ready");
		expect((await PromptHistory.open(home, cwd)).entries).toEqual([]);
		child.stdin.end();
		expect((await closed)[0]).toBe(0);
		expect((await PromptHistory.open(home, cwd)).entries).toEqual(["active prompt"]);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await closed;
	}
}, 15000);
