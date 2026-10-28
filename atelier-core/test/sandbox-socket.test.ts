import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScratchDir, sweepStaleScratch } from "../src/scratch.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { isInsideSandbox, Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const onMac = process.platform === "darwin" && !isInsideSandbox();
const uid = process.getuid?.() ?? 0;

let base: string;
let original: string | undefined;
/** A temporary folder whose library socket path would not fit in the 104 bytes macOS allows. */
let longTemp: string;
/** Where the short folder for the socket goes in these tests, in place of `/tmp`. */
let socketRoot: string;

beforeEach(async () => {
	original = process.env.TMPDIR;
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-socket-")));
	longTemp = join(base, "a-temporary-folder-path-long-enough", "that-the-socket-path-cannot-fit-in-it");
	await mkdir(longTemp, { recursive: true });
	socketRoot = join(base, "s");
	await mkdir(socketRoot);
});

afterEach(async () => {
	if (original === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = original;
	await rm(base, { recursive: true, force: true });
});

/** A library whose initialize records the temporary folder it sees and waits until `release` is called. */
function heldManager(): { manager: SandboxManagerLike; seen: string[]; started: Promise<void>; release: () => void } {
	const seen: string[] = [];
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => {
		started = resolve;
	});
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		async initialize() {
			seen.push(tmpdir());
			started();
			await released;
		},
		async wrapWithSandbox(command) {
			return command;
		},
		cleanupAfterCommand() {},
		async reset() {},
	};
	return { manager, seen, started: startedPromise, release };
}

const settled = <T>(promise: Promise<T>) => {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	return () => done;
};

/** Lets every pending callback run, without a fixed delay. */
const drain = async () => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("the library's socket with a long TMPDIR", () => {
	it("starts the library with TMPDIR in a short folder of the user's own, 0700, and puts TMPDIR back", async () => {
		process.env.TMPDIR = longTemp;
		const { manager, seen, release } = heldManager();
		release();
		const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot });
		expect(await sandbox.status()).toEqual({ available: true });
		const short = join(socketRoot, `atelier-${uid}`);
		expect(seen).toEqual([short]);
		const info = await lstat(short);
		expect(info.isDirectory()).toBe(true);
		expect(info.mode & 0o777).toBe(0o700);
		expect(process.env.TMPDIR).toBe(longTemp);
	});

	it("leaves a TMPDIR that fits alone", async () => {
		process.env.TMPDIR = "/tmp";
		const { manager, seen, release } = heldManager();
		release();
		expect(await new Sandbox({ platform: "darwin", manager, socketRoot }).status()).toEqual({ available: true });
		expect(seen).toEqual(["/tmp"]);
		expect(await readdir(socketRoot)).toEqual([]);
	});

	it("puts TMPDIR back when the library fails to start", async () => {
		process.env.TMPDIR = longTemp;
		const { manager } = heldManager();
		manager.initialize = async () => {
			throw new Error("proxy could not start");
		};
		const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot });
		expect(await sandbox.status()).toEqual({ available: false, reason: "proxy could not start", failed: true });
		expect(process.env.TMPDIR).toBe(longTemp);
	});

	it("refuses a short folder that is a symbolic link", async () => {
		process.env.TMPDIR = longTemp;
		const elsewhere = join(base, "elsewhere");
		await mkdir(elsewhere, { mode: 0o700 });
		await symlink(elsewhere, join(socketRoot, `atelier-${uid}`));
		const { manager, seen, release } = heldManager();
		release();
		const status = await new Sandbox({ platform: "darwin", manager, socketRoot }).status();
		expect(status).toEqual({
			available: false,
			reason: `${join(socketRoot, `atelier-${uid}`)} is not a directory of this user's own (mode 0700)`,
			failed: true,
		});
		expect(seen).toEqual([]);
	});

	it("refuses a short folder that others can open", async () => {
		process.env.TMPDIR = longTemp;
		const short = join(socketRoot, `atelier-${uid}`);
		await mkdir(short);
		await chmod(short, 0o755);
		const { manager, release } = heldManager();
		release();
		const status = await new Sandbox({ platform: "darwin", manager, socketRoot }).status();
		expect(status).toEqual({
			available: false,
			reason: `${short} is not a directory of this user's own (mode 0700)`,
			failed: true,
		});
	});
});

describe("Atelier's temporary directories while the library starts in the short folder", () => {
	it("a scratch directory asked for meanwhile waits, and goes in the real TMPDIR", async () => {
		process.env.TMPDIR = longTemp;
		const { manager, started, release } = heldManager();
		const status = new Sandbox({ platform: "darwin", manager, socketRoot }).status();
		await started;
		const scratch = createScratchDir("session");
		const done = settled(scratch);
		await drain();
		expect(done()).toBe(false);
		release();
		await status;
		const { path } = await scratch;
		expect(path.startsWith(`${longTemp}/atelier-session-`)).toBe(true);
		expect(await readdir(join(socketRoot, `atelier-${uid}`))).toEqual([]);
	});

	it("the library waits for a scratch directory already being made", async () => {
		process.env.TMPDIR = longTemp;
		const { manager, seen, release } = heldManager();
		release();
		const scratch = createScratchDir("verify");
		const status = new Sandbox({ platform: "darwin", manager, socketRoot }).status();
		const { path } = await scratch;
		// The library started only after the directory existed, in the real TMPDIR.
		expect(path.startsWith(`${longTemp}/atelier-verify-`)).toBe(true);
		expect(await status).toEqual({ available: true });
		expect(seen).toEqual([join(socketRoot, `atelier-${uid}`)]);
	});

	it("a sweep asked for meanwhile waits, and sweeps the real TMPDIR", async () => {
		process.env.TMPDIR = longTemp;
		const stale = join(longTemp, "atelier-bash-AAAAAA");
		await mkdir(join(stale, "work"), { recursive: true });
		await writeFile(join(stale, ".atelier-owner"), JSON.stringify({ pid: 999_999_999, startedAt: 0 }));
		const { manager, started, release } = heldManager();
		const status = new Sandbox({ platform: "darwin", manager, socketRoot }).status();
		await started;
		const sweep = sweepStaleScratch({ processes: { isAlive: () => false, startedAt: async () => undefined } });
		const done = settled(sweep);
		await drain();
		expect(done()).toBe(false);
		release();
		await status;
		expect(await sweep).toEqual([stale]);
	});
});

describe.skipIf(!onMac)("the real sandbox with a long TMPDIR", () => {
	let sandbox: Sandbox | undefined;

	afterEach(async () => {
		await sandbox?.reset();
	});

	it("starts, and confines bash", async () => {
		process.env.TMPDIR = longTemp;
		const cwd = join(base, "work");
		const outside = join(base, "outside");
		await mkdir(cwd);
		await mkdir(outside);
		sandbox = new Sandbox({ home: join(base, "home") });
		expect(await sandbox.status()).toEqual({ available: true });
		const bash = createBashTool({ sandbox });
		expect((await bash.execute({ command: "echo in > inside.txt" }, { cwd })).ok).toBe(true);
		expect((await bash.execute({ command: `echo out > ${join(outside, "out.txt")}` }, { cwd })).ok).toBe(false);
		await expect(stat(join(outside, "out.txt"))).rejects.toThrow();
		expect(process.env.TMPDIR).toBe(longTemp);
	});
});
