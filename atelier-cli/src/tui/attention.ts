import { basename } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { channelFor, Notifier, onPath, spawnDetached } from "./notifications.ts";
import type { NotificationSettings } from "./settings.ts";

/** The terminal's focus reports, which `CSI ? 1004 h` turns on. */
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const REPORT_FOCUS = "\x1b[?1004h";
const STOP_REPORTING_FOCUS = "\x1b[?1004l";

const WAITING = {
	permission: "Waiting for approval",
	question: "Waiting for review consent",
} as const;

/** Where the TUI runs, and what starts a command; tests give their own. */
export interface AttentionOptions {
	terminal: Terminal;
	cwd: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	spawn?: (command: string, args: string[]) => void;
}

/**
 * Tells the user, through a notification or a sound, that a turn ended or the session waits for them, while the
 * terminal does not have the focus. A turn shorter than the settings' seconds or interrupted by the user is not told.
 */
export class Attention {
	readonly #notifier: Notifier | undefined;
	readonly #minMs: number;
	readonly #title: string;
	/** Unknown until the terminal reports it, and told as without the focus. */
	#focused: boolean | undefined;
	#turnStartedAt: number | undefined;

	constructor(settings: NotificationSettings, options: AttentionOptions) {
		const env = options.env ?? {};
		const platform = options.platform ?? process.platform;
		const channel = channelFor(settings.via, {
			env,
			platform,
			hasCommand: (name) => onPath(name, env.PATH ?? process.env.PATH),
		});
		const { terminal } = options;
		this.#notifier =
			settings.enabled && channel !== "none"
				? new Notifier(channel, settings.sound, platform, {
						write: (data) => terminal.write(data),
						spawn: options.spawn ?? spawnDetached,
					})
				: undefined;
		this.#minMs = settings.minSeconds * 1000;
		this.#title = `Atelier · ${basename(options.cwd)}`;
	}

	/**
	 * The terminal the TUI should use: it asks for focus reports and reads them before the TUI does. The full screen
	 * gets them too, since it handles them itself; the main screen does not, so they never reach the editor.
	 */
	watch(terminal: Terminal, fullscreen: boolean): Terminal {
		if (this.#notifier === undefined) return terminal;
		const start: Terminal["start"] = (onInput, onResize) => {
			terminal.start((data) => {
				if (data === FOCUS_IN || data === FOCUS_OUT) {
					this.#focused = data === FOCUS_IN;
					if (!fullscreen) return;
				}
				onInput(data);
			}, onResize);
			terminal.write(REPORT_FOCUS);
		};
		const stop: Terminal["stop"] = () => {
			terminal.write(STOP_REPORTING_FOCUS);
			terminal.stop();
		};
		return new Proxy(terminal, {
			get(target, key) {
				if (key === "start") return start;
				if (key === "stop") return stop;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	turnStarted() {
		this.#turnStartedAt = Date.now();
	}

	/** Tells the end of a main turn that ran long enough, unless the user interrupted it. */
	turnFinished(stopReason: string) {
		const startedAt = this.#turnStartedAt;
		this.#turnStartedAt = undefined;
		if (stopReason === "interrupted" || startedAt === undefined || Date.now() - startedAt < this.#minMs) return;
		this.#tell(stopReason === "end_turn" ? "Turn finished" : "Turn failed");
	}

	/** Tells that the session waits for the user's answer. */
	waiting(kind: keyof typeof WAITING) {
		this.#tell(WAITING[kind]);
	}

	#tell(body: string) {
		if (this.#focused !== true) this.#notifier?.notify({ title: this.#title, body });
	}
}
