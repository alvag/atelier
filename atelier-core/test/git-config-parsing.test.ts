import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";
import { isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const digest = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

// S1(a), S2, S4: Git's accepted configuration syntax must not leave code-running files writable.
const forms = [
	["plain", "team.cfg", "../team.cfg"],
	["quoted comment", "team#cfg", '"../team#cfg"'],
	["quoted semicolon", "team;cfg", '"../team;cfg"'],
	["escaped quote", 'team"cfg', '"../team\\"cfg"'],
	["escaped tab", "team\tcfg", '"../team\\tcfg"'],
	["concatenated quotes", "team.cfg", '../"team".cfg'],
	["continuation", "team.cfg", "../team\\\n.cfg"],
	["inline section", "team.cfg", "../team.cfg"],
] as const;

it.each(forms)("protects includes with %s", async (name, path, value) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "git-parser-")));
	const cwd = join(base, "repo");
	const home = join(base, "home");
	const sandbox = new Sandbox({ home, tempDir: base });
	try {
		await mkdir(cwd);
		await mkdir(home);
		git(cwd, "init", "-q");
		const original = "[probe]\nmarker = honored\n";
		await writeFile(join(cwd, path), original);
		await appendFile(join(cwd, ".git/config"), `[include]${name === "inline section" ? " " : "\n"}path = ${value}\n`);
		expect(git(cwd, "config", "--includes", "--get", "probe.marker")).toBe("honored\n");
		const before = await digest(join(cwd, path));
		for (const tool of [createWriteTool({ home }), createEditTool({ home })]) {
			const input =
				tool.name === "write"
					? { path, content: "[core]\nfsmonitor = ./agent-script\n" }
					: { path, edits: [{ oldText: original, newText: "[core]\nfsmonitor = ./agent-script\n" }] };
			const message = `${path} is git state that runs code: the agent does not write it.`;
			expect.soft(await tool.gate?.(input, { cwd })).toEqual({ refusal: { output: message, summary: message } });
			expect.soft(await tool.execute(input, { cwd })).toMatchObject({ ok: false, output: message });
			expect.soft(await digest(join(cwd, path))).toBe(before);
			await writeFile(join(cwd, path), original);
		}
		if (process.platform === "darwin" && !isInsideSandbox()) {
			const result = await createBashTool({ sandbox }).execute({ command: `printf x > ${quote(path)}` }, { cwd });
			expect.soft(result.ok).toBe(false);
			expect.soft(result.output).toContain("Operation not permitted");
			expect.soft(await digest(join(cwd, path))).toBe(before);
		}
	} finally {
		await sandbox.reset();
		await rm(base, { recursive: true, force: true });
	}
});

// S1(a), S2: a broken include cannot disable hooks whose configured path uses valid quoting.
it.each([
	["my#hooks", '"my#hooks"'],
	["myhooks", "my\\\nhooks"],
])("keeps fallback hooks closed for %s", async (hooks, value) => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "git-fallback-parser-")));
	const home = join(base, "home");
	await mkdir(home);
	git(base, "init", "-q");
	await mkdir(join(base, hooks));
	const path = `${hooks}/pre-commit`;
	await writeFile(join(base, path), "old\n");
	await appendFile(join(base, ".git/config"), `[core]\nhooksPath = ${value}\n[include]\npath = ../broken\n`);
	await writeFile(join(base, "broken"), "[invalid\n");
	const sandbox = new Sandbox({ home, tempDir: base });
	try {
		expect(() => git(base, "rev-parse", "--git-dir")).toThrow();
		const result = await createWriteTool({ home }).execute({ path, content: "new\n" }, { cwd: base });
		expect
			.soft(result)
			.toMatchObject({ ok: false, output: `${path} is git state that runs code: the agent does not write it.` });
		expect.soft(await readFile(join(base, path), "utf8")).toBe("old\n");
	} finally {
		await sandbox.reset();
		await rm(base, { recursive: true, force: true });
	}
});

// A file git cannot read may hide any include: its directory's conventional places are protected too.
it("protects the conventional places beside an included file git cannot read", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "git-malformed-")));
	const home = join(base, "home");
	await mkdir(home);
	try {
		git(base, "init", "-q");
		await appendFile(join(base, ".git/config"), "[include]\npath = ../broken/cfg\n");
		await mkdir(join(base, "broken", "hooks"), { recursive: true });
		await writeFile(join(base, "broken", "cfg"), "[invalid\n");
		const path = "broken/hooks/pre-commit";
		const result = await createWriteTool({ home }).execute({ path, content: "x\n" }, { cwd: base });
		expect(result).toMatchObject({
			ok: false,
			output: `${path} is git state that runs code: the agent does not write it.`,
		});
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
