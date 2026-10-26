import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const main = join(import.meta.dirname, "../src/main.ts");
/** Makes the child believe stdin and stdout are terminals, and shows each raw-mode switch on stdout. */
const fakeTerminal = [
	"process.stdin.isTTY = true;",
	"process.stdout.isTTY = true;",
	"process.stdin.setRawMode = (on) => { process.stdout.write(on ? '[raw:on]' : '[raw:off]'); };",
].join("");

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-signals-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("terminating signals", () => {
	it.each([
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const)(
		"%s leaves the terminal as it was and exits %i",
		async (signal, code) => {
			const child = spawn(process.execPath, ["--import", `data:text/javascript,${fakeTerminal}`, main], {
				cwd: home,
				env: { ...process.env, HOME: home, ATELIER_MEMORY: "off", NO_COLOR: "1", ATELIER_TUI: "off" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
				child.on("exit", (exitCode, by) => resolve([exitCode, by])),
			);
			for (let i = 0; i < 1000 && !stdout.includes("\x1b[?2004h> "); i++) await new Promise((r) => setTimeout(r, 10));
			expect(stdout).toContain("\x1b[?2004h> ");
			child.kill(signal);
			expect(await exited).toEqual([code, null]);
			expect(stdout).toContain("[raw:off]");
			expect(stdout.endsWith("\x1b[?2004l")).toBe(true);
		},
		20000,
	);
});
