import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** How the user asked to be told: `auto` picks by where the TUI runs. */
export type NotifyVia = "auto" | "terminal" | "system" | "bell";
export const NOTIFY_VIAS: readonly NotifyVia[] = ["auto", "terminal", "system", "bell"];

/** What carries a notice: nothing, the bell, the terminal's OSC 9, or the system's notifications. */
export type Channel = "none" | "bell" | "osc9" | "osascript" | "notify-send";

/** Where the TUI runs. */
export interface Surroundings {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	hasCommand: (name: string) => boolean;
}

/** One notice: `Atelier · <folder>` and what happened. */
export interface Notice {
	title: string;
	body: string;
}

/** Where a notice goes: the terminal, and commands started without waiting for them. */
export interface NoticeOutput {
	write: (data: string) => void;
	spawn: (command: string, args: string[]) => void;
}

const BEL = "\x07";
/** Terminals that show `OSC 9 ; text` as a notification of their own. */
const OSC9_PROGRAMS = new Set(["iTerm.app", "ghostty", "WezTerm"]);
const SOUND_NAME = "Glass";
const MAC_SOUND = `/System/Library/Sounds/${SOUND_NAME}.aiff`;
/** A command that never answers is killed after this long. */
const COMMAND_TIMEOUT_MS = 5000;

const showsOsc9 = (env: Surroundings["env"]) =>
	OSC9_PROGRAMS.has(env.TERM_PROGRAM ?? "") || env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID !== undefined;

/** The system's own notifications: osascript on macOS, notify-send on Linux when installed, the bell elsewhere. */
function systemChannel({ platform, hasCommand }: Surroundings): Channel {
	if (platform === "darwin") return "osascript";
	if (platform === "linux" && hasCommand("notify-send")) return "notify-send";
	return "bell";
}

/**
 * The channel for `via`. In `auto`, Herdr notifies by itself and Orca turns the bell into its own notification; a
 * terminal that shows OSC 9 is asked next, unless tmux sits between them; then the system, then the bell.
 */
export function channelFor(via: NotifyVia, surroundings: Surroundings): Channel {
	const { env } = surroundings;
	if (via === "bell") return "bell";
	if (via === "terminal") return "osc9";
	if (via === "system") return systemChannel(surroundings);
	if (env.HERDR_ENV === "1") return "none";
	if (env.ORCA_PANE_KEY) return "bell";
	if (showsOsc9(env) && !env.TMUX) return "osc9";
	return systemChannel(surroundings);
}

/** Whether `name` is an executable file in a folder of the PATH. */
export function onPath(name: string, path = process.env.PATH ?? ""): boolean {
	return path
		.split(delimiter)
		.filter((folder) => folder !== "")
		.some((folder) => {
			try {
				accessSync(join(folder, name), constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
}

/** Starts a command apart from the TUI, without waiting for it; a failure to start it is ignored. */
export function spawnDetached(command: string, args: string[]): void {
	const child = spawn(command, args, { stdio: "ignore", detached: true, timeout: COMMAND_TIMEOUT_MS });
	child.on("error", () => {});
	child.unref();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is taken out
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** The text without control characters, which could end the terminal's sequence or reach the terminal raw. */
const plain = (text: string) => text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/** `display notification` with its text from the arguments, so the text is never read as AppleScript. */
const appleScript = (sound: boolean) => [
	"on run argv",
	`display notification (item 2 of argv) with title (item 1 of argv)${sound ? ` sound name "${SOUND_NAME}"` : ""}`,
	"end run",
];

/** Sends notices through one channel, with a sound when asked; a failure is ignored. */
export class Notifier {
	readonly channel: Channel;
	readonly #sound: boolean;
	readonly #platform: NodeJS.Platform;
	readonly #out: NoticeOutput;

	constructor(channel: Channel, sound: boolean, platform: NodeJS.Platform, out: NoticeOutput) {
		this.channel = channel;
		this.#sound = sound;
		this.#platform = platform;
		this.#out = out;
	}

	notify(notice: Notice) {
		const title = plain(notice.title);
		const body = plain(notice.body);
		try {
			this.#send(title, body);
		} catch {}
	}

	#send(title: string, body: string) {
		switch (this.channel) {
			case "none":
				return;
			case "bell":
				return this.#out.write(BEL);
			case "osascript":
				return this.#out.spawn("osascript", [...appleScript(this.#sound).flatMap((line) => ["-e", line]), title, body]);
			case "notify-send":
				this.#out.spawn("notify-send", ["--app-name=Atelier", "--", title, body]);
				return this.#ring();
			case "osc9":
				this.#out.write(`\x1b]9;${title}: ${body}${BEL}`);
				return this.#ring();
		}
	}

	/** The sound of a channel that has none of its own: a system sound on macOS, the bell elsewhere. */
	#ring() {
		if (!this.#sound) return;
		if (this.#platform === "darwin") this.#out.spawn("afplay", [MAC_SOUND]);
		else this.#out.write(BEL);
	}
}
