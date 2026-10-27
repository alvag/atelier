import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { type ProgramStatus, visibleWidth } from "@earendil-works/pi-tui";

const AGENT = "atelier";
const SOURCE = "atelier";
/** The sidebar's summary is reported apart from the state, as Herdr's own bridges do. */
const ACTIVITY_SOURCE = "atelier:activity";
/** The variable the TUI gives the core, and so its tools' commands: an Atelier started by one finds its pane taken. */
export const PANE_MARKER = "ATELIER_HERDR_PANE";

/** Herdr's own bridges wait 500 ms for a reply, then try once more for 1500 ms. */
const ATTEMPT_MS = [500, 1500];
/** How long exiting waits for the release to reach Herdr. */
const RELEASE_WAIT_MS = 1000;
/** The summary lives 30 s in Herdr unless it is reported again, every 10 s while a turn runs. */
const SUMMARY_TTL_MS = 30_000;
const REFRESH_MS = 10_000;
/** A sidebar row: Herdr's sidebar width less its margins, or 24 columns when its session file does not say. */
const SIDEBAR_MARGIN = 5;
const DEFAULT_ROW_WIDTH = 24;
/** Herdr's limits: 80 characters a token and 256 bytes for both, so each row gets half. */
const TOKEN_CHARS = 80;
const TOKEN_BYTES = 128;

/** What the user is asked about while the core waits; Herdr only gets a fixed message for it. */
const BLOCKED_MESSAGES = {
	permission: "Approval awaiting input",
	question: "Review consent awaiting input",
} as const;

type State = Exclude<ProgramStatus["state"], "clear">;
type Blocked = { kind: keyof typeof BLOCKED_MESSAGES; message: string };
/** The ODD task in progress. */
export type Activity = { id: string; title: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is taken out
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

/** The text without control or bidi characters, its spaces collapsed. */
const plain = (text: string) => text.replace(BIDI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();

const ELLIPSIS = "…";

/**
 * The longest start of `text` that fits `width` columns, TOKEN_CHARS characters and TOKEN_BYTES bytes, with room left
 * in all three for `reserved`, the text that will follow it.
 */
function fitting(text: string, width: number, reserved = ""): string {
	const columns = width - visibleWidth(reserved);
	const chars = TOKEN_CHARS - [...reserved].length;
	const bytes = TOKEN_BYTES - Buffer.byteLength(reserved);
	let cut = "";
	for (const { segment } of new Intl.Segmenter().segment(text)) {
		const next = cut + segment;
		if (visibleWidth(next) > columns || [...next].length > chars || Buffer.byteLength(next) > bytes) break;
		cut = next;
	}
	return cut;
}

/**
 * `◐ <ID> <title>` in two sidebar rows at most: the first breaks between words of the title, or inside its first word
 * when that does not fit; the second ends in `…` when cut.
 */
export function summaryRows(activity: Activity, width: number): [string, string | null] {
	const head = plain(`◐ ${activity.id}`);
	const text = plain(`${head} ${activity.title}`);
	let first = fitting(text, width);
	const space = first.lastIndexOf(" ");
	if (first.length < text.length && text[first.length] !== " " && space > head.length) first = first.slice(0, space);
	const rest = text.slice(first.length).trim();
	if (rest === "") return [first.trimEnd(), null];
	const second = fitting(rest, width);
	return [
		first.trimEnd(),
		second.length < rest.length ? `${fitting(rest, width, ELLIPSIS).trimEnd()}${ELLIPSIS}` : second,
	];
}

/** The width of a sidebar row, from the `session.json` Herdr keeps next to its socket. */
function rowWidth(socketPath: string): number {
	try {
		const { sidebar_width: width } = JSON.parse(readFileSync(join(dirname(socketPath), "session.json"), "utf8"));
		if (typeof width === "number" && width - SIDEBAR_MARGIN > 1) return Math.floor(width - SIDEBAR_MARGIN);
	} catch {}
	return DEFAULT_ROW_WIDTH;
}

/** One request to Herdr; `key` names what a newer request of the same kind replaces while it waits. */
interface Pending {
	key: string;
	method: string;
	params: Record<string, unknown>;
	source?: string;
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
	/** The task in progress, whether a turn runs, and whether the sidebar was last asked to show it. */
	#activity: Activity | undefined;
	#running = false;
	#summarized = false;
	#refresh: NodeJS.Timeout | undefined;
	readonly #refreshMs: number;

	private constructor(paneId: string, socketPath: string, refreshMs: number) {
		this.paneId = paneId;
		this.#socketPath = socketPath;
		this.#refreshMs = refreshMs;
	}

	/** A reporter for the Herdr pane the TUI runs in; none outside Herdr or when an Atelier already reports the pane. */
	static fromEnv(
		env: Record<string, string | undefined>,
		options: { refreshMs?: number } = {},
	): HerdrStatusReporter | undefined {
		const paneId = env.HERDR_PANE_ID?.trim();
		const socketPath = env.HERDR_SOCKET_PATH;
		if (env.HERDR_ENV !== "1" || !paneId || !socketPath || env[PANE_MARKER] === paneId) return undefined;
		try {
			if (!statSync(socketPath).isSocket()) return undefined;
		} catch {
			return undefined;
		}
		return new HerdrStatusReporter(paneId, socketPath, options.refreshMs ?? REFRESH_MS);
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
		const running = state === "working" || state === "blocked";
		if (running === this.#running) return;
		this.#running = running;
		this.#summarize();
	}

	/** Takes the ODD task in progress, none when no task is; the sidebar shows it while a turn runs. */
	activity(activity: Activity | undefined) {
		if (activity?.id === this.#activity?.id && activity?.title === this.#activity?.title) return;
		this.#activity = activity;
		this.#summarize();
	}

	/** Shows the task in the sidebar, refreshed while the turn runs, or clears it once if it was shown. */
	#summarize() {
		clearInterval(this.#refresh);
		this.#refresh = undefined;
		const activity = this.#running && !this.#released ? this.#activity : undefined;
		if (activity === undefined) {
			if (this.#summarized) this.#metadata({ tokens: { summary: null, summary2: null } });
			this.#summarized = false;
			return;
		}
		const show = () => {
			const [summary, summary2] = summaryRows(activity, rowWidth(this.#socketPath));
			this.#metadata({ tokens: { summary, summary2 }, ttl_ms: SUMMARY_TTL_MS });
		};
		show();
		this.#summarized = true;
		this.#refresh = setInterval(show, this.#refreshMs);
		this.#refresh.unref();
	}

	#metadata(params: Record<string, unknown>) {
		this.#enqueue({ key: "activity", method: "pane.report_metadata", params, source: ACTIVITY_SOURCE });
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
		this.#running = false;
		this.#summarize();
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

	async #send({ method, params, source = SOURCE }: Pending) {
		const request = {
			id: `atelier:${process.pid}:${++this.#requests}`,
			method,
			params: { pane_id: this.paneId, source, agent: AGENT, seq: ++this.#seq, ...params },
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
