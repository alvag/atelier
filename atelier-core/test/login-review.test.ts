import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { run } from "../../atelier-cli/src/run.ts";
import { AuthStore, authFile } from "../src/auth-store.ts";
import { createBackend } from "../src/backend-factory.ts";
import { claudeCodeAuthStatus } from "../src/claude-code-auth.ts";
import { apiKeySource, resolveApiKey } from "../src/credentials.ts";
import { FakeBackend } from "../src/fake-backend.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { createMcpTools } from "../src/mcp/tools.ts";
import { FakeMemory } from "../src/memory/port.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { createReadTool } from "../src/tools/read.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { createWebFetchTool } from "../src/tools/web-fetch.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

// Approved design (a): confinement, permissions and atomic changes; (b): secret protection;
// (d/e): fake account hand-off and hidden input. Values are inert canaries, never real key-shaped literals.
let base: string;
let home: string;
let cwd: string;
let file: string;
const canary = "REVIEW_CANARY_NOT_A_CREDENTIAL";
const hash = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "login-independent-"));
	home = join(base, "home");
	cwd = join(base, "work");
	await mkdir(home);
	await mkdir(cwd);
	file = authFile(home);
});

it("(a) repairs the existing directory and file permissions on read", async () => {
	await mkdir(join(home, ".atelier"), { mode: 0o755 });
	await writeFile(file, JSON.stringify({ anthropic: { type: "api_key", key: canary } }), { mode: 0o644 });
	new AuthStore(file).get("anthropic");
	expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect((await stat(join(home, ".atelier"))).mode & 0o777).toBe(0o700);
});

it("(a) repairs the existing directory on write", async () => {
	await mkdir(join(home, ".atelier"), { mode: 0o755 });
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary });
	expect((await stat(join(home, ".atelier"))).mode & 0o777).toBe(0o700);
});

it("(a) rejects a symlinked .atelier without creating external files", async () => {
	const elsewhere = join(base, "elsewhere");
	await mkdir(elsewhere);
	await symlink(elsewhere, join(home, ".atelier"));
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary }).catch(() => {});
	expect((await readdir(elsewhere)).length).toBe(0);
});

it("(a) does not chmod or read a symlinked auth.json target", async () => {
	const target = join(base, "unrelated.json");
	await mkdir(join(home, ".atelier"));
	await writeFile(target, "{}", { mode: 0o644 });
	const before = await hash(target);
	await symlink(target, file);
	new AuthStore(file).get("anthropic");
	const rejected = await new AuthStore(file).set("anthropic", { type: "api_key", key: canary }).then(
		() => false,
		() => true,
	);
	expect(rejected).toBe(true);
	expect(await hash(target)).toBe(before);
	expect((await stat(target)).mode & 0o777).toBe(0o644);
});

it("(a) leaves data byte-identical on lock rejection and takes a stale lock", async () => {
	const store = new AuthStore(file, { lockTimeoutMs: 60 });
	await store.set("anthropic", { type: "api_key", key: canary });
	const before = await hash(file);
	await writeFile(`${file}.lock`, "");
	const error = await store.set("other", { type: "api_key", key: "inert" }).catch((e) => e);
	expect(error.message).toBe(`${file} is locked by another Atelier (${file}.lock); try again`);
	expect(await hash(file)).toBe(before);
	const old = new Date(Date.now() - 11000);
	await utimes(`${file}.lock`, old, old);
	await store.set("other", { type: "api_key", key: "inert" });
	expect(store.providers()).toEqual(["anthropic", "other"]);
});

it("(b) rejects read/grep aliases, case variants and explicit globs; writes change nothing", async () => {
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary });
	const before = await hash(file);
	const alias = join(cwd, "alias.json");
	await symlink(file, alias);
	const read = createReadTool({ outside: true, home });
	for (const path of [file, alias, join(home, ".ATELIER", "AUTH.JSON")]) {
		const result = await read.execute({ path }, { cwd });
		expect(result.ok).toBe(false);
		expect(result.output.includes(canary)).toBe(false);
	}
	for (const useRipgrep of [true, false]) {
		const grep = createGrepTool({ outside: true, home, useRipgrep });
		for (const path of [file, alias, join(home, ".ATELIER", "AUTH.JSON"), join(home, ".atelier")]) {
			const result = await grep.execute({ pattern: "REVIEW_CANARY", path, glob: "**/*.json" }, { cwd });
			expect(result.output.includes(canary)).toBe(false);
		}
	}
	for (const tool of [createEditTool({ home }), createWriteTool({ home })]) {
		const input =
			tool.name === "edit"
				? { path: file, edits: [{ oldText: "anthropic", newText: "changed" }] }
				: { path: file, content: "changed" };
		expect((await tool.execute(input, { cwd, approvedPaths: new Set([file]) })).ok).toBe(false);
		expect(await hash(file)).toBe(before);
	}
	const web = await createWebFetchTool().execute({ url: `file://${file}` }, { cwd });
	expect(web.ok).toBe(false);
	expect(web.output).toBe("Only http and https URLs can be fetched, not file:");
});

it("(b) sandboxed bash cannot read direct, case-variant or symlink paths", async (context) => {
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary });
	const alias = join(cwd, "alias.json");
	await symlink(file, alias);
	const sandbox = new Sandbox({ home, tempDir: join(base, "temp") });
	await mkdir(join(base, "temp"));
	try {
		// Only where Seatbelt can start (not inside another sandbox), as the other sandbox tests need it.
		if (!(await sandbox.status()).available) return context.skip();
		for (const path of [file, alias, join(home, ".ATELIER", "AUTH.JSON")]) {
			const outcome = await createBashTool({ sandbox }).execute({ command: `cat '${path}'` }, { cwd });
			expect(outcome.ok).toBe(false);
			expect(outcome.output.includes(canary)).toBe(false);
		}
	} finally {
		await sandbox.reset();
	}
});

it("(a/b) a killed writer preserves auth.json but never exposes a credential-bearing temporary", async () => {
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary });
	const before = await hash(file);
	const module = new URL("../src/auth-store.ts", import.meta.url).href;
	// Kill at the actual rename boundary: the public set has written its temporary but not replaced auth.json.
	const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
 fs.renameSync = () => { process.kill(process.pid, 'SIGKILL'); }; syncBuiltinESMExports();
 const { AuthStore } = await import(${JSON.stringify(module)});
 await new AuthStore(${JSON.stringify(file)}).set('other', { type: 'api_key', key: 'inert' });`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	expect(exit.signal).toBe("SIGKILL");
	expect(await hash(file)).toBe(before);
	const folder = join(home, ".atelier", ".credentials-tmp");
	const temporaries = await readdir(folder);
	expect(temporaries.length).toBe(1);
	const target = join(folder, temporaries[0] as string);
	expect((await readFile(target, "utf8")).includes(canary)).toBe(true);
	const alias = join(cwd, "temporary-alias");
	await symlink(target, alias);
	const outcomes = [];
	for (const path of [target, alias]) {
		outcomes.push(await createReadTool({ outside: true, home }).execute({ path }, { cwd }));
		outcomes.push(
			await createGrepTool({ outside: true, home }).execute({ pattern: "REVIEW_CANARY", path, glob: "**/*" }, { cwd }),
		);
	}
	outcomes.push(
		await createGrepTool({ outside: true, home }).execute(
			{ pattern: "REVIEW_CANARY", path: folder, glob: "**/*" },
			{ cwd },
		),
	);
	outcomes.push(
		await createGrepTool({ outside: true, home, useRipgrep: false }).execute(
			{ pattern: "REVIEW_CANARY", path: target },
			{ cwd },
		),
	);
	const sandbox = new Sandbox({ home, tempDir: base });
	try {
		// Bash is checked only where Seatbelt can start (not inside another sandbox), as in the other sandbox tests.
		if ((await sandbox.status()).available)
			outcomes.push(await createBashTool({ sandbox }).execute({ command: `cat '${target}'` }, { cwd }));
		expect(outcomes.map((result) => result.output.includes(canary))).toEqual(outcomes.map(() => false));
		expect(await hash(file)).toBe(before);
	} finally {
		await sandbox.reset();
	}
});

// A stdio MCP server runs outside the sandbox with the user's rights, so its file tool can read auth.json: what it
// answers must come back with the stored keys hidden.
it("(b) an MCP filesystem tool cannot return the stored key", async () => {
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary });
	const script = `import { createInterface } from 'node:readline'; import { readFileSync } from 'node:fs';
 const lines = createInterface({input:process.stdin});
 lines.on('line', line => { const m = JSON.parse(line); if (!('id' in m)) return;
 const result = m.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'files',version:'1'}} : m.method === 'tools/list' ? {tools:[{name:'read_file',inputSchema:{type:'object',properties:{path:{type:'string'}}}}]} : m.method === 'tools/call' ? {content:[{type:'text',text:readFileSync(m.params.arguments.path,'utf8')}]} : {};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); });`;
	const manager = new McpManager({
		file: join(home, ".atelier", "mcp.json"),
		secrets: [],
		problems: [],
		servers: [
			{
				name: "files",
				transport: "stdio",
				command: process.execPath,
				args: ["--input-type=module", "-e", script],
				env: {},
				cwd,
				enabled: true,
				timeoutMs: 2000,
			},
		],
	});
	manager.start();
	await manager.ready();
	try {
		expect(manager.status()[0]?.state).toBe("connected");
		const call = createMcpTools(manager).find((tool) => tool.name === "mcp_call");
		if (call === undefined) throw new Error("mcp_call is unavailable");
		const result = await call.execute({ server: "files", tool: "read_file", arguments: { path: file } }, { cwd });
		expect(result.output.includes(canary)).toBe(false);
		// The OpenAI sign-ins' tokens, and the ones a refresh writes while the session runs, are hidden too.
		const tokens = Array.from({ length: 4 }, () => `${canary}-${randomUUID()}`);
		const store = new AuthStore(file);
		await store.set("openai-codex", { type: "oauth", access: tokens[0] ?? "", refresh: tokens[1] ?? "", expires: 1 });
		const before = await call.execute({ server: "files", tool: "read_file", arguments: { path: file } }, { cwd });
		await store.set("openai-chatgpt", { type: "oauth", access: tokens[2] ?? "", refresh: tokens[3] ?? "", expires: 1 });
		const after = await call.execute({ server: "files", tool: "read_file", arguments: { path: file } }, { cwd });
		for (const output of [before.output, after.output]) expect(output.includes(canary)).toBe(false);
		expect(after.output).toContain("openai-chatgpt");
	} finally {
		await manager.close();
	}
});

it("(e) hidden subcommand input and Ctrl+C restore raw mode without storing the cancelled key", async () => {
	const stdin = new PassThrough();
	const modes: boolean[] = [];
	let output = "";
	const exits: number[] = [];
	const pending = run(["login", "api-key", "anthropic"], {
		stdin,
		isTTY: true,
		cwd,
		home,
		env: {},
		color: false,
		setRawMode: (on) => {
			modes.push(on);
		},
		stdout: (text) => {
			output += text;
		},
		stderr: (text) => {
			output += text;
		},
		exit: (code) => {
			exits.push(code);
		},
	});
	await vi.waitFor(() => expect(output.includes("API key (hidden):")).toBe(true));
	stdin.write(`\x1b[200~${canary}\x1b[201~`);
	stdin.write("\x03");
	stdin.end();
	await pending;
	expect(output.includes(canary)).toBe(false);
	expect(modes.at(-1)).toBe(false);
	expect(exits).toEqual([130]);
	expect(
		await readFile(file).then(
			() => true,
			() => false,
		),
	).toBe(false);
});

it("(e) successful hidden line login stays out of saved sessions, backend calls and prompt capture", async () => {
	const stdin = new PassThrough();
	let output = "";
	const memory = new FakeMemory();
	const backend = new FakeBackend([], "claude-code");
	const pending = run(
		[],
		{
			stdin,
			isTTY: true,
			cwd,
			home,
			env: { ATELIER_REVIEW: "off" },
			color: false,
			tools: [],
			setRawMode: () => {},
			stdout: (text) => {
				output += text;
			},
			stderr: (text) => {
				output += text;
			},
		},
		() => backend,
		async () => memory,
	);
	await vi.waitFor(() => expect(output.endsWith("> ")).toBe(true));
	stdin.write("/login api-key anthropic\r");
	await vi.waitFor(() => expect(output.includes("API key (hidden):")).toBe(true));
	stdin.write(`\x1b[200~${canary}\x1b[201~\r`);
	await vi.waitFor(() => expect(output.includes("API key stored")).toBe(true));
	stdin.write("/exit\r");
	expect(await pending).toBe(0);
	expect(output.includes(canary)).toBe(false);
	expect(backend.prompts).toEqual([]);
	expect(memory.prompts).toEqual([]);
	expect(memory.saved).toEqual([]);
	for (const entry of await readdir(join(home, ".atelier", "sessions"), { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const text = await readFile(join(entry.parentPath, entry.name), "utf8");
		expect(text.includes(canary)).toBe(false);
	}
});

it("(a) two independent writers retain all provider changes", async () => {
	const module = new URL("../src/auth-store.ts", import.meta.url).href;
	const writers = ["left", "right"].map((name) => {
		const script = `const {AuthStore}=await import(${JSON.stringify(module)});const store=new AuthStore(${JSON.stringify(file)});for(let i=0;i<20;i++)await store.set(${JSON.stringify(name)}+i,{type:'api_key',key:'inert'});`;
		return new Promise((resolve) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
			child.once("exit", resolve);
		});
	});
	expect(await Promise.all(writers)).toEqual([0, 0]);
	expect(new AuthStore(file).providers().length).toBe(40);
});

it("(c) resolves env, stored, then fake Keychain, including blank values", async () => {
	const store = new AuthStore(file);
	await store.set("anthropic", { type: "api_key", key: canary });
	const calls: (readonly string[])[] = [];
	const runSecurity = async (args: readonly string[]) => {
		calls.push(args);
		return { code: 0, stdout: "INERT_KEYCHAIN_VALUE\n", stderr: "" };
	};
	expect(
		(await resolveApiKey({ store, env: { ANTHROPIC_API_KEY: "INERT_ENV_VALUE" }, platform: "darwin", runSecurity })) ===
			"INERT_ENV_VALUE",
	).toBe(true);
	expect(
		(await resolveApiKey({ store, env: { ANTHROPIC_API_KEY: "  " }, platform: "darwin", runSecurity })) === canary,
	).toBe(true);
	expect(calls).toEqual([]);
	await store.remove("anthropic");
	expect((await resolveApiKey({ store, env: {}, platform: "darwin", runSecurity })) === "INERT_KEYCHAIN_VALUE").toBe(
		true,
	);
	expect(await apiKeySource({ store, env: {}, platform: "darwin", runSecurity })).toBe("keychain");
	expect(calls).toEqual([
		["find-generic-password", "-s", "atelier-anthropic", "-w"],
		["find-generic-password", "-s", "atelier-anthropic"],
	]);
});

it("(e) empty piped key exits 1 and preserves existing credential bytes", async () => {
	await new AuthStore(file).set("anthropic", { type: "api_key", key: canary });
	const before = await hash(file);
	const stdin = new PassThrough();
	stdin.end("   \n");
	let output = "";
	const code = await run(["login", "api-key", "anthropic"], {
		stdin,
		isTTY: false,
		cwd,
		home,
		color: false,
		env: {},
		stdout: (t) => {
			output += t;
		},
		stderr: (t) => {
			output += t;
		},
	});
	expect(code).toBe(1);
	expect(output).toBe("Anthropic API key (hidden): \nerror: no key given; nothing changed\n");
	expect(await hash(file)).toBe(before);
});

it("(f) missing API key stops before backend start and names atelier login", async () => {
	let output = "";
	const code = await run(
		["--backend", "anthropic-api", "hello"],
		{
			stdin: new PassThrough(),
			isTTY: false,
			cwd,
			home,
			color: false,
			env: {},
			stdout: (t) => {
				output += t;
			},
			stderr: (t) => {
				output += t;
			},
		},
		() =>
			createBackend("anthropic-api", {
				resolveApiKey: () => resolveApiKey({ store: new AuthStore(file), env: {}, platform: "linux" }),
			}),
	);
	expect(code).toBe(1);
	expect(output).toBe(
		"error: No Anthropic API key. Store one with `atelier login api-key anthropic` (/login in a session), or set ANTHROPIC_API_KEY.\n",
	);
});

it("(d) missing Claude binary gives the approved reinstall diagnostic", async () => {
	const error = await claudeCodeAuthStatus({ executable: join(base, "missing-claude"), env: {} }).catch(
		(error) => error,
	);
	expect(error.message).toBe("Claude Code binary not found (reinstall Atelier)");
});

it("logout rejects an explicitly unknown provider rather than succeeding silently", async () => {
	const stdin = new PassThrough();
	stdin.end();
	let output = "";
	// An injected missing binary ensures status cannot invoke the real Claude.
	const code = await run(["logout", "api-key", "no-such-provider"], {
		stdin,
		isTTY: false,
		cwd,
		home,
		color: false,
		env: {},
		claudeCode: join(base, "missing-claude"),
		stdout: (t) => {
			output += t;
		},
		stderr: (t) => {
			output += t;
		},
	});
	expect(code === 0).toBe(false);
	expect(output.includes("unknown provider")).toBe(true);
});
