import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, type FakeStep, Session } from "../src/index.ts";
import type { McpManager } from "../src/mcp/manager.ts";
import { ProcessGroupTransport } from "../src/mcp/stdio.ts";
import { createMcpTools } from "../src/mcp/tools.ts";
import { connectEngram } from "../src/memory/engram.ts";
import * as scratch from "../src/scratch.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

let root: string;
let original: string | undefined;
let long: string;
let socketRoot: string;
const uid = process.getuid?.() ?? 0;
const sessions: Session[] = [];
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const drain = async () => {
	for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};
const call = (input: Record<string, string | boolean>, callId = "c1"): FakeStep => ({
	toolCall: { tool: "bash", input, callId },
});
const collect = async (session: Session) => {
	for await (const _event of session.send("go")) {
	}
};
function held() {
	const entered = deferred<void>();
	const end = deferred<void>();
	const seen: string[] = [];
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {
			seen.push(tmpdir());
			entered.resolve();
			await end.promise;
		},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return { manager, entered, end, seen };
}
const start = (manager: SandboxManagerLike) =>
	new Sandbox({ platform: "darwin", manager, socketRoot, outside: () => false });
const hash = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
beforeEach(async () => {
	original = process.env.TMPDIR;
	root = await mkdtemp(join(tmpdir(), "start-probe-"));
	long = join(root, "a".repeat(80));
	socketRoot = join(root, "s");
	await mkdir(long);
	await mkdir(socketRoot);
	process.env.TMPDIR = long;
});
afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()));
	if (original === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = original;
	await rm(root, { recursive: true, force: true });
});
describe("short socket folder validation (request 1)", () => {
	it.each(["file", "symlink", "0755", "0770"])(
		"rejects a pre-created %s without changing its contents or TMPDIR",
		async (kind) => {
			const short = join(socketRoot, `atelier-${uid}`);
			const marker = join(root, "marker");
			await writeFile(marker, "unchanged\n");
			if (kind === "file") await writeFile(short, "not a directory\n");
			else if (kind === "symlink") await symlink(root, short);
			else {
				await mkdir(short, { mode: 0o700 });
				await chmod(short, kind === "0755" ? 0o755 : 0o770);
			}
			const before = await lstat(short);
			const digest = await hash(marker);
			const h = held();
			h.end.resolve();
			expect(await start(h.manager).status()).toEqual({
				available: false,
				reason: `${short} is not a directory of this user's own (mode 0700)`,
				failed: true,
			});
			expect(h.seen).toEqual([]);
			expect(process.env.TMPDIR).toBe(long);
			expect(await hash(marker)).toBe(digest);
			const after = await lstat(short);
			expect([after.ino, after.mode, after.size]).toEqual([before.ino, before.mode, before.size]);
		},
	);
	it("creates 0700 once, restores TMPDIR, and initializes only once per Sandbox", async () => {
		const h = held();
		h.end.resolve();
		const sandbox = start(h.manager);
		expect(await Promise.all([sandbox.status(), sandbox.status()])).toEqual([{ available: true }, { available: true }]);
		expect(h.seen).toEqual([join(socketRoot, `atelier-${uid}`)]);
		expect((await lstat(join(socketRoot, `atelier-${uid}`))).mode & 0o777).toBe(0o700);
		expect(process.env.TMPDIR).toBe(long);
	});
	it.each(["initialize throws", "initialize rejects on timeout"])("restores after %s", async (message) => {
		const h = held();
		const sandbox = start(h.manager);
		const status = sandbox.status();
		await h.entered.promise;
		h.end.reject(new Error(message));
		expect(await status).toEqual({ available: false, failed: true, reason: message });
		expect(process.env.TMPDIR).toBe(long);
		expect(await sandbox.status()).toEqual({ available: false, failed: true, reason: message });
	});
});
describe("failed-start yolo approvals (request 2)", () => {
	it.each(["initialize", "dependencies", "dependency throw"])(
		"denies plain and explicit-unsandboxed retries after %s failure, with byte-identical data",
		async (how) => {
			const h = held();
			h.manager.initialize = async () => {
				throw new Error("start failed");
			};
			if (how !== "initialize")
				h.manager.checkDependencies = () => {
					if (how === "dependency throw") throw new Error("dependency failed");
					return { errors: ["dependency failed"], warnings: [] };
				};
			const marker = join(root, "marker");
			await writeFile(marker, "unchanged\n");
			const digest = await hash(marker);
			const command = `printf changed > '${marker}'`;
			const backend = new FakeBackend([
				[call({ command }), call({ command, unsandboxed: true, reason: "retry denied command" }, "c2"), finished],
			]);
			const asked: string[] = [];
			const session = await Session.start({
				backend,
				cwd: root,
				tools: [createBashTool({ sandbox: start(h.manager) })],
				permissionMode: "yolo",
				approve: async (request) => {
					asked.push(request.callId);
					return false;
				},
			});
			sessions.push(session);
			await collect(session);
			const after = await hash(marker);
			expect(asked).toEqual(["c1", "c2"]);
			expect(backend.toolResults).toEqual([
				{ ok: false, output: "The user denied this command." },
				{ ok: false, output: "The user denied this command." },
			]);
			expect(after).toBe(digest);
		},
	);
	it.each(["disabled", "linux", "nested", "noSandbox"])("keeps yolo without asking for %s", async (why) => {
		const h = held();
		h.end.resolve();
		const sandbox = new Sandbox({
			platform: why === "linux" ? "linux" : "darwin",
			manager: h.manager,
			socketRoot,
			...(why === "disabled" ? { disabled: "off" } : {}),
			...(why === "nested" ? { insideSandbox: () => true } : {}),
		});
		const backend = new FakeBackend([[call({ command: "printf safe" }), finished]]);
		const asked: string[] = [];
		const session = await Session.start({
			backend,
			cwd: root,
			tools: [createBashTool({ sandbox })],
			permissionMode: "yolo",
			noSandbox: why === "noSandbox",
			approve: async (request) => {
				asked.push(request.command);
				return false;
			},
		});
		sessions.push(session);
		await collect(session);
		expect(asked).toEqual([]);
		expect(backend.toolResults).toEqual([{ ok: true, output: "safe\n\n[exit code 0]" }]);
		expect(h.seen).toEqual([]);
	});
});
it("asks for a yolo-waived guard command after failed startup", async () => {
	const h = held();
	h.manager.initialize = async () => {
		throw new Error("failed");
	};
	const command = ["git", "push"].join(" ");
	const backend = new FakeBackend([[call({ command }), finished]]);
	const asked: string[] = [];
	const session = await Session.start({
		backend,
		cwd: root,
		tools: [createBashTool({ sandbox: start(h.manager) })],
		permissionMode: "yolo",
		approve: async (request) => {
			asked.push(request.command);
			return false;
		},
	});
	sessions.push(session);
	await collect(session);
	expect(asked).toEqual([command]);
	expect(backend.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
});

describe("process-wide TMPDIR interactions (request 1 and scratch condition)", () => {
	it.each(["unsandboxed", "noSandbox"])("preserves the user's TMPDIR in another session's %s child", async (kind) => {
		const backend = new FakeBackend([
			[
				call({
					command: 'printf "%s" "$TMPDIR"',
					...(kind === "unsandboxed" ? { unsandboxed: true, reason: "explicit outside command" } : {}),
				}),
				finished,
			],
		]);
		const session = await Session.start({
			backend,
			cwd: root,
			tools: [createBashTool({ sandbox: new Sandbox({ platform: "linux" }) })],
			permissionMode: "yolo",
			noSandbox: kind === "noSandbox",
		});
		sessions.push(session);
		const h = held();
		const pending = start(h.manager).status();
		await h.entered.promise;
		try {
			await collect(session);
		} finally {
			h.end.resolve();
			await pending;
		}
		expect(backend.toolResults).toEqual([{ ok: true, output: `${long}\n\n[exit code 0]` }]);
	});
	it("preserves TMPDIR in a concurrently started MCP stdio server", async () => {
		const h = held();
		const pending = start(h.manager).status();
		await h.entered.promise;
		const transport = new ProcessGroupTransport({
			name: "probe",
			enabled: true,
			timeoutMs: 1000,
			transport: "stdio",
			command: "/bin/sh",
			args: ["-c", `printf '{"jsonrpc":"2.0","method":"tmpdir","params":{"value":"%s"}}\n' "$TMPDIR"`],
			cwd: root,
			env: {},
		});
		const message = deferred<unknown>();
		transport.onmessage = message.resolve;
		let received: unknown;
		try {
			await transport.start();
			received = await message.promise;
		} finally {
			await transport.close();
			h.end.resolve();
			await pending;
		}
		expect(received).toEqual({ jsonrpc: "2.0", method: "tmpdir", params: { value: long } });
	});
	it("preserves TMPDIR when another session connects its Engram adapter", async () => {
		const executable = join(root, "fake-memory");
		const marker = join(root, "memory-env");
		await writeFile(
			executable,
			`#!/bin/sh\nprintf '%s' "$TMPDIR" > "${marker}"\nif [ "$1" = version ]; then printf 'engram 3.4.0\\n'; else exit 1; fi\n`,
		);
		await chmod(executable, 0o700);
		const h = held();
		const pending = start(h.manager).status();
		await h.entered.promise;
		try {
			await connectEngram({ cwd: root, command: executable }).catch(() => undefined);
		} finally {
			h.end.resolve();
			await pending;
		}
		expect(await readFile(marker, "utf8")).toBe(long);
	});
	it("keeps standalone MCP output files in the user's TMPDIR", async () => {
		const h = held();
		const pending = start(h.manager).status();
		await h.entered.promise;
		const manager = {
			call: async () => ({ content: [{ type: "text", text: "x".repeat(20_001) }] }),
			hide: (text: string) => text,
		} as unknown as McpManager;
		let path: string | undefined;
		try {
			const tool = createMcpTools(manager).find((item) => item.name === "mcp_call");
			if (!tool) throw new Error("mcp_call missing");
			path = (await tool.execute({ server: "s", tool: "t" }, { cwd: root })).fullOutputPath;
		} finally {
			h.end.resolve();
			await pending;
		}
		expect(path?.startsWith(`${long}/mcp-`)).toBe(true);
	});
	it("waits for startup before creating a Session's scratch directory", async () => {
		const h = held();
		const pending = start(h.manager).status();
		await h.entered.promise;
		let ready = false;
		const starting = Session.start({ backend: new FakeBackend([[finished]]), cwd: root, tools: [] }).then((session) => {
			sessions.push(session);
			ready = true;
			return session;
		});
		try {
			await drain();
			expect(ready).toBe(false);
		} finally {
			h.end.resolve();
			await pending;
		}
		await starting;
		expect((await readdir(long)).some((name) => name.startsWith("atelier-session-"))).toBe(true);
		expect(await readdir(join(socketRoot, `atelier-${uid}`))).toEqual([]);
	});
	it("reset releases a hung startup's global TMPDIR", async () => {
		const h = held();
		const sandbox = start(h.manager);
		const pending = sandbox.status();
		await h.entered.promise;
		let restored: string | undefined;
		try {
			await sandbox.reset();
			restored = process.env.TMPDIR;
		} finally {
			h.end.resolve();
			await pending;
		}
		expect(restored).toBe(long);
	});
	it.skipIf(!("borrowTmpdir" in scratch))(
		"serializes two borrowing writers and then admits scratch readers",
		async () => {
			const first = deferred<void>();
			const entered = deferred<void>();
			const seen: string[] = [];
			const a = scratch.borrowTmpdir(socketRoot, async () => {
				seen.push(tmpdir());
				entered.resolve();
				await first.promise;
			});
			await entered.promise;
			const b = scratch.borrowTmpdir(root, async () => {
				seen.push(tmpdir());
			});
			const reader = scratch.createScratchDir("session");
			try {
				await drain();
				expect(seen).toEqual([socketRoot]);
			} finally {
				first.resolve();
			}
			await Promise.all([a, b]);
			const made = await reader;
			expect(seen).toEqual([socketRoot, root]);
			expect(made.path.startsWith(`${long}/atelier-session-`)).toBe(true);
			expect(process.env.TMPDIR).toBe(long);
		},
	);
});
