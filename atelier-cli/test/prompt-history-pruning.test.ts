import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptHistory } from "../src/tui/prompt-history.ts";

const faults = vi.hoisted(() => ({
	removeRecords: false,
	removeFirst: false,
	publish: false,
	scan: false,
	scanAt: 0,
	inspectPath: "",
	readPath: "",
	recordOperation: "",
	afterPublish: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const open: typeof fs.open = async (...args) => {
		if (String(args[0]) !== faults.readPath) return fs.open(...args);
		const fail = () => {
			throw Object.assign(new Error(`EACCES: record ${faults.recordOperation} refused`), { code: "EACCES" });
		};
		if (faults.recordOperation === "open") fail();
		const file = await fs.open(...args);
		if (faults.recordOperation === "stat") file.stat = async () => fail();
		if (faults.recordOperation === "chmod") file.chmod = async () => fail();
		if (faults.recordOperation === "readFile") file.readFile = async () => fail();
		if (faults.recordOperation === "close") {
			const close = file.close.bind(file);
			file.close = async () => {
				await close();
				fail();
			};
		}
		return file;
	};
	const unlink: typeof fs.unlink = async (...args) => {
		if (faults.removeRecords && String(args[0]).endsWith(".json"))
			throw Object.assign(new Error("EACCES: record deletion refused"), { code: "EACCES" });
		if (faults.removeFirst && String(args[0]).endsWith(".json")) await fs.unlink(...args);
		return fs.unlink(...args);
	};
	const rename: typeof fs.rename = async (...args) => {
		if (faults.publish) throw Object.assign(new Error("EIO: publication refused"), { code: "EIO" });
		await fs.rename(...args);
		await faults.afterPublish?.();
	};
	const readdir: typeof fs.readdir = ((...args: Parameters<typeof fs.readdir>) => {
		if (faults.scan || (faults.scanAt > 0 && --faults.scanAt === 0))
			return Promise.reject(Object.assign(new Error("EACCES: scan refused"), { code: "EACCES" }));
		return fs.readdir(...args);
	}) as typeof fs.readdir;
	const lstat: typeof fs.lstat = ((...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === faults.inspectPath)
			return Promise.reject(Object.assign(new Error("EACCES: metadata refused"), { code: "EACCES" }));
		return fs.lstat(...args);
	}) as typeof fs.lstat;
	return { ...fs, open, unlink, rename, readdir, lstat, default: { ...fs, open, unlink, rename, readdir, lstat } };
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
	faults.removeFirst = false;
	faults.publish = false;
	faults.scan = false;
	faults.scanAt = 0;
	faults.inspectPath = "";
	faults.readPath = "";
	faults.recordOperation = "";
	faults.afterPublish = undefined;
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

it("does not warn when another writer already unlinked a duplicate", async () => {
	await record(1, "same");
	await record(2, "same");
	faults.removeFirst = true;
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(history.entries).toEqual(["same"]);
	expect(warnings).toEqual([]);
	expect(await readdir(dir)).toHaveLength(1);
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

it.each(["access", "cleanup"])(
	"does not let %s failures hide later save failures or the third warning",
	async (first) => {
		await record(1, "same");
		await record(2, "same");
		if (first === "access") faults.scanAt = 2;
		else faults.removeRecords = true;
		const warnings: string[] = [];
		const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(first === "access" ? "prompt history storage is unavailable" : "could not delete");
		faults.publish = true;
		await history.add("unsaved");
		await history.add("also unsaved");
		faults.publish = false;
		expect(warnings).toHaveLength(2);
		expect(warnings[1]).toBe("prompt history is not saved: EIO: publication refused");
		if (first === "access") {
			await record(1, "same");
			faults.removeRecords = true;
		} else faults.scan = true;
		await history.add("saved");
		await history.add("saved again");
		faults.scan = false;
		expect(warnings).toHaveLength(3);
		for (const prefix of ["prompt history is not saved", "prompt history storage is unavailable", "could not delete"])
			expect(warnings.filter((message) => message.startsWith(prefix))).toHaveLength(1);
		const texts = await Promise.all(
			(await readdir(dir)).map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")).text),
		);
		expect(texts).toContain("saved");
		expect(texts).not.toContain("unsaved");
		expect(texts).not.toContain("also unsaved");
	},
);

it.each(["open", "stat", "chmod", "readFile", "close"])(
	"reports a record %s failure as access without hiding a later save failure",
	async (operation) => {
		await record(1, "blocked");
		const [name] = await readdir(dir);
		faults.readPath = join(dir, name as string);
		faults.recordOperation = operation;
		await record(2, "good");
		const warnings: string[] = [];
		const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
		expect(history.entries).toEqual(operation === "close" ? ["blocked", "good"] : ["good"]);
		expect(warnings).toEqual([`prompt history storage is unavailable: EACCES: record ${operation} refused`]);
		await history.add("fresh");
		expect(warnings).toHaveLength(1);
		faults.publish = true;
		await history.add("unsaved");
		expect(warnings).toHaveLength(2);
		expect(warnings[1]).toBe("prompt history is not saved: EIO: publication refused");
		expect(await readdir(dir)).toHaveLength(3);
	},
);

it("labels an initial listing failure as access and keeps subsequent submissions in memory", async () => {
	faults.scan = true;
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(warnings).toEqual(["prompt history storage is unavailable: EACCES: scan refused"]);
	faults.scan = false;
	await history.add("memory only");
	expect(history.entries).toEqual(["memory only"]);
	expect(await readdir(dir)).toEqual([]);
});

it("reports a post-publication readdir failure as storage access, without deletion advice", async () => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	faults.afterPublish = async () => {
		faults.afterPublish = undefined;
		faults.scan = true;
	};
	await history.add("saved");
	expect(history.entries).toEqual(["saved"]);
	expect(warnings).toEqual(["prompt history storage is unavailable: EACCES: scan refused"]);
	expect(warnings[0]).not.toMatch(/not saved|delete|manually/);
	faults.scan = false;
	expect((await PromptHistory.open(home, cwd, undefined, { readOnly: true })).entries).toEqual(["saved"]);
});

it("reports a directory replaced after publication without suggesting deletion through the symlink", async () => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	const published = join(home, "published");
	const elsewhere = join(home, "elsewhere");
	await mkdir(elsewhere);
	faults.afterPublish = async () => {
		faults.afterPublish = undefined;
		await rename(dir, published);
		await symlink(elsewhere, dir);
	};
	await history.add("saved");
	expect(history.entries).toEqual(["saved"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("prompt history storage is unavailable:");
	expect(warnings[0]).toContain(`${dir} is not a directory (symbolic links are refused)`);
	expect(warnings[0]).not.toMatch(/not saved|delete|manually/);
	const [name] = await readdir(published);
	expect(JSON.parse(await readFile(join(published, name as string), "utf8")).text).toBe("saved");
	expect(await readdir(elsewhere)).toEqual([]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
	{ target: "project", mode: 0o000 },
	{ target: "root", mode: 0o000 },
	{ target: "project", mode: 0o300 },
])("reports only storage access when $target permissions become $mode after publication", async ({ target, mode }) => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	const blocked = target === "root" ? dirname(dir) : dir;
	faults.afterPublish = async () => {
		faults.afterPublish = undefined;
		await chmod(blocked, mode);
	};
	try {
		await history.add("saved");
	} finally {
		await chmod(blocked, 0o700);
	}
	expect(history.entries).toEqual(["saved"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toMatch(/^prompt history storage is unavailable: EACCES/);
	expect(warnings[0]).not.toMatch(/not saved|could not delete|delete them manually/);
	expect((await PromptHistory.open(home, cwd, undefined, { readOnly: true })).entries).toEqual(["saved"]);
	expect((await readdir(dir)).every((name) => name.endsWith(".json"))).toBe(true);
});

it("does not clean an already published temporary through a directory replaced by a file", async () => {
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	const published = join(home, "published");
	faults.afterPublish = async () => {
		faults.afterPublish = undefined;
		await rename(dir, published);
		await writeFile(dir, "replacement");
	};
	await history.add("saved");
	expect(history.entries).toEqual(["saved"]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain(`prompt history storage is unavailable: ${dir} is not a directory`);
	expect(warnings[0]).not.toMatch(/not saved|could not delete|delete them manually/);
	expect(await readFile(dir, "utf8")).toBe("replacement");
	const [name] = await readdir(published);
	expect(JSON.parse(await readFile(join(published, name as string), "utf8")).text).toBe("saved");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"still reports an actual unlink failure after publication without claiming the prompt was not saved",
	async () => {
		const warnings: string[] = [];
		const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
		await record(1, "same");
		await record(2, "same");
		faults.afterPublish = async () => {
			faults.afterPublish = undefined;
			await chmod(dir, 0o500);
		};
		try {
			await history.add("saved");
		} finally {
			await chmod(dir, 0o700);
		}
		expect(history.entries).toEqual(["same", "saved"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not delete old prompt history entries");
		expect(warnings[0]).toMatch(/EACCES.*unlink/);
		expect(warnings[0]).not.toContain("not saved");
		expect(await readdir(dir)).toHaveLength(3);
	},
);

it.each(["scan", "metadata"])("does not turn a temporary %s failure into deletion advice", async (operation) => {
	await (await PromptHistory.open(home, cwd)).add("kept");
	const temp = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
	await writeFile(temp, "unfinished");
	if (operation === "scan") faults.scanAt = 2;
	else faults.inspectPath = temp;
	const warnings: string[] = [];
	const history = await PromptHistory.open(home, cwd, (message) => warnings.push(message));
	expect(history.entries).toEqual(["kept"]);
	expect(warnings).toEqual([`prompt history storage is unavailable: EACCES: ${operation} refused`]);
	expect(warnings[0]).not.toMatch(/not saved|delete|manually/);
	expect(await readFile(temp, "utf8")).toBe("unfinished");
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
