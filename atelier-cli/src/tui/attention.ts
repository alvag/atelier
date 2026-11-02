import { basename } from "node:path";
import type { Host } from "@atelier/core";
import type { Terminal } from "@earendil-works/pi-tui";
import { channelFor, Notifier, onPath, spawnDetached } from "./notifications.ts";
import type { NotificationSettings } from "./settings.ts";

/** The terminal's focus reports, which `CSI ? 1004 h` turns on. */
const FOCUS_IN = "\x1b[I";
// biome-ignore lint/suspicious/noControlCharactersInRegex: the focus reports are what is taken out
const FOCUS_REPORTS = /\x1b\[[IO]/g;
/** A bracketed paste is the user's text: a focus report inside it is not the terminal's. */
const PASTE_START = "\x1b[200~";
const REPORT_FOCUS = "\x1b[?1004h";
const STOP_REPORTING_FOCUS = "\x1b[?1004l";

const WAITING = {
	permission: "Waiting for approval",
	question: "Waiting for review consent",
	user_question: "Waiting for your answer",
} as const;

/**
 * The ends of a turn that failed: the core's (`error`, `turn_limit` when it ran out of model requests, `incomplete`
 * when the backend stopped without ending it) and Claude Code's `error_*` results. The model's own stops, such as
 * `max_tokens` or `stop_sequence`, are not failures.
 */
const FAILED_ENDS: ReadonlySet<string> = new Set(["error", "turn_limit", "incomplete"]);
const failed = (stopReason: string) => FAILED_ENDS.has(stopReason) || stopReason.startsWith("error_");

/** Where the TUI runs, and what starts a command; tests give their own. */
export interface AttentionOptions {
	terminal: Terminal;
	cwd: string;
	env?: Record<string, string | undefined>;
	/** The host told at start; without it, the one `env` says. */
	host?: Host;
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
			...(options.host === undefined ? {} : { host: options.host }),
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
	 * The terminal the TUI should use: it asks for focus reports and takes them out of the input, alone or among other
	 * keys, so they never reach the editor or a question. The full screen gets the last one on its own, the only way it
	 * takes one (it ends a mouse selection when the focus goes); the main screen gets none.
	 */
	watch(terminal: Terminal, fullscreen: boolean): Terminal {
		if (this.#notifier === undefined) return terminal;
		const start: Terminal["start"] = (onInput, onResize) => {
			terminal.start((data) => {
				const reports = data.startsWith(PASTE_START) ? null : data.match(FOCUS_REPORTS);
				if (reports === null) return onInput(data);
				const last = reports[reports.length - 1];
				this.#focused = last === FOCUS_IN;
				if (fullscreen && last !== undefined) onInput(last);
				const rest = data.replace(FOCUS_REPORTS, "");
				if (rest !== "") onInput(rest);
			}, onResize);
			try {
				terminal.write(REPORT_FOCUS);
			} catch {}
		};
		// The terminal is given back even when it cannot be written to anymore.
		const stop: Terminal["stop"] = () => {
			try {
				terminal.write(STOP_REPORTING_FOCUS);
			} catch {
			} finally {
				terminal.stop();
			}
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

	/** Tells the end of a main turn that ran long enough, unless the user interrupted it, as failed or finished. */
	turnFinished(stopReason: string) {
		const startedAt = this.#turnStartedAt;
		this.#turnStartedAt = undefined;
		if (stopReason === "interrupted" || startedAt === undefined || Date.now() - startedAt < this.#minMs) return;
		this.#tell(failed(stopReason) ? "Turn failed" : "Turn finished");
	}

	/** Tells that the session waits for the user's answer. */
	waiting(kind: keyof typeof WAITING) {
		this.#tell(WAITING[kind]);
	}

	#tell(body: string) {
		if (this.#focused !== true) this.#notifier?.notify({ title: this.#title, body });
	}
}
