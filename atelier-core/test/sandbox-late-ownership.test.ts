import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

/** A root short enough for a Unix socket path: the system's temporary folder when it is short (/tmp/claude inside a sandbox), /tmp otherwise. */
const shortBase = () => (tmpdir().length <= 20 ? tmpdir() : "/tmp");

it("retains cleanup ownership of an initializer that finishes late", async () => {
	const previous = process.env.TMPDIR;
	const root = await mkdtemp(join(shortBase(), "ownership-"));
	const long = join(root, "x".repeat(80));
	await mkdir(long);
	process.env.TMPDIR = long;
	const server = createServer();
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const entering = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let finished!: () => void;
	const finishing = new Promise<void>((resolve) => {
		finished = resolve;
	});
	let resets = 0;
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {
			entered();
			await released;
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(join(root, "late.sock"), resolve);
			});
			finished();
		},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {
			resets++;
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot: root, startTimeoutMs: 30 });
	const ready = sandbox.status();
	await entering;
	const timer = setTimeout(release, 100);
	try {
		const status = await ready;
		await finishing;
		await sandbox.reset();
		console.log("ownership comparison", { status, resets, listening: server.listening, tmpdir: tmpdir() });
		expect(server.listening).toBe(false);
	} finally {
		clearTimeout(timer);
		release();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	}
});
