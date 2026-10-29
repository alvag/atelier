import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { plain } from "./herdr-status.ts";

const APP = "atelier";
/** The live line of a running turn changes at most this often; a change of state is told at once. */
export const STATUS_INTERVAL_MS = 500;

/** The longest line told to the terminal, far under the 2048 bytes OSC 7501 takes. */
export const MAX_LINE_CHARS = 200;
const ELLIPSIS = "…";

/** The first line of `text` with words, one line without control or bidi characters, cut to `max` characters. */
export function oneLine(text: string, max = MAX_LINE_CHARS): string {
	const first = plain(text.split("\n").find((line) => plain(line) !== "") ?? "");
	const characters = [...first];
	if (characters.length <= max) return first;
	return `${characters
		.slice(0, max - 1)
		.join("")
		.trimEnd()}${ELLIPSIS}`;
}

type State = Exclude<ProgramStatus["state"], "clear">;
/** What goes with a state: what a blocked TUI waits for, and the line the terminal shows. */
export type Details = { kind?: "permission" | "question"; message?: string | undefined };

/** The state a main turn leaves behind, from its stop reason. */
export function settledState(stopReason: string): State {
	if (stopReason === "end_turn") return "done";
	if (stopReason === "interrupted") return "idle";
	return "error";
}

/** Tells the terminal what the TUI is doing (OSC 7501), so a terminal like Orca can show it as an agent. */
export class ProgramStatusReporter {
	private last: string | undefined;
	private lastState: ProgramStatus["state"] | undefined;
	private sentAt = 0;
	/** The newest working line held back until the interval since the last report has passed. */
	private pending: ProgramStatus | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly terminal: Terminal;
	private readonly intervalMs: number;

	constructor(terminal: Terminal, intervalMs = STATUS_INTERVAL_MS) {
		this.terminal = terminal;
		this.intervalMs = intervalMs;
	}

	/**
	 * Reports the state with its details, unless it is the one reported last; a new working line may wait its turn. The
	 * line goes as one line, without control or bidi characters, whatever it holds.
	 */
	report(state: State, { kind, message }: Details = {}) {
		const line = oneLine(message ?? "");
		const status: ProgramStatus = {
			state,
			app: APP,
			...(kind === undefined ? {} : { kind }),
			...(line === "" ? {} : { message: line }),
		};
		const wait = this.sentAt + this.intervalMs - Date.now();
		if (state !== "working" || this.lastState !== "working" || wait <= 0) return this.send(status);
		this.pending = status;
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			const held = this.pending;
			if (held !== undefined) this.send(held);
		}, wait);
		this.timer.unref?.();
	}

	/** Takes the TUI off the terminal's list of agents. */
	clear() {
		this.send({ state: "clear", app: APP });
	}

	private send(status: ProgramStatus) {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
		const key = JSON.stringify(status);
		if (key === this.last) return;
		this.last = key;
		this.lastState = status.state;
		this.sentAt = Date.now();
		this.terminal.setProgramStatus(status);
	}
}
