import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { FakeBackend } from "@atelier/core";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreLink } from "../src/tui/app.ts";

/** A rename the test holds, as a disk that does not answer would. */
const held = vi.hoisted(() => ({ on: false, release: () => {}, started: () => {} }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const rename = (async (from, to) => {
		if (held.on && String(from).includes("settings.json")) {
			held.started();
			await new Promise<void>((resolve) => {
				held.release = resolve;
			});
		}
		return fs.rename(from, to);
	}) as typeof fs.rename;
	return { ...fs, default: { ...fs, rename }, rename };
});

const { abandonSidePanelSaves, saveSidePanel } = await import("../src/tui/settings.ts");
const { run } = await import("../src/run.ts");

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-settings-abandon-"));
	await mkdir(join(home, ".atelier"));
	vi.stubEnv("HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	held.on = false;
	held.release();
	await rm(home, { recursive: true, force: true });
});

describe("abandoning the side panel's saves", () => {
	it("removes the temporary file of a save that does not end, which then changes nothing", async () => {
		const path = join(home, ".atelier", "settings.json");
		const before = JSON.stringify({ kind: "atelier.settings", version: 1, tui: { sidePanel: true } });
		await writeFile(path, before);
		held.on = true;
		const renaming = new Promise<void>((resolve) => {
			held.started = resolve;
		});
		const saving = saveSidePanel(home, false);
		await renaming;
		expect((await readdir(join(home, ".atelier"))).some((name) => name.endsWith(".tmp"))).toBe(true);
		await abandonSidePanelSaves();
		expect(await readdir(join(home, ".atelier"))).toEqual(["settings.json"]);
		held.on = false;
		held.release();
		expect(await saving).toMatch(/the side panel's choice was not saved$/);
		expect(await readdir(join(home, ".atelier"))).toEqual(["settings.json"]);
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("leaves alone a save asked for after it", async () => {
		await abandonSidePanelSaves();
		expect(await saveSidePanel(home, false)).toBeUndefined();
		expect(existsSync(join(home, ".atelier", "settings.json"))).toBe(true);
	});

	it("quits within its time when the disk does not answer, leaving no temporary file", async () => {
		let onInput: ((data: string) => void) | undefined;
		const terminal: Terminal = {
			start: (input) => {
				onInput = input;
			},
			stop: () => {},
			drainInput: async () => {},
			write: () => {},
			columns: 140,
			rows: 30,
			kittyProtocolActive: false,
			moveBy: () => {},
			hideCursor: () => {},
			showCursor: () => {},
			clearLine: () => {},
			clearFromCursor: () => {},
			clearScreen: () => {},
			setTitle: () => {},
			setProgress: () => {},
			setProgramStatus: () => {},
		};
		const link: CoreLink = {
			request: async () => ({ sessionId: "s1" }),
			onEvent: () => () => {},
			onExit: () => () => {},
			close: async () => {},
		};
		const io = {
			stdin: new PassThrough(),
			isTTY: true,
			stdout: () => {},
			stderr: () => {},
			cwd: home,
			home,
			color: false,
			claudeCode: join(home, "no-claude-in-tests"),
			runSecurity: async () => ({ code: 44, stdout: "", stderr: "" }),
			tui: { terminal, connect: async () => link, closeTimeoutMs: 60, statusIntervalMs: 0 },
		};
		const code = run(["--no-session"], io as never, () => new FakeBackend([]));
		for (let i = 0; i < 400 && onInput === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		held.on = true;
		const renaming = new Promise<void>((resolve) => {
			held.started = resolve;
		});
		onInput?.("\x10");
		await renaming;
		const started = performance.now();
		onInput?.("\x03");
		expect(await code).toBe(130);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(await readdir(join(home, ".atelier"))).toEqual([]);
	});
});
