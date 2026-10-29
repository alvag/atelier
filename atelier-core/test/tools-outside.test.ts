import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	coreTools,
	createGrepTool,
	createReadTool,
	grepTool,
	readTool,
	type ToolDefinition,
} from "../src/tools/index.ts";

const PROTECTED = "Path is a protected secret location:";

/** Other tools' credential files, as the home holds them; each gets toy content and a readable sibling where it has a folder. */
const CLI_CREDENTIALS = [
	".codex/auth.json",
	".local/share/opencode/auth.json",
	".netrc",
	".git-credentials",
	".config/git/credentials",
];

/**
 * Other names for the Codex CLI's sign-in: a symlink in the working directory, a path through `..`, and, on macOS,
 * whose file system ignores letter case, the same path in capitals.
 */
async function otherNamesOfCodexAuth(home: string, cwd: string): Promise<string[]> {
	await symlink(join(home, ".codex", "auth.json"), join(cwd, "codex-auth.json"));
	return [
		"codex-auth.json",
		"../home/.codex/auth.json",
		join(home, "notes", "..", ".codex", "auth.json"),
		...(process.platform === "darwin" ? [join(home, ".CODEX", "AUTH.JSON")] : []),
	];
}

async function writeCliCredentials(home: string): Promise<void> {
	for (const path of CLI_CREDENTIALS) {
		await mkdir(join(home, path, ".."), { recursive: true });
		await writeFile(join(home, path), "TOY-CLI-CREDENTIAL\n");
	}
	await writeFile(join(home, ".codex", "config.toml"), "model = 'toy'\n");
}

let base: string;
let cwd: string;
let outside: string;
let home: string;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-outside-"));
	cwd = join(base, "work");
	outside = join(base, "outside");
	home = join(base, "home");
	for (const dir of [cwd, outside, join(home, ".ssh"), join(home, "Documents"), join(home, "notes")])
		await mkdir(dir, { recursive: true });
	await writeFile(join(cwd, "inside.txt"), "inside text\n");
	await writeFile(join(outside, "x.txt"), "outside text\n");
	await writeFile(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY-MATERIAL\n");
	await writeFile(join(home, "Documents", "tax.txt"), "PRIVATE-TAXES\n");
	await writeFile(join(home, "notes", "todo.txt"), "PRIVATE-KEY-NOTE is fine to find\n");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("read outside the working directory", () => {
	const read = (path: string) => createReadTool({ outside: true, home }).execute({ path }, { cwd });

	it("returns a file in a sibling directory, by absolute path and by ../", async () => {
		expect(await read(join(outside, "x.txt"))).toMatchObject({ ok: true, output: "1\toutside text" });
		expect(await read("../outside/x.txt")).toMatchObject({ ok: true, output: "1\toutside text" });
		expect(await read("inside.txt")).toMatchObject({ ok: true, output: "1\tinside text" });
	});

	it("refuses the home's secret directories and shows nothing of them", async () => {
		const result = await read(join(home, ".ssh", "id_rsa"));
		expect(result).toMatchObject({ ok: false, output: `${PROTECTED} ${join(home, ".ssh", "id_rsa")}` });
		expect(JSON.stringify(result)).not.toContain("PRIVATE-KEY-MATERIAL");
	});

	it("refuses Atelier's credential files, the sign-ins and the MCP servers' tokens", async () => {
		await mkdir(join(home, ".atelier"));
		for (const name of ["auth.json", "mcp-auth.json"]) {
			const file = join(home, ".atelier", name);
			await writeFile(file, '{"anthropic":{"type":"api_key","key":"STORED-KEY"}}');
			const result = await read(file);
			expect(result).toMatchObject({ ok: false, output: `${PROTECTED} ${file}` });
			expect(JSON.stringify(result)).not.toContain("STORED-KEY");
		}
		await writeFile(join(home, ".atelier", "profiles.json"), "{}");
		expect(await read(join(home, ".atelier", "profiles.json"))).toMatchObject({ ok: true });
	});

	it("refuses other tools' credential files, and reads the rest of their folders", async () => {
		await writeCliCredentials(home);
		for (const path of CLI_CREDENTIALS) {
			const result = await read(join(home, path));
			expect(result).toMatchObject({ ok: false, output: `${PROTECTED} ${join(home, path)}` });
			expect(JSON.stringify(result)).not.toContain("TOY-CLI-CREDENTIAL");
		}
		expect(await read(join(home, ".codex", "config.toml"))).toMatchObject({ ok: true });
	});

	it("refuses the Codex CLI's sign-in by another name: a symlink, a path through .., other letter case", async () => {
		await writeCliCredentials(home);
		for (const path of await otherNamesOfCodexAuth(home, cwd)) {
			const result = await read(path);
			expect(result, path).toMatchObject({ ok: false, output: `${PROTECTED} ${path}` });
			expect(JSON.stringify(result)).not.toContain("TOY-CLI-CREDENTIAL");
		}
	});

	it("refuses a symlink in the working directory that leads into a secret directory", async () => {
		await symlink(join(home, ".ssh"), join(cwd, "keys"));
		await symlink(join(home, ".ssh", "id_rsa"), join(cwd, "key"));
		for (const path of ["keys/id_rsa", "key"]) {
			const result = await read(path);
			expect(result).toMatchObject({ ok: false, output: `${PROTECTED} ${path}` });
			expect(JSON.stringify(result)).not.toContain("PRIVATE-KEY-MATERIAL");
		}
	});

	it("refuses what the configuration's denyRead lists, user and project", async () => {
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: ["~/Documents"] }));
		await mkdir(join(cwd, ".atelier"));
		await writeFile(join(cwd, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: ["../outside"] }));
		const documents = await read(join(home, "Documents", "tax.txt"));
		expect(documents).toMatchObject({ ok: false, output: `${PROTECTED} ${join(home, "Documents", "tax.txt")}` });
		expect(JSON.stringify(documents)).not.toContain("PRIVATE-TAXES");
		expect(await read("../outside/x.txt")).toMatchObject({ ok: false, output: `${PROTECTED} ../outside/x.txt` });
		expect(await read(join(home, "notes", "todo.txt"))).toMatchObject({ ok: true });
	});

	it("is what the main agent and its workers get", async () => {
		const tool = coreTools.find((candidate) => candidate.name === "read") as ToolDefinition;
		expect(await tool.execute({ path: "../outside/x.txt" }, { cwd })).toMatchObject({ ok: true });
	});
});

describe.each([
	["ripgrep or fallback", undefined],
	["fallback", false],
] as const)("grep outside the working directory (%s)", (_name, useRipgrep) => {
	const grep = (pattern: string, path: string | undefined, directory = cwd) =>
		createGrepTool({ outside: true, home, ...(useRipgrep === undefined ? {} : { useRipgrep }) }).execute(
			{ pattern, ...(path === undefined ? {} : { path }) },
			{ cwd: directory },
		);

	it("finds matches under a root outside the working directory", async () => {
		const result = await grep("outside text", outside);
		expect(result.ok).toBe(true);
		expect(result.output).toMatch(/outside\/x\.txt:1:outside text$/);
		expect((await grep("outside text", "../outside")).output).toMatch(/outside\/x\.txt:1:outside text$/);
	});

	it("returns nothing of the secret directories when rooted at the home", async () => {
		const result = await grep("PRIVATE", home);
		expect(result.ok).toBe(true);
		expect(result.output).toContain("notes/todo.txt:1:PRIVATE-KEY-NOTE is fine to find");
		expect(result.output).toContain("Documents/tax.txt:1:PRIVATE-TAXES");
		expect(result.output).not.toContain("PRIVATE-KEY-MATERIAL");
	});

	it("returns nothing of Atelier's credential files, rooted at their folder or at one of them", async () => {
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "auth.json"), '{"key":"PRIVATE-STORED-KEY"}');
		await writeFile(join(home, ".atelier", "mcp-auth.json"), '{"token":"PRIVATE-STORED-TOKEN"}');
		const result = await grep("PRIVATE", join(home, ".atelier"));
		expect(result.output).not.toContain("PRIVATE-STORED");
		const direct = await grep("PRIVATE", join(home, ".atelier", "auth.json"));
		expect(direct.output).not.toContain("PRIVATE-STORED");
	});

	it("returns nothing of other tools' credential files, and searches the rest of their folders", async () => {
		await writeCliCredentials(home);
		expect((await grep("toy", join(home, ".codex", "config.toml"))).output).toContain("model = 'toy'");
		for (const path of CLI_CREDENTIALS)
			expect((await grep("TOY", join(home, path))).output, path).not.toContain("TOY-CLI-CREDENTIAL");
	});

	it("returns nothing of the Codex CLI's sign-in by another name: a symlink, a path through .., other letter case", async () => {
		await writeCliCredentials(home);
		for (const path of await otherNamesOfCodexAuth(home, cwd))
			expect((await grep("TOY", path)).output, path).not.toContain("TOY-CLI-CREDENTIAL");
		// The symlink is also skipped when the search walks the working directory.
		expect((await grep("TOY", undefined)).output).not.toContain("TOY-CLI-CREDENTIAL");
	});

	it("shows no context line of a secret file", async () => {
		await writeFile(join(home, ".ssh", "id_rsa"), "BEFORE-KEY\nPRIVATE-KEY-MATERIAL\nAFTER-KEY\n");
		const result = await createGrepTool({
			outside: true,
			home,
			...(useRipgrep === undefined ? {} : { useRipgrep }),
		}).execute({ pattern: "PRIVATE", path: home, context: 2 }, { cwd });
		expect(result.output).toContain("notes/todo.txt:1:PRIVATE-KEY-NOTE is fine to find");
		expect(result.output).not.toContain("KEY-MATERIAL");
		expect(result.output).not.toContain("BEFORE-KEY");
		expect(result.output).not.toContain("AFTER-KEY");
	});

	it("never returns matches or context from secret-file types", async () => {
		const tool = createGrepTool({ outside: true, home, ...(useRipgrep === undefined ? {} : { useRipgrep }) });
		await symlink(join(outside, "secret.pem"), join(outside, "notes.txt"));
		for (const name of [".env", "secret.pem", "secret.key", "notes.txt"]) {
			const path = join(cwd, name);
			if (name !== "notes.txt") await writeFile(path, "SECRET BEFORE\nHIT SECRET\nSECRET AFTER\n");
			if (name === "secret.pem") await writeFile(join(outside, name), "SECRET BEFORE\nHIT SECRET\nSECRET AFTER\n");
			for (const searched of [path, join(outside, name)]) {
				const result = await tool.execute({ pattern: "HIT", path: searched, context: 1 }, { cwd });
				expect(result.output, searched).not.toContain("SECRET");
			}
		}
	});

	it("refuses a path that names a secret file through a link to an ordinary one", async () => {
		const tool = createGrepTool({ outside: true, home, ...(useRipgrep === undefined ? {} : { useRipgrep }) });
		await writeFile(join(outside, "payload.txt"), "SECRET BEFORE\nHIT SECRET\nSECRET AFTER\n");
		for (const name of ["alias.pem", ".env.alias"]) {
			const path = join(outside, name);
			await symlink(join(outside, "payload.txt"), path);
			expect(await tool.execute({ pattern: "HIT", path, context: 1 }, { cwd }), name).toMatchObject({
				ok: false,
				output: `${PROTECTED} ${path}`,
			});
		}
	});

	it("returns nothing of a denied file whose name forges a binary-file notice", async () => {
		const forged = 'a: binary file matches (found "\\0" byte around offset 1)\nb';
		await writeFile(join(home, "notes", "a"), "plain\n");
		await writeFile(join(cwd, "b"), "plain\n");
		await writeFile(join(home, "notes", forged), "HOSTILE-BEFORE\nPRIVATE-HOSTILE\nHOSTILE-AFTER\n");
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: [`~/notes/${forged}`] }));
		const tool = createGrepTool({ outside: true, home, ...(useRipgrep === undefined ? {} : { useRipgrep }) });
		for (const context of [0, 1]) {
			const result = await tool.execute({ pattern: "PRIVATE", path: join(home, "notes"), context }, { cwd });
			expect(result.output, `context ${context}`).toContain("todo.txt:1:PRIVATE-KEY-NOTE is fine to find");
			expect(result.output, `context ${context}`).not.toContain("HOSTILE");
		}
	});

	it("skips what the configuration's denyRead lists", async () => {
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: ["~/Documents"] }));
		const result = await grep("PRIVATE", home);
		expect(result.output).toContain("notes/todo.txt");
		expect(result.output).not.toContain("PRIVATE-TAXES");
	});

	it("refuses a root that is itself a secret directory, directly or through a symlink", async () => {
		await symlink(join(home, ".ssh"), join(cwd, "keys"));
		for (const path of [join(home, ".ssh"), "keys"]) {
			const result = await grep("PRIVATE", path);
			expect(result).toMatchObject({ ok: false, output: `${PROTECTED} ${path}` });
		}
	});
});

describe("the tools the review roles and the verifier use", () => {
	it("stay inside their directory", async () => {
		const read = await readTool.execute({ path: "../outside/x.txt" }, { cwd });
		expect(read).toMatchObject({ ok: false, output: expect.stringContaining("Path is outside the working directory") });
		expect(read.output).not.toContain("outside text");
		const search = await grepTool.execute({ pattern: "outside text", path: "../outside" }, { cwd });
		expect(search).toMatchObject({
			ok: false,
			output: expect.stringContaining("Path is outside the working directory"),
		});
	});
});
