import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATUS_LINE } from "../src/tui/footer.ts";
import { DEFAULT_NOTIFICATIONS, readTuiSettings, saveSidePanel } from "../src/tui/settings.ts";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-settings-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const path = () => join(home, ".atelier", "settings.json");
const save = async (content: unknown) => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(path(), typeof content === "string" ? content : JSON.stringify(content));
};
const file = (tui: unknown) => ({ kind: "atelier.settings", version: 1, tui });

describe("TUI settings", () => {
	it("are the defaults without a file or a home", async () => {
		const defaults = {
			fullscreen: true,
			hideThinking: false,
			sidePanel: true,
			statusLine: DEFAULT_STATUS_LINE,
			notifications: DEFAULT_NOTIFICATIONS,
			warnings: [],
		};
		expect(await readTuiSettings(home)).toEqual(defaults);
		expect(await readTuiSettings(undefined)).toEqual(defaults);
	});

	it("read the full-screen switch and the status line items in their order", async () => {
		await save(file({ fullscreen: false, hideThinking: true, statusLine: ["git-branch", "model", "cost"] }));
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: false,
			hideThinking: true,
			sidePanel: true,
			statusLine: ["git-branch", "model", "cost"],
			notifications: DEFAULT_NOTIFICATIONS,
			warnings: [],
		});
	});

	it("skip an unknown item and say so", async () => {
		await save(file({ statusLine: ["model", "weather", "mode"] }));
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: true,
			hideThinking: false,
			sidePanel: true,
			statusLine: ["model", "mode"],
			notifications: DEFAULT_NOTIFICATIONS,
			warnings: [`${path()}: unknown status line item "weather"; skipped`],
		});
	});

	it("use the default status line when the list leaves no item, and say so", async () => {
		const empty = `${path()}: "tui.statusLine" has no known item; using the default`;
		await save(file({ statusLine: [] }));
		expect(await readTuiSettings(home)).toMatchObject({ statusLine: DEFAULT_STATUS_LINE, warnings: [empty] });
		await save(file({ statusLine: ["weather"] }));
		expect(await readTuiSettings(home)).toMatchObject({
			statusLine: DEFAULT_STATUS_LINE,
			warnings: [`${path()}: unknown status line item "weather"; skipped`, empty],
		});
	});

	it("use the default of each field that is wrong and say so", async () => {
		await save(file({ fullscreen: "yes", hideThinking: 1, statusLine: "model" }));
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: true,
			hideThinking: false,
			sidePanel: true,
			statusLine: DEFAULT_STATUS_LINE,
			notifications: DEFAULT_NOTIFICATIONS,
			warnings: [
				`${path()}: "tui.fullscreen" must be true or false; using the default`,
				`${path()}: "tui.hideThinking" must be true or false; using the default`,
				`${path()}: "tui.statusLine" must be a list of items; using the default`,
			],
		});
	});

	it("are the defaults with a file that is not valid JSON or not a settings file", async () => {
		await save("{ nope");
		expect((await readTuiSettings(home)).warnings).toEqual([`${path()}: not valid JSON; using the defaults`]);
		await save({ tui: { fullscreen: false } });
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: true,
			hideThinking: false,
			sidePanel: true,
			statusLine: DEFAULT_STATUS_LINE,
			notifications: DEFAULT_NOTIFICATIONS,
			warnings: [`${path()}: expected kind "atelier.settings" and version 1; using the defaults`],
		});
	});

	it("read the notices: on or off, how they are sent, a sound and the shortest turn that gives one", async () => {
		await save(file({ notifications: { enabled: false, via: "system", sound: true, minSeconds: 0 } }));
		expect((await readTuiSettings(home)).notifications).toEqual({
			enabled: false,
			via: "system",
			sound: true,
			minSeconds: 0,
		});
		await save(file({ notifications: { sound: true } }));
		expect((await readTuiSettings(home)).notifications).toEqual({ ...DEFAULT_NOTIFICATIONS, sound: true });
	});

	it("use the default of each notices field that is wrong and say so", async () => {
		await save(file({ notifications: { enabled: "yes", via: "pigeon", sound: 1, minSeconds: -2 } }));
		const settings = await readTuiSettings(home);
		expect(settings.notifications).toEqual(DEFAULT_NOTIFICATIONS);
		expect(settings.warnings).toEqual([
			`${path()}: "tui.notifications.enabled" must be true or false; using the default`,
			`${path()}: "tui.notifications.via" must be "auto", "terminal", "system" or "bell"; using the default`,
			`${path()}: "tui.notifications.sound" must be true or false; using the default`,
			`${path()}: "tui.notifications.minSeconds" must be a number of seconds, 0 or more; using the default`,
		]);
		await save(file({ notifications: "on" }));
		expect((await readTuiSettings(home)).warnings).toEqual([
			`${path()}: "tui.notifications" must be an object; using the defaults`,
		]);
	});

	it("read whether the side panel shows, and say so when the value is wrong", async () => {
		await save(file({ sidePanel: false }));
		expect(await readTuiSettings(home)).toMatchObject({ sidePanel: false, warnings: [] });
		await save(file({ sidePanel: "no" }));
		expect(await readTuiSettings(home)).toMatchObject({
			sidePanel: true,
			warnings: [`${path()}: "tui.sidePanel" must be true or false; using the default`],
		});
	});
});

describe("saving the side panel's choice", () => {
	it("changes only tui.sidePanel, every other key and value as it was", async () => {
		const before = {
			kind: "atelier.settings",
			version: 1,
			theme: { custom: [1, 2] },
			tui: { statusLine: ["model", "jobs"], sidePanel: true, notifications: { sound: true } },
			extra: "kept",
		};
		await save(before);
		expect(saveSidePanel(home, false)).toBeUndefined();
		expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({ ...before, tui: { ...before.tui, sidePanel: false } });
		expect(Object.keys(JSON.parse(await readFile(path(), "utf8")))).toEqual(Object.keys(before));
		expect(await readTuiSettings(home)).toMatchObject({ sidePanel: false, statusLine: ["model", "jobs"] });
	});

	it("adds a tui section to a file without one", async () => {
		await save({ kind: "atelier.settings", version: 1, other: true });
		saveSidePanel(home, false);
		expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({
			kind: "atelier.settings",
			version: 1,
			other: true,
			tui: { sidePanel: false },
		});
	});

	it("creates the file with only that setting when there is none", async () => {
		expect(saveSidePanel(home, false)).toBeUndefined();
		expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({
			kind: "atelier.settings",
			version: 1,
			tui: { sidePanel: false },
		});
	});

	it("keeps the file's permissions, and makes a new one as before", async () => {
		await save(file({}));
		await chmod(path(), 0o600);
		saveSidePanel(home, false);
		expect((await stat(path())).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path(), "utf8")).tui).toEqual({ sidePanel: false });
		await rm(path());
		saveSidePanel(home, true);
		expect((await stat(path())).mode & 0o777).toBe(0o666 & ~process.umask());
	});

	it("writes through a symbolic link to the file it leads to, which stays a link", async () => {
		const dotfiles = join(home, "dotfiles");
		await mkdir(dotfiles);
		await writeFile(join(dotfiles, "settings.json"), JSON.stringify(file({ hideThinking: true })));
		await chmod(join(dotfiles, "settings.json"), 0o600);
		await mkdir(join(home, ".atelier"));
		await symlink(join("..", "dotfiles", "settings.json"), path());
		expect(saveSidePanel(home, false)).toBeUndefined();
		expect((await lstat(path())).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await readFile(join(dotfiles, "settings.json"), "utf8")).tui).toEqual({
			hideThinking: true,
			sidePanel: false,
		});
		expect((await stat(join(dotfiles, "settings.json"))).mode & 0o777).toBe(0o600);
		expect(await readdir(dotfiles)).toEqual(["settings.json"]);
		expect(await readdir(join(home, ".atelier"))).toEqual(["settings.json"]);
	});

	it("keeps the last of quick choices, with no temporary file left", async () => {
		await save(file({ statusLine: ["model"] }));
		const answers = Array.from({ length: 20 }, (_, i) => saveSidePanel(home, i % 2 === 0));
		expect(answers.every((answer) => answer === undefined)).toBe(true);
		expect(JSON.parse(await readFile(path(), "utf8")).tui).toEqual({ statusLine: ["model"], sidePanel: false });
		expect(await readdir(join(home, ".atelier"))).toEqual(["settings.json"]);
	});

	it("says the choice was not saved, without throwing, when its temporary file cannot be written or removed", async () => {
		const before = JSON.stringify(file({ sidePanel: true }));
		await save(before);
		// A folder where the temporary file goes: writing it fails, and so does removing it.
		for (let n = 1; n <= 100; n++) await mkdir(`${path()}.${process.pid}.${n}.tmp`);
		expect(saveSidePanel(home, false)).toMatch(/: cannot write it: .+; the side panel's choice was not saved$/);
		expect(await readFile(path(), "utf8")).toBe(before);
	});

	it("leaves a file it cannot read as settings untouched, and says why", async () => {
		for (const content of ["{ nope", JSON.stringify({ tui: {} }), JSON.stringify(file("panel"))]) {
			await save(content);
			expect(saveSidePanel(home, false)).toMatch(/^.+settings\.json: .+; the side panel's choice was not saved$/);
			expect(await readFile(path(), "utf8")).toBe(content);
		}
	});
});
