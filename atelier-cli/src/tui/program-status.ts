import type { FeatureTask } from "@atelier/core";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { featureTaskProgress } from "./program-status-progress.ts";
import { type DirectStatus, supportsProgramStatus, writeProgramStatus } from "./program-status-terminal.ts";
import { MAX_LINE_CHARS, oneLine } from "./program-status-text.ts";

const APP = "atelier";
/** The live line of a running turn changes at most this often; a change of state is told at once. */
export const STATUS_INTERVAL_MS = 500;

export { MAX_LINE_CHARS, oneLine };

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
	private pending: { status: ProgramStatus; progress: number | undefined } | undefined;
	/** The feature progress in whole percent, told with a working or blocked state when the terminal takes it. */
	private progress: number | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly terminal: Terminal;
	private readonly intervalMs: number;

	constructor(terminal: Terminal, intervalMs = STATUS_INTERVAL_MS) {
		this.terminal = terminal;
		this.intervalMs = intervalMs;
	}

	/** Keeps the progress of the feature's tasks for the next report; it tells the terminal nothing by itself. */
	feature(tasks: readonly FeatureTask[] | undefined) {
		this.progress = featureTaskProgress(tasks);
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
		const progress = state === "working" || state === "blocked" ? this.progress : undefined;
		const wait = this.sentAt + this.intervalMs - Date.now();
		if (state !== "working" || this.lastState !== "working" || wait <= 0) return this.send(status, progress);
		this.pending = { status, progress };
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			const held = this.pending;
			if (held !== undefined) this.send(held.status, held.progress);
		}, wait);
		this.timer.unref?.();
	}

	/** Takes the TUI off the terminal's list of agents. */
	clear() {
		this.send({ state: "clear", app: APP });
	}

	/** The progress goes only when the terminal answers the query now, so a held report falls back to a plain root. */
	private send(status: ProgramStatus, progress?: number) {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
		const record: DirectStatus =
			progress !== undefined && supportsProgramStatus(this.terminal) ? { ...status, progress } : status;
		const key = JSON.stringify(record);
		if (key === this.last) return;
		this.last = key;
		this.lastState = status.state;
		this.sentAt = Date.now();
		writeProgramStatus(this.terminal, record);
	}
}
