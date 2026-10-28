import { mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager as runtime } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { McpManager } from "../src/mcp/manager.ts";
import { createMcpTools } from "../src/mcp/tools.ts";
import { createScratchDir, createScratchDirSync, systemTmpdir } from "../src/scratch.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { isInsideSandbox, Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import { createWebFetchTool } from "../src/tools/web-fetch.ts";
import { removeShortRoots, shortRoot } from "./short-root.ts";

// Registered first, so it runs after the file's own clean-up: nothing a test made is left behind, even when it failed.
afterEach(async () => {
	expect(await removeShortRoots()).toEqual([]);
});

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { resolve, reject, promise };
};
const drain = async () => {
	for (let n = 0; n < 30; n++) await new Promise<void>((resolve) => setImmediate(resolve));
};
let root: string;
let original: string | undefined;
let long: string;
let socketRootDir: string;
let realTmpdir: typeof tmpdir;
beforeEach(async () => {
	original = process.env.TMPDIR;
	realTmpdir = tmpdir;
	root = await shortRoot("atelier-deadline-");
	long = join(root, "x".repeat(90));
	socketRootDir = join(root, "s");
	await mkdir(long);
	await mkdir(socketRootDir);
	process.env.TMPDIR = long;
});
afterEach(() => {
	if (original === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = original;
});
function held(timeout = 1000) {
	const began = deferred();
	const end = deferred();
	const settled = deferred();
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {
			began.resolve();
			try {
				await end.promise;
			} finally {
				settled.resolve();
			}
		},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot: socketRootDir, startTimeoutMs: timeout });
	return { sandbox, began, end, settled };
}
it("updates a pre-existing ESM named import but keeps scratch and bash spills in the original folder", async () => {
	const h = held();
	const ready = h.sandbox.status();
	await h.began.promise;
	let made = false;
	const scratch = createScratchDir("session").then((value) => {
		made = true;
		return value;
	});
	try {
		expect(tmpdir()).toBe(join(socketRootDir, `atelier-${process.getuid?.() ?? 0}`));
		expect(os.tmpdir()).toBe(tmpdir());
		expect(process.env.TMPDIR).toBe(long);
		expect(systemTmpdir()).toBe(long);
		const synchronous = createScratchDirSync("bash");
		expect(synchronous.path.startsWith(`${long}/`)).toBe(true);
		const result = await createBashTool({ sandbox: new Sandbox({ platform: "linux" }) }).execute(
			{ command: "printf '%110000s' x", unsandboxed: true },
			{ cwd: root },
		);
		expect(result.ok).toBe(true);
		expect(result.fullOutputPath?.startsWith(`${long}/atelier-bash-`)).toBe(true);
		await drain();
		expect(made).toBe(false);
		expect(await readdir(tmpdir())).toEqual([]);
	} finally {
		h.end.resolve();
		await ready;
	}
	expect((await scratch).path.startsWith(`${long}/atelier-session-`)).toBe(true);
	expect(tmpdir).toBe(realTmpdir);
	expect(os.tmpdir).toBe(realTmpdir);
	expect(tmpdir()).toBe(long);
});
it("keeps MCP binary attachments outside the borrowed folder", async () => {
	const h = held();
	const ready = h.sandbox.status();
	await h.began.promise;
	try {
		const manager = {
			hide: (text: string) => text,
			call: async () => ({ content: [{ type: "image", mimeType: "image/png", data: "eA==" }] }),
		} as unknown as McpManager;
		const call = createMcpTools(manager).find((tool) => tool.name === "mcp_call");
		if (!call) throw new Error("missing call");
		const result = await call.execute({ server: "s", tool: "t" }, { cwd: root });
		expect(result.output).toContain(`saved to ${long}/mcp-`);
		expect(await readdir(tmpdir())).toEqual([]);
	} finally {
		h.end.resolve();
		await ready;
	}
});
it("web_fetch uses no borrowed temporary files", async () => {
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "text/plain");
		response.end("local page");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no address");
	const h = held();
	const ready = h.sandbox.status();
	await h.began.promise;
	try {
		const result = await createWebFetchTool({ allowLoopback: true }).execute(
			{ url: `http://127.0.0.1:${address.port}/` },
			{ cwd: root },
		);
		expect(result.output).toBe("local page");
		expect(await readdir(tmpdir())).toEqual([]);
	} finally {
		h.end.resolve();
		await ready;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
it.each(["resolve", "reject"] as const)(
	"restores named tmpdir and releases scratch after a deadline, including late %s",
	async (how) => {
		const h = held(30);
		const ready = h.sandbox.status();
		await h.began.promise;
		const scratch = createScratchDir("session");
		expect(await ready).toEqual({ available: false, failed: true, reason: "the sandbox did not start within 0.03 s" });
		expect(tmpdir).toBe(realTmpdir);
		expect(tmpdir()).toBe(long);
		expect(process.env.TMPDIR).toBe(long);
		expect((await scratch).path.startsWith(`${long}/`)).toBe(true);
		if (how === "resolve") h.end.resolve();
		else h.end.reject(new Error("late failure"));
		await h.settled.promise;
		await drain();
		expect(tmpdir).toBe(realTmpdir);
		expect(await h.sandbox.status()).toEqual({
			available: false,
			failed: true,
			reason: "the sandbox did not start within 0.03 s",
		});
	},
);
it("restores the named tmpdir binding when reset aborts startup", async () => {
	const h = held();
	const ready = h.sandbox.status();
	await h.began.promise;
	await h.sandbox.reset();
	expect(await ready).toEqual({
		available: false,
		failed: true,
		reason: "the sandbox was reset while it was starting",
	});
	expect(tmpdir).toBe(realTmpdir);
	expect((await createScratchDir("session")).path.startsWith(`${long}/`)).toBe(true);
	h.end.resolve();
	await h.settled.promise;
	await drain();
	expect(tmpdir).toBe(realTmpdir);
});
it.skipIf(process.platform !== "darwin" || isInsideSandbox())(
	"cleans the real runtime's proxies when an initializer settles after its deadline",
	async () => {
		const realReady = deferred();
		const end = deferred();
		const settled = deferred();
		let resets = 0;
		const manager: SandboxManagerLike = {
			isSupportedPlatform: () => runtime.isSupportedPlatform(),
			checkDependencies: () => runtime.checkDependencies(),
			initialize: async (config, callback, monitor) => {
				try {
					await runtime.initialize(config, callback, monitor);
					realReady.resolve();
					await end.promise;
				} finally {
					settled.resolve();
				}
			},
			wrapWithSandbox: (...args) => runtime.wrapWithSandbox(...args),
			cleanupAfterCommand: () => runtime.cleanupAfterCommand(),
			reset: async () => {
				resets++;
				await runtime.reset();
			},
		};
		const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot: socketRootDir, startTimeoutMs: 1000 });
		const ready = sandbox.status();
		try {
			await realReady.promise;
			const short = join(socketRootDir, `atelier-${process.getuid?.() ?? 0}`);
			const before = await readdir(short);
			expect(before.some((name) => name.startsWith("srt-mux-"))).toBe(true);
			expect(await ready).toEqual({ available: false, failed: true, reason: "the sandbox did not start within 1 s" });
			expect(tmpdir).toBe(realTmpdir);
			expect((await createScratchDir("session")).path.startsWith(`${long}/`)).toBe(true);
			end.resolve();
			await settled.promise;
			await drain();
			await sandbox.reset();
			const files = await readdir(short);
			let reachable = false;
			const socketFile = files.find((name) => name.startsWith("srt-mux-"));
			if (socketFile) {
				const client = createConnection(join(short, socketFile));
				reachable = await new Promise<boolean>((resolve) => {
					client.once("connect", () => resolve(true));
					client.once("error", () => resolve(false));
				});
				client.destroy();
			}
			console.log("late listener reachable", reachable);
			console.log("late real runtime", {
				resets,
				proxyPort: runtime.getProxyPort(),
				socketFiles: await readdir(short),
				tmpdir: tmpdir(),
				original: long,
			});
			expect(runtime.getProxyPort()).toBeUndefined();
			expect(await readdir(short)).toEqual([]);
		} finally {
			end.resolve();
			await settled.promise;
			await runtime.reset();
		}
	},
);
