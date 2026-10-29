import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

const APP = "atelier";
/** The live line of a running turn changes at most this often; a change of state is told at once. */
export const STATUS_INTERVAL_MS = 500;

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

	/** Reports the state with its details, unless it is the one reported last; a new working line may wait its turn. */
	report(state: State, { kind, message }: Details = {}) {
		const status: ProgramStatus = {
			state,
			app: APP,
			...(kind === undefined ? {} : { kind }),
			...(message === undefined || message === "" ? {} : { message }),
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
