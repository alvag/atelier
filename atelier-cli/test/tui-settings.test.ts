import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATUS_LINE } from "../src/tui/footer.ts";
import { readTuiSettings } from "../src/tui/settings.ts";

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
		const defaults = { fullscreen: true, statusLine: DEFAULT_STATUS_LINE, warnings: [] };
		expect(await readTuiSettings(home)).toEqual(defaults);
		expect(await readTuiSettings(undefined)).toEqual(defaults);
	});

	it("read the full-screen switch and the status line items in their order", async () => {
		await save(file({ fullscreen: false, statusLine: ["git-branch", "model", "cost"] }));
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: false,
			statusLine: ["git-branch", "model", "cost"],
			warnings: [],
		});
	});

	it("skip an unknown item and say so", async () => {
		await save(file({ statusLine: ["model", "weather", "mode"] }));
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: true,
			statusLine: ["model", "mode"],
			warnings: [`${path()}: unknown status line item "weather"; skipped`],
		});
	});

	it("use the default of each field that is wrong and say so", async () => {
		await save(file({ fullscreen: "yes", statusLine: "model" }));
		expect(await readTuiSettings(home)).toEqual({
			fullscreen: true,
			statusLine: DEFAULT_STATUS_LINE,
			warnings: [
				`${path()}: "tui.fullscreen" must be true or false; using the default`,
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
			statusLine: DEFAULT_STATUS_LINE,
			warnings: [`${path()}: expected kind "atelier.settings" and version 1; using the defaults`],
		});
	});
});
