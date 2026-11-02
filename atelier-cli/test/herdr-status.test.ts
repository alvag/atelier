import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HerdrStatusReporter, herdrPane, PANE_MARKER } from "../src/tui/herdr-status.ts";

// A socket's path holds at most 104 bytes on macOS: the test runs in its folder and names the socket relative to it.
let dir: string;
let previousDir: string;
let server: Server;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "atelier-herdr-pane-"));
	previousDir = process.cwd();
	process.chdir(dir);
	server = createServer();
	await new Promise<void>((resolve) => server.listen("herdr.sock", resolve));
});
afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	process.chdir(previousDir);
	await rm(dir, { recursive: true, force: true });
});

const inside = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "herdr.sock" };

it("finds the Herdr pane from Herdr's variables, also when an Atelier already reports it", async () => {
	expect(herdrPane(inside)).toBe("w1:p1");
	expect(herdrPane({ ...inside, HERDR_PANE_ID: " w1:p1 " })).toBe("w1:p1");
	// An Atelier started by a tool runs in the pane too, though it does not report it.
	expect(herdrPane({ ...inside, [PANE_MARKER]: "w1:p1" })).toBe("w1:p1");
	expect(HerdrStatusReporter.fromEnv({ ...inside, [PANE_MARKER]: "w1:p1" })).toBeUndefined();
	expect(HerdrStatusReporter.fromEnv(inside)?.paneId).toBe("w1:p1");
	expect(PANE_MARKER).toBe("ATELIER_HERDR_PANE");
});

it("finds no Herdr pane outside Herdr", async () => {
	await writeFile("not-a-socket", "");
	expect(herdrPane({})).toBeUndefined();
	expect(herdrPane({ ...inside, HERDR_ENV: "0" })).toBeUndefined();
	expect(herdrPane({ ...inside, HERDR_PANE_ID: " " })).toBeUndefined();
	expect(herdrPane({ ...inside, HERDR_SOCKET_PATH: "missing.sock" })).toBeUndefined();
	expect(herdrPane({ ...inside, HERDR_SOCKET_PATH: "not-a-socket" })).toBeUndefined();
});
