import { statSync } from "node:fs";
import { createConnection } from "node:net";
import type { ProgramStatus } from "@earendil-works/pi-tui";

const AGENT = "atelier";
const SOURCE = "atelier";
/** The variable the TUI gives the core, and so its tools' commands: an Atelier started by one finds its pane taken. */
export const PANE_MARKER = "ATELIER_HERDR_PANE";

/** Herdr's own bridges wait 500 ms for a reply, then try once more for 1500 ms. */
const ATTEMPT_MS = [500, 1500];
/** How long exiting waits for the release to reach Herdr. */
const RELEASE_WAIT_MS = 1000;

/** What the user is asked about while the core waits; Herdr only gets a fixed message for it. */
const BLOCKED_MESSAGES = {
	permission: "Approval awaiting input",
	question: "Review consent awaiting input",
} as const;

type State = Exclude<ProgramStatus["state"], "clear">;
type Blocked = { kind: keyof typeof BLOCKED_MESSAGES; message: string };

/** One request to Herdr; `key` names what a newer request of the same kind replaces while it waits. */
interface Pending {
	key: string;
	method: string;
	params: Record<string, unknown>;
}

/** Herdr answered with an error: trying again would get the same answer. */
class Refused extends Error {}

/** Writes one request line to the socket and waits for its reply line, at most `timeoutMs`. */
function call(socketPath: string, request: Record<string, unknown>, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffered = "";
		const settle = (error?: Error) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => settle(new Error("timeout")), timeoutMs);
		timer.unref();
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			buffered += chunk.toString();
			const end = buffered.indexOf("\n");
			if (end === -1) return;
			let reply: { error?: unknown } | undefined;
			try {
				reply = JSON.parse(buffered.slice(0, end));
			} catch {}
			settle(reply === undefined || reply.error !== undefined ? new Refused("refused") : undefined);
		});
		socket.on("error", (error) => settle(error));
		socket.on("close", () => settle(new Error("closed")));
	});
}

/**
 * Tells Herdr what the TUI is doing, through the pane's socket, so Herdr shows it as an agent with a live state.
 * One request is in flight at a time and only the newest of each kind waits behind it; every failure is ignored.
 */
export class HerdrStatusReporter {
	readonly paneId: string;
	readonly #socketPath: string;
	/** Herdr keeps the highest seq of a source: starting from the clock, a later Atelier in the pane still counts. */
	#seq = Date.now();
	#requests = 0;
	#queue: Pending[] = [];
	#flight: Promise<void> | undefined;
	/** The state asked for last, and the one Herdr was sent last. */
	#asked: string | undefined;
	#sent: string | undefined;
	#released = false;

	private constructor(paneId: string, socketPath: string) {
		this.paneId = paneId;
		this.#socketPath = socketPath;
	}

	/** A reporter for the Herdr pane the TUI runs in; none outside Herdr or when an Atelier already reports the pane. */
	static fromEnv(env: Record<string, string | undefined>): HerdrStatusReporter | undefined {
		const paneId = env.HERDR_PANE_ID?.trim();
		const socketPath = env.HERDR_SOCKET_PATH;
		if (env.HERDR_ENV !== "1" || !paneId || !socketPath || env[PANE_MARKER] === paneId) return undefined;
		try {
			if (!statSync(socketPath).isSocket()) return undefined;
		} catch {
			return undefined;
		}
		return new HerdrStatusReporter(paneId, socketPath);
	}

	/** Reports the state, unless it is the one asked for last; done and error are idle to Herdr. */
	report(state: State, blocked?: Blocked) {
		const params =
			state === "blocked" && blocked
				? { state: "blocked", message: BLOCKED_MESSAGES[blocked.kind] }
				: { state: state === "working" ? "working" : "idle" };
		const key = JSON.stringify(params);
		if (key === this.#asked) return;
		this.#asked = key;
		this.#enqueue({ key: "state", method: "pane.report_agent", params });
	}

	/** Reports the session the TUI runs; a saved one comes with the command that resumes it. */
	session(id: string, saved: boolean) {
		this.#enqueue({
			key: "session",
			method: "pane.report_agent_session",
			params: { agent_session_id: id, ...(saved ? { resume_argv: [AGENT, "--resume", id] } : {}) },
		});
	}

	/** Takes the TUI off the pane; waits for Herdr at most RELEASE_WAIT_MS, and never fails. */
	async release(): Promise<void> {
		if (this.#released) return;
		this.#enqueue({ key: "release", method: "pane.release_agent", params: {} });
		this.#released = true;
		let timer: NodeJS.Timeout | undefined;
		const gaveUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, RELEASE_WAIT_MS);
		});
		await Promise.race([this.#drained(), gaveUp]);
		clearTimeout(timer);
	}

	#enqueue(request: Pending) {
		if (this.#released) return;
		const waiting = this.#queue.findIndex((queued) => queued.key === request.key);
		if (waiting === -1) this.#queue.push(request);
		else this.#queue[waiting] = request;
		this.#flight ??= this.#flush();
	}

	async #drained() {
		while (this.#flight) await this.#flight;
	}

	async #flush() {
		for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
			if (next.key === "state") {
				// A state Herdr already has, because a newer one replaced it while it waited, is not sent again.
				const state = JSON.stringify(next.params);
				if (state === this.#sent) continue;
				this.#sent = state;
			}
			await this.#send(next);
		}
		this.#flight = undefined;
	}

	async #send({ method, params }: Pending) {
		const request = {
			id: `atelier:${process.pid}:${++this.#requests}`,
			method,
			params: { pane_id: this.paneId, source: SOURCE, agent: AGENT, seq: ++this.#seq, ...params },
		};
		for (const timeoutMs of ATTEMPT_MS) {
			try {
				return await call(this.#socketPath, request, timeoutMs);
			} catch (error) {
				if (error instanceof Refused) return;
			}
		}
	}
}
