import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";

it.skipIf(process.platform !== "darwin" || isInsideSandbox()).each([101, 102, 103])(
	"uses the actual socket path boundary (%i bytes), with an unsafe fallback pre-created",
	async (bytes) => {
		const previous = process.env.TMPDIR;
		const root = await mkdtemp(join(process.env.REVIEW_SOCKET_ROOT ?? "/tmp", "atelier-boundary-"));
		const suffix = `/srt-mux-${process.pid}-0.sock`;
		const targetLength = bytes - Buffer.byteLength(suffix);
		const dir = join(root, "x".repeat(targetLength - Buffer.byteLength(root) - 1));
		const socketRoot = join(root, "s");
		const short = join(socketRoot, `atelier-${process.getuid?.() ?? 0}`);
		await mkdir(dir);
		await mkdir(short, { recursive: true });
		await chmod(short, 0o755);
		const sandbox = new Sandbox({ home: join(root, "home"), socketRoot });
		try {
			process.env.TMPDIR = dir;
			expect(Buffer.byteLength(join(dir, suffix.slice(1)))).toBe(bytes);
			const status = await sandbox.status();
			expect(status).toEqual({ available: true });
			expect(process.env.TMPDIR).toBe(dir);
		} finally {
			await sandbox.reset();
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			await rm(root, { recursive: true, force: true });
		}
	},
);
