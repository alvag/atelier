import type { Readable } from "node:stream";

/** Reads the person's input one line (or one pasted block) at a time. */
export interface LineReader {
	/** Starts reading, so lines typed from now on are known to be early. */
	open(): void;
	/**
	 * The next line; `column` is where the cursor sits after the prompt, used to redraw while editing. A `hidden` line
	 * is not echoed at all, for a secret.
	 */
	next(column?: number, options?: { hidden?: boolean }): Promise<string | undefined>;
	/** Stops waiting for a read that will not be consumed (a cancelled question); its line goes to the next caller. */
	abandon(): void;
	/** Shows again the line being typed for the pending read, after the caller wrote over it and its prompt again. */
	redraw(): void;
	/** Whether the line last returned had pasted text in it: a paste can fill in a form but never answer a question. */
	pasted(): boolean;
	/** Drops the lines typed so far, the one being typed included, and says how many. */
	discardTyped(): number;
	/** Stops reading the input, which another program then reads (Claude Code's sign-in); `resume` reads it again. */
	pause(): void;
	resume(): void;
	close(): void;
}

export interface TerminalReaderOptions {
	/** A terminal in raw mode: every key arrives as typed, Enter as "\r" and Ctrl+C as "\x03". */
	stdin: Readable;
	/** Echoes what is typed; only while a read is pending, so type-ahead does not mix with the output. */
	write: (text: string) => void;
	onInterrupt: () => void;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_U = "\x15";
const CTRL_W = "\x17";

/**
 * A small line editor for a terminal in raw mode. A bracketed paste becomes
 * part of one line, line breaks included, and Enter sends it. Editing is
 * Backspace, Ctrl+U and Ctrl+W, as in a terminal's own line mode; other keys
 * and escape sequences are ignored. Redrawing assumes lines do not wrap.
 */
export function createTerminalReader({ stdin, write, onInterrupt }: TerminalReaderOptions): LineReader {
	/** Lines entered before anyone asked for them: type-ahead for the next prompt. */
	const typed: { text: string; pasted: boolean }[] = [];
	/** The line being typed. */
	let buffer = "";
	/**
	 * The line being typed has had pasted text, or the rest of a sequence cut by a question, in it. Erasing
	 * does not clear it: only a new line starts clean, so editing cannot turn a paste into a typed answer.
	 */
	let bufferPasted = false;
	/** The line handed out last had pasted text in it. */
	let handedPasted = false;
	/** The last pasted text ended in "\r", so a "\n" starting the next read is the other half of one line break. */
	let afterCR = false;
	/** The last key was an Enter sent as "\r", so a "\n" right after it, even in the next read, is the same Enter. */
	let enteredCR = false;
	/** Input not handled yet: an escape sequence cut by the end of a read. */
	let pending = "";
	let pasting = false;
	/** The paste in progress began before a question, so none of it is an answer. */
	let droppingPaste = false;
	let waiting: ((line: string | undefined) => void) | undefined;
	/** The line handed to the last read, in case its caller gives it up. */
	let handed: string | undefined;
	let column = 0;
	let ended = false;
	let opened = false;
	/** The pending read is a secret: nothing of it is echoed. */
	let hidden = false;

	const echo = (text: string) => {
		if (waiting && !hidden && text !== "") write(text);
	};
	/** The column where the line at `index` (counted by line breaks in the buffer) starts. */
	const startOf = (index: number) => (index === 0 ? column : 0);
	const lines = () => buffer.split("\n");
	const width = (text: string) => Array.from(text).length;
	const redrawLastLine = () => {
		const all = lines();
		echo(`\x1b[${startOf(all.length - 1) + 1}G\x1b[K${all.at(-1)}`);
	};

	const finish = () => {
		ended = true;
		const resolve = waiting;
		waiting = undefined;
		resolve?.(undefined);
	};
	const enter = () => {
		const line = buffer;
		const wasPasted = bufferPasted;
		buffer = "";
		bufferPasted = false;
		const resolve = waiting;
		waiting = undefined;
		if (resolve) {
			handed = line;
			handedPasted = wasPasted;
			resolve(line);
		} else typed.push({ text: line, pasted: wasPasted });
	};
	const insert = (text: string) => {
		buffer += text;
		echo(text);
	};
	const backspace = () => {
		const chars = Array.from(buffer);
		const last = chars.pop();
		if (last === undefined) return;
		buffer = chars.join("");
		if (last !== "\n") return echo("\b \b");
		const all = lines();
		echo(`\x1b[A\x1b[${startOf(all.length - 1) + width(all.at(-1) ?? "") + 1}G`);
	};
	const eraseLine = () => {
		buffer = buffer.slice(0, buffer.lastIndexOf("\n") + 1);
		redrawLastLine();
	};
	const eraseWord = () => {
		buffer = buffer.replace(/\S*[^\S\n]*$/, "");
		redrawLastLine();
	};
	const pasted = (text: string) => {
		// Terminals send line breaks in a paste as "\r"; other control characters must not reach the echo.
		const joined = afterCR && text.startsWith("\n") ? text.slice(1) : text;
		if (text !== "") afterCR = joined.endsWith("\r");
		const clean = joined
			.replace(/\r\n?/g, "\n")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
		if (droppingPaste || clean === "") return;
		bufferPasted = true;
		insert(clean);
	};

	/** Handles one escape sequence at `data[i]`; returns where the next input starts, or -1 when it is incomplete. */
	const skipEscape = (data: string, i: number): number => {
		const kind = data[i + 1];
		if (kind === undefined) return -1;
		if (kind === "O") return i + 2 < data.length ? i + 3 : -1;
		if (kind !== "[") return i + 2;
		for (let j = i + 2; j < data.length; j++) {
			const code = data.charCodeAt(j);
			if (code < 0x40 || code > 0x7e) continue;
			if (data.slice(i, j + 1) === PASTE_START) {
				pasting = true;
				afterCR = false;
			}
			return j + 1;
		}
		return -1;
	};

	const handle = (chunk: string) => {
		const data = pending + chunk;
		pending = "";
		let i = 0;
		while (i < data.length) {
			if (pasting) {
				enteredCR = false;
				const end = data.indexOf(PASTE_END, i);
				if (end === -1) {
					// Keep a tail that may be the start of the end marker for the next read.
					let keep = Math.min(PASTE_END.length - 1, data.length - i);
					while (keep > 0 && !PASTE_END.startsWith(data.slice(data.length - keep))) keep--;
					pasted(data.slice(i, data.length - keep));
					pending = data.slice(data.length - keep);
					return;
				}
				pasted(data.slice(i, end));
				pasting = false;
				droppingPaste = false;
				i = end + PASTE_END.length;
				continue;
			}
			const char = data[i] ?? "";
			const afterEnter = enteredCR;
			enteredCR = false;
			if (char === "\x1b") {
				const next = skipEscape(data, i);
				if (next === -1) {
					pending = data.slice(i);
					return;
				}
				i = next;
				continue;
			}
			i += 1;
			if (char === "\n" && afterEnter) continue;
			if (char === "\r" || char === "\n") {
				enteredCR = char === "\r";
				enter();
			} else if (char === "\x7f" || char === "\b") backspace();
			else if (char === CTRL_U) eraseLine();
			else if (char === CTRL_W) eraseWord();
			else if (char === CTRL_D) {
				if (buffer === "") finish();
			} else if (char === CTRL_C) {
				buffer = "";
				onInterrupt();
			} else if (char === "\t" || char >= " ") {
				// A surrogate pair arrives whole within a chunk read as UTF-8.
				const code = data.codePointAt(i - 1) ?? 0;
				const whole = String.fromCodePoint(code);
				i += whole.length - 1;
				insert(whole);
			}
		}
	};
	const onData = (chunk: string | Buffer) => handle(String(chunk));

	return {
		open() {
			if (opened) return;
			opened = true;
			stdin.setEncoding("utf8");
			stdin.on("data", onData);
			stdin.on("end", finish);
			stdin.resume();
		},
		next(promptColumn = 0, options = {}) {
			this.open();
			column = promptColumn;
			hidden = options.hidden ?? false;
			const early = typed.shift();
			if (early !== undefined) {
				handedPasted = early.pasted;
				write(early.text);
				return Promise.resolve(early.text);
			}
			if (ended) return Promise.resolve(undefined);
			handed = undefined;
			return new Promise((resolve) => {
				waiting = resolve;
				echo(buffer);
			});
		},
		abandon() {
			// A line can arrive in the same tick as the cancel: it belongs to the next caller.
			if (waiting === undefined && handed !== undefined) typed.unshift({ text: handed, pasted: handedPasted });
			waiting = undefined;
			handed = undefined;
		},
		pasted: () => handedPasted,
		redraw() {
			echo(buffer);
		},
		discardTyped() {
			this.open();
			const count = typed.splice(0).length + (buffer !== "" || pasting ? 1 : 0);
			buffer = "";
			// Half an escape sequence could finish as a paste start after the question, and its rest would read as
			// typed; in a paste, the tail is its end. Either way the answer line starts marked as not typed.
			bufferPasted = pasting || pending !== "";
			if (pasting) droppingPaste = true;
			else pending = "";
			return count;
		},
		pause() {
			if (!opened) return;
			stdin.off("data", onData);
			stdin.pause();
		},
		resume() {
			if (!opened) return;
			stdin.on("data", onData);
			stdin.resume();
		},
		close() {
			stdin.off("data", onData);
			stdin.off("end", finish);
			stdin.pause();
			finish();
		},
	};
}
