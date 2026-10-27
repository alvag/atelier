import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

const APP = "atelier";

type State = Exclude<ProgramStatus["state"], "clear">;

/** The state a main turn leaves behind, from its stop reason. */
export function settledState(stopReason: string): State {
	if (stopReason === "end_turn") return "done";
	if (stopReason === "interrupted") return "idle";
	return "error";
}

/** Tells the terminal what the TUI is doing (OSC 7501), so a terminal like Orca can show it as an agent. */
export class ProgramStatusReporter {
	private last: string | undefined;
	private readonly terminal: Terminal;

	constructor(terminal: Terminal) {
		this.terminal = terminal;
	}

	/** Reports the state, unless it is the one reported last. */
	report(state: State, blocked?: { kind: "permission" | "question"; message: string }) {
		this.send({ state, app: APP, ...blocked });
	}

	/** Takes the TUI off the terminal's list of agents. */
	clear() {
		this.send({ state: "clear", app: APP });
	}

	private send(status: ProgramStatus) {
		const key = JSON.stringify(status);
		if (key === this.last) return;
		this.last = key;
		this.terminal.setProgramStatus(status);
	}
}
