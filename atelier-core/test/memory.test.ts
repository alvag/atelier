import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectEngram, type EngramMemory, parseObservationText } from "../src/memory/engram.ts";
import { FakeMemory, MemoryUnavailableError } from "../src/memory/port.ts";

const engramInstalled = (() => {
	try {
		execFileSync("engram", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("parseObservationText", () => {
	it("splits header, content and the trailing metadata, even when the content looks like metadata", () => {
		const text = [
			"#7 [decision] Use MCP for Engram",
			"**What**: chose MCP",
			"Session: this line is content",
			"**Why**: generic contract",
			"Session: manual-save-proj",
			"Project: proj",
			"Scope: project",
			"Topic: atelier/engram-transport",
			"Duplicates: 1",
			"Revisions: 2",
			"Created: 2026-10-22 17:15:21",
		].join("\n");
		expect(parseObservationText(text)).toEqual({
			id: 7,
			type: "decision",
			title: "Use MCP for Engram",
			content: "**What**: chose MCP\nSession: this line is content\n**Why**: generic contract",
			topicKey: "atelier/engram-transport",
		});
	});

	it("returns undefined for text it does not recognize", () => {
		expect(parseObservationText("something else")).toBeUndefined();
	});
});

describe("FakeMemory", () => {
	it("saves, upserts by topic key, searches and gets", async () => {
		const memory = new FakeMemory("proj");
		const first = await memory.save({ title: "A", type: "decision", content: "alpha", topicKey: "t/a" });
		const again = await memory.save({ title: "A2", type: "decision", content: "alpha two", topicKey: "t/a" });
		await memory.save({ title: "B", type: "bugfix", content: "beta" });
		expect(again.id).toBe(first.id);
		expect(await memory.search("alpha", 10)).toEqual([
			{ id: first.id, title: "A2", type: "decision", preview: "alpha two" },
		]);
		expect(await memory.get(first.id)).toEqual({
			id: first.id,
			title: "A2",
			type: "decision",
			content: "alpha two",
			topicKey: "t/a",
		});
		expect(await memory.get(999)).toBeUndefined();
	});
});

describe.skipIf(!engramInstalled)("EngramMemory against the real binary (temporary data dir)", () => {
	let root: string;
	let project: string;
	let memory: EngramMemory;
	let env: Record<string, string | undefined>;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "atelier-engram-"));
		project = join(root, "atelier-memory-proj");
		await mkdir(project);
		execFileSync("git", ["init", "-q"], { cwd: project });
		// ENGRAM_URL points nowhere: the adapter must drop it, and the data dir keeps the user's memory untouched.
		env = { ...process.env, ENGRAM_DATA_DIR: join(root, "data"), ENGRAM_URL: "http://127.0.0.1:9" };
		memory = await connectEngram({ cwd: project, env });
	}, 30_000);

	afterAll(async () => {
		await memory?.close();
		await rm(root, { recursive: true, force: true });
	});

	it("uses the project Engram detects from the session folder", () => {
		expect(memory.project).toBe(basename(project));
	});

	it("saves, finds with a preview, gets the exact content, and updates by topic key", async () => {
		const content = "**What**: chose MCP\nSession: this line is content\n**Why**: generic contract";
		const saved = await memory.save({ title: "Use MCP for Engram", type: "decision", content, topicKey: "atelier/x" });
		const hits = await memory.search("MCP", 5);
		expect(hits).toEqual([expect.objectContaining({ id: saved.id, title: "Use MCP for Engram", type: "decision" })]);
		expect(hits[0]?.preview).toContain("chose MCP");
		expect(await memory.get(saved.id)).toEqual({
			id: saved.id,
			title: "Use MCP for Engram",
			type: "decision",
			content,
			topicKey: "atelier/x",
		});
		const updated = await memory.save({
			title: "Use MCP for Engram",
			type: "decision",
			content: "v2",
			topicKey: "atelier/x",
		});
		expect(updated.id).toBe(saved.id);
		expect((await memory.get(saved.id))?.content).toBe("v2");
	});

	it("returns undefined for a missing entry", async () => {
		expect(await memory.get(987_654)).toBeUndefined();
	});

	it("gives a bounded context and saves a session summary", async () => {
		const context = await memory.context(300);
		expect(Buffer.byteLength(context)).toBeLessThanOrEqual(300);
		expect(context).toContain("Use MCP for Engram");
		await expect(memory.summary("## Goal\nTest the adapter")).resolves.toBeUndefined();
	});

	it("never wrote outside the temporary data dir", async () => {
		expect(await readdir(join(root, "data"))).toContain("engram.db");
	});

	it("refuses an Engram older than the minimum, with the reason", async () => {
		const fake = join(root, "old-engram");
		await writeFile(fake, '#!/bin/sh\necho "engram 3.3.9"\n');
		await chmod(fake, 0o755);
		const error = await connectEngram({ cwd: project, env, command: fake }).catch((e) => e);
		expect(error).toBeInstanceOf(MemoryUnavailableError);
		expect(error.message).toMatch(/3\.3\.9.*3\.4\.0/);
	});
});

describe("connectEngram without the binary", () => {
	it("says Engram is not installed", async () => {
		const error = await connectEngram({ cwd: tmpdir(), env: {}, command: "/nonexistent/engram" }).catch((e) => e);
		expect(error).toBeInstanceOf(MemoryUnavailableError);
		expect(error.message).toMatch(/not installed/);
	});
});

describe("memory boundary", () => {
	it("keeps Engram inside its adapter: nothing else in the code mentions it", async () => {
		const offenders: string[] = [];
		const workspace = new URL("../../", import.meta.url).pathname;
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (/\.(ts|tsx)$/.test(entry.name) && /engram/i.test(await readFile(path, "utf8")))
					offenders.push(relative(workspace, path));
			}
		};
		for (const src of ["atelier-core/src", "atelier-cli/src", "atelier-desktop/src"]) await walk(join(workspace, src));
		expect(offenders.sort()).toEqual(["atelier-core/src/memory/engram.ts", "atelier-core/src/memory/index.ts"]);
		// The module's index names the adapter only to re-export it under neutral names.
		const index = await readFile(join(workspace, "atelier-core/src/memory/index.ts"), "utf8");
		expect(index.split("\n").filter((line) => /engram/i.test(line))).toEqual([
			'export { connectEngram as connectMemory, ENGRAM_MIN_VERSION as MEMORY_MIN_VERSION } from "./engram.ts";',
		]);
	});
});
