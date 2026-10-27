import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATUS_LINE } from "../src/tui/footer.ts";
import { DEFAULT_NOTIFICATIONS, readTuiSettings } from "../src/tui/settings.ts";

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
});
