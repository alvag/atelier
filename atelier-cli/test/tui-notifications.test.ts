import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { channelFor, Notifier, onPath, type Surroundings } from "../src/tui/notifications.ts";

const at = (
	env: Record<string, string>,
	platform: NodeJS.Platform = "darwin",
	commands: string[] = [],
): Surroundings => ({
	env,
	platform,
	hasCommand: (name) => commands.includes(name),
});

describe("channelFor", () => {
	it("leaves the notices to Herdr, which notifies blocked and done by itself", () => {
		expect(channelFor("auto", at({ HERDR_ENV: "1", TERM_PROGRAM: "ghostty" }))).toBe("none");
	});

	it("rings the bell inside Orca, which turns it into a notification of its own", () => {
		expect(channelFor("auto", at({ ORCA_PANE_KEY: "tab:1", TERM_PROGRAM: "ghostty" }))).toBe("bell");
	});

	it("asks a terminal that shows OSC 9 notifications, but not through tmux", () => {
		for (const env of [
			{ TERM_PROGRAM: "iTerm.app" },
			{ TERM_PROGRAM: "ghostty" },
			{ TERM_PROGRAM: "WezTerm" },
			{ TERM: "xterm-kitty" },
			{ KITTY_WINDOW_ID: "1" },
		])
			expect(channelFor("auto", at(env, "linux"))).toBe("osc9");
		expect(channelFor("auto", at({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" }))).toBe("osascript");
	});

	it("falls back to the system's notifications, then to the bell", () => {
		expect(channelFor("auto", at({ TERM_PROGRAM: "Apple_Terminal" }))).toBe("osascript");
		expect(channelFor("auto", at({}, "linux", ["notify-send"]))).toBe("notify-send");
		expect(channelFor("auto", at({}, "linux"))).toBe("bell");
		expect(channelFor("auto", at({}, "win32"))).toBe("bell");
	});

	it("takes the channel asked for, wherever the TUI runs", () => {
		const herdr = { HERDR_ENV: "1" };
		expect(channelFor("terminal", at(herdr))).toBe("osc9");
		expect(channelFor("system", at(herdr))).toBe("osascript");
		expect(channelFor("system", at(herdr, "linux"))).toBe("bell");
		expect(channelFor("bell", at({ TERM_PROGRAM: "ghostty" }))).toBe("bell");
	});
});

describe("onPath", () => {
	it("finds an executable file in a folder of the PATH, and not a file that cannot run", async () => {
		const folder = await mkdtemp(join(tmpdir(), "atelier-path-"));
		try {
			await writeFile(join(folder, "notify-send"), "#!/bin/sh\n");
			await chmod(join(folder, "notify-send"), 0o755);
			await writeFile(join(folder, "plain"), "");
			const path = ["", "/nowhere", folder].join(delimiter);
			expect(onPath("notify-send", path)).toBe(true);
			expect(onPath("plain", path)).toBe(process.platform === "win32");
			expect(onPath("missing", path)).toBe(false);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});
});

describe("Notifier", () => {
	function output() {
		const written: string[] = [];
		const spawned: string[][] = [];
		return {
			written,
			spawned,
			out: {
				write: (data: string) => {
					written.push(data);
				},
				spawn: (command: string, args: string[]) => {
					spawned.push([command, ...args]);
				},
			},
		};
	}
	const notice = { title: "Atelier · app", body: "Turn finished" };

	it("writes an OSC 9 notification, without control characters that would end it early", () => {
		const o = output();
		new Notifier("osc9", false, "linux", o.out).notify({
			title: "Atelier · a\x07b\x1b]c",
			body: "Turn\u009c finished",
		});
		expect(o.written).toEqual(["\x1b]9;Atelier · a b ]c: Turn finished\x07"]);
		expect(o.spawned).toEqual([]);
	});

	it("passes the text to osascript as arguments, never inside its script", () => {
		const o = output();
		new Notifier("osascript", false, "darwin", o.out).notify({ title: 'Atelier · "x"', body: "Turn finished" });
		const [call] = o.spawned;
		expect(call?.[0]).toBe("osascript");
		expect(call?.slice(-2)).toEqual(['Atelier · "x"', "Turn finished"]);
		expect(call?.join(" ")).not.toContain("sound name");
		expect(o.written).toEqual([]);
	});

	it("calls notify-send with the text after the options", () => {
		const o = output();
		new Notifier("notify-send", false, "linux", o.out).notify(notice);
		expect(o.spawned).toEqual([["notify-send", "--app-name=Atelier", "--", "Atelier · app", "Turn finished"]]);
	});

	it("rings the bell alone, and nothing at all with no channel", () => {
		const o = output();
		new Notifier("bell", false, "linux", o.out).notify(notice);
		new Notifier("none", true, "darwin", o.out).notify(notice);
		expect(o.written).toEqual(["\x07"]);
		expect(o.spawned).toEqual([]);
	});

	it("adds a sound: the notification's own, a system sound on macOS, or the bell", () => {
		const script = output();
		new Notifier("osascript", true, "darwin", script.out).notify(notice);
		expect(script.spawned[0]?.join(" ")).toContain('sound name "Glass"');
		const mac = output();
		new Notifier("osc9", true, "darwin", mac.out).notify(notice);
		expect(mac.spawned).toEqual([["afplay", "/System/Library/Sounds/Glass.aiff"]]);
		const linux = output();
		new Notifier("osc9", true, "linux", linux.out).notify(notice);
		new Notifier("notify-send", true, "linux", linux.out).notify(notice);
		new Notifier("bell", true, "linux", linux.out).notify(notice);
		expect(linux.written).toEqual(["\x1b]9;Atelier · app: Turn finished\x07", "\x07", "\x07", "\x07"]);
	});

	it("ignores a terminal or a command that fails", () => {
		const failing = {
			write: () => {
				throw new Error("gone");
			},
			spawn: () => {
				throw new Error("ENOENT");
			},
		};
		expect(() => new Notifier("osc9", true, "darwin", failing).notify(notice)).not.toThrow();
		expect(() => new Notifier("osascript", false, "darwin", failing).notify(notice)).not.toThrow();
	});
});
