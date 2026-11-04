import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.ts";

let home: string;
let cwd: string;
beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-fifo-home-")));
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-fifo-cwd-")));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/**
 * Runs one operation on a FIFO session file in a child Node process, so that a store that reads the FIFO without a
 * guard blocks only the child, which is killed. The child holds a nonblocking reader of the FIFO and gives back what
 * was written to it: a writer is never provided, so an unguarded read cannot be released.
 */
function onFifo(operation: "load" | "rename" | "resume") {
	const fifo = join(new SessionStore(home).folder(cwd), "fifo.jsonl");
	mkdirSync(new SessionStore(home).folder(cwd), { recursive: true });
	execFileSync("mkfifo", [fifo]);
	const before = lstatSync(fifo);
	expect(before.isFIFO()).toBe(true);
	const script = `import { constants, openSync, readSync } from "node:fs";
import { PassThrough } from "node:stream";
import { decodeServerMessage, RpcServer, SessionStore } from ${JSON.stringify(source)};
const [home, cwd, fifo, operation] = process.argv.slice(1);
const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
const store = new SessionStore(home);
let outcome;
try {
	if (operation === "load") await store.load(cwd, "fifo");
	else if (operation === "rename") await store.rename(cwd, "fifo", "named");
	else {
		const input = new PassThrough();
		const messages = [];
		const server = new RpcServer({ input, write: (line) => messages.push(decodeServerMessage(line.trimEnd())),
			createBackend: () => { throw new Error("no backend expected"); }, tools: [], systemPromptAppend: "", home });
		const done = server.run();
		input.write(JSON.stringify({ type: "command", id: "c1", command: "session.resume", sessionId: "fifo", cwd }) + "\\n");
		input.end();
		await done;
		const response = messages.find((m) => m.type === "response" && m.id === "c1");
		outcome = response.ok ? { ok: true } : { code: response.error.code, message: response.error.message };
	}
	outcome ??= { ok: true };
} catch (error) {
	outcome = { code: error.code, message: error.message };
}
const buffer = Buffer.alloc(4096);
let written = 0;
for (;;) {
	try {
		const n = readSync(reader, buffer);
		if (n === 0) break;
		written += n;
	} catch (error) {
		if (error.code === "EAGAIN") break;
		throw error;
	}
}
console.log(JSON.stringify({ ...outcome, written }));
process.exit(0);`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, home, cwd, fifo, operation], {
		encoding: "utf8",
		timeout: 10_000,
		killSignal: "SIGKILL",
	});
	// A child that was killed after its timeout was blocked reading the FIFO.
	expect({ status: child.status, signal: child.signal, stderr: child.stderr }).toEqual({
		status: 0,
		signal: null,
		stderr: "",
	});
	const after = lstatSync(fifo);
	expect(after.isFIFO()).toBe(true);
	expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
	return JSON.parse(child.stdout) as { code?: string; message?: string; written: number; ok?: true };
}

describe.skipIf(process.platform === "win32")("a session file that is a FIFO", () => {
	it.each(["load", "rename"] as const)("is rejected by %s as not a regular file, with nothing written", (operation) => {
		const result = onFifo(operation);
		expect(result).toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("not a regular file"),
			written: 0,
		});
	});

	it("is answered by session.resume with the corrupt code", () => {
		const result = onFifo("resume");
		expect(result).toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("not a regular file"),
			written: 0,
		});
	});
});

describe("a regular session file", () => {
	it("still loads, and is renamed by appending", async () => {
		const store = new SessionStore(home);
		const recorder = store.create(cwd);
		recorder.config({ backend: "claude-code", mode: "normal" });
		await recorder.flush();
		const before = await readFile(recorder.path, "utf8");
		const loaded = await store.load(cwd, recorder.id);
		expect(loaded.config).toMatchObject({ backend: "claude-code", mode: "normal" });
		expect(await readFile(recorder.path, "utf8")).toBe(before);
		await store.rename(cwd, recorder.id, "named");
		const after = await readFile(recorder.path, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect((await store.load(cwd, recorder.id)).name).toBe("named");
	});
});
