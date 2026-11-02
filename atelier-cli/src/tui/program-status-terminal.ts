import { type ProgramStatus, StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import { oneLine } from "./program-status-text.ts";

/** A status record with the fields of a child or a direct write; without them it is a root record. */
export type DirectStatus = ProgramStatus & { id?: string; title?: string; progress?: number };

const MAX_TITLE_BYTES = 192;
const MAX_MESSAGE_BYTES = 2048;
const isReply = (sequence: string) =>
	sequence.startsWith("\x1b]7501;?") && (sequence.endsWith("\x07") || sequence.endsWith("\x1b\\"));
const isDeviceAttributes = (sequence: string) => sequence.startsWith("\x1b[?") && sequence.endsWith("c");
const MAX_ID_DEPTH = 8;
const MAX_ID_SEGMENT = 32;
const MAX_ID_LENGTH = 128;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]+$/;

/** What the terminal answered to the query pi-tui sent, held where a wrapping proxy forwards it. */
const CAPABILITY = Symbol("atelier.programStatus");
type Capability = { supported: boolean; direct?: DirectStatus | undefined };

/** Whether the terminal answered the program status query since the last start. */
export function supportsProgramStatus(terminal: Terminal): boolean {
	return (terminal as unknown as { [CAPABILITY]?: Capability })[CAPABILITY]?.supported === true;
}

/** Listens to the input beside the terminal for the answer to the query; it never touches what the terminal reads. */
function watch(capability: Capability, input: NodeJS.ReadableStream, replay: () => void) {
	let detach = () => {};
	const stop = () => {
		capability.supported = false;
		const last = detach;
		detach = () => {};
		last();
	};
	const start = () => {
		stop();
		const mode = process.env.PI_PROGRAM_STATUS;
		let pending = mode !== "1" && mode !== "0";
		if (!pending) return;
		const buffer = new StdinBuffer();
		const listener = (data: string | Buffer) => {
			try {
				buffer.process(data);
			} catch {
				stop();
			}
		};
		detach = () => {
			input.removeListener("data", listener);
			buffer.destroy();
		};
		buffer.on("data", (sequence: string) => {
			if (pending && isReply(sequence)) {
				capability.supported = true;
				replay();
			}
			if (isReply(sequence) || isDeviceAttributes(sequence)) pending = false;
		});
		try {
			input.on("data", listener);
		} catch {
			stop();
		}
	};
	return { start, stop };
}

/**
 * The terminal, watched for the answer to the program status query pi-tui already sends. The watcher sends nothing and
 * reads the input beside the terminal; everything else goes to the terminal as it is.
 */
export function observeProgramStatus(target: Terminal, input: NodeJS.ReadableStream = process.stdin): Terminal {
	const capability: Capability = { supported: false };
	const observer = watch(capability, input, () => {
		if (capability.direct) target.write(serialize(capability.direct));
	});
	return new Proxy(target, {
		get(_, property) {
			if (property === CAPABILITY) return capability;
			if (property === "start") {
				return (...args: Parameters<Terminal["start"]>) => {
					observer.stop();
					target.start(...args);
					try {
						observer.start();
					} catch {
						observer.stop();
					}
				};
			}
			if (property === "stop") {
				return () => {
					try {
						// The terminal keeps an older plain root to tell again; empty it so it cannot come back after a restart.
						if (capability.supported && capability.direct) target.setProgramStatus({ state: "clear" });
					} finally {
						try {
							target.stop();
						} finally {
							observer.stop();
						}
					}
				};
			}
			if (property === "setProgramStatus") {
				return (status: ProgramStatus) => {
					capability.direct = undefined;
					target.setProgramStatus(status);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set: (target, property, value) => Reflect.set(target, property, value, target),
	});
}

function truncateUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		bytes += Buffer.byteLength(char, "utf8");
		if (bytes > maxBytes) break;
		end += char.length;
	}
	return text.slice(0, end);
}

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

function validId(id: string): boolean {
	const segments = id.split("/");
	return (
		id.length <= MAX_ID_LENGTH &&
		segments.length <= MAX_ID_DEPTH &&
		segments.every((segment) => segment.length <= MAX_ID_SEGMENT && SEGMENT_PATTERN.test(segment))
	);
}

/** The OSC 7501 record with the fields of a child, always in the same order. */
function serialize({ state, app, kind, id, progress, title, message }: DirectStatus): string {
	const pairs = [`state=${state}`];
	if (app !== undefined && APP_PATTERN.test(app)) pairs.push(`app=${app}`);
	if (state === "blocked" && kind) pairs.push(`kind=${kind}`);
	if (id !== undefined) pairs.push(`id=${id}`);
	if ((state === "working" || state === "blocked") && progress !== undefined && Number.isFinite(progress)) {
		pairs.push(`progress=${Math.min(100, Math.max(0, Math.round(progress)))}`);
	}
	const shortTitle = truncateUtf8(oneLine(title ?? ""), MAX_TITLE_BYTES);
	if (shortTitle) pairs.push(`title=${encode(shortTitle)}`);
	const text = truncateUtf8(oneLine(message ?? "", MAX_MESSAGE_BYTES), MAX_MESSAGE_BYTES);
	if (text) pairs.push(`msg=${encode(text)}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/**
 * Tells the terminal a status. A root record goes through the terminal as before; a record with an id, a title or a
 * progress goes only when the terminal answered the query, and not at all with an id that is not valid.
 */
export function writeProgramStatus(terminal: Terminal, record: DirectStatus): void {
	const { id, title, progress } = record;
	if (id === undefined && title === undefined && progress === undefined) {
		terminal.setProgramStatus(record);
		return;
	}
	if (!supportsProgramStatus(terminal) || (id !== undefined && !validId(id))) return;
	if (id === undefined) {
		const capability = (terminal as unknown as { [CAPABILITY]?: Capability })[CAPABILITY];
		if (capability) capability.direct = record;
	}
	terminal.write(serialize(record));
}
