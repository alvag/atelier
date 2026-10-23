import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTerminalReader } from "../src/terminal-input.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function terminal() {
	const stdin = new PassThrough();
	let echo = "";
	let interrupts = 0;
	const reader = createTerminalReader({
		stdin,
		write: (text) => {
			echo += text;
		},
		onInterrupt: () => {
			interrupts += 1;
		},
	});
	reader.open();
	/** Sends keys and lets the reader see them before going on. */
	const type = async (keys: string) => {
		stdin.write(keys);
		await new Promise((resolve) => setImmediate(resolve));
	};
	return { stdin, reader, type, echo: () => echo, interrupts: () => interrupts };
}

describe("terminal reader", () => {
	it("reads a typed line on Enter and echoes what is typed", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type("hi\r");
		expect(await line).toBe("hi");
		expect(t.echo()).toBe("hi");
	});

	it("takes a multi-line bracketed paste as one line, without echoing the markers", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type(`${PASTE_START}first\rsecond\r\nthird${PASTE_END}`);
		await t.type("\r");
		expect(await line).toBe("first\nsecond\nthird");
		expect(t.echo()).toBe("first\nsecond\nthird");
	});

	it("reads a line break split across two reads as one", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type(`${PASTE_START}one\r`);
		await t.type(`\ntwo${PASTE_END}\r`);
		expect(await line).toBe("one\ntwo");
	});

	it("keeps a paste whole when its markers are split across reads", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type("\x1b[20");
		await t.type("0~one\rtw");
		await t.type("o\x1b[2");
		await t.type("01~\r");
		expect(await line).toBe("one\ntwo");
	});

	it("submits each line of a paste the terminal did not bracket", async () => {
		const t = terminal();
		await t.type("one\rtwo\r");
		expect(await t.reader.next(2)).toBe("one");
		expect(await t.reader.next(2)).toBe("two");
	});

	it("edits with Backspace, Ctrl+U and Ctrl+W and ignores other keys", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type("abc\x7f");
		expect(t.echo()).toBe("abc\b \b");
		await t.type("\x1b[A\x1b[D\x1bOP\x01");
		await t.type(" word  \x17");
		expect(t.echo().endsWith("\x1b[3G\x1b[Kab ")).toBe(true);
		await t.type("junk\x15ok\r");
		expect(await line).toBe("ok");
		expect(t.echo().endsWith("\x1b[3G\x1b[Kok")).toBe(true);
	});

	it("goes back up a line when Backspace erases a pasted line break", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type(`${PASTE_START}ab\rc${PASTE_END}\x7f\x7f`);
		expect(t.echo()).toBe("ab\nc\b \b\x1b[A\x1b[5G");
		await t.type("\r");
		expect(await line).toBe("ab");
	});

	it("ends the input on Ctrl+D at an empty line", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type("x\x04");
		await t.type("\x7f\x04");
		expect(await line).toBeUndefined();
	});

	it("reports Ctrl+C and drops the line being typed", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type("half\x03");
		expect(t.interrupts()).toBe(1);
		await t.type("new\r");
		expect(await line).toBe("new");
	});

	it("keeps type-ahead quiet and shows it once it is read", async () => {
		const t = terminal();
		await t.type("early\rpart");
		expect(t.echo()).toBe("");
		expect(await t.reader.next(2)).toBe("early");
		expect(t.echo()).toBe("early");
		const line = t.reader.next(2);
		await t.type("ial\r");
		expect(await line).toBe("partial");
		expect(t.echo()).toBe("earlypartial");
	});

	it("discards type-ahead, a pasted block counting as one line", async () => {
		const t = terminal();
		await t.type(`${PASTE_START}a\rb\rc${PASTE_END}\ry\rhalf`);
		expect(t.reader.discardTyped()).toBe(3);
		const answer = t.reader.next(6);
		await t.type("n\r");
		expect(await answer).toBe("n");
	});

	it("discards the rest of a paste that began before the question", async () => {
		const t = terminal();
		await t.type(`${PASTE_START}one\rtw`);
		expect(t.reader.discardTyped()).toBe(1);
		const answer = t.reader.next(6);
		await t.type(`o\ry\r${PASTE_END}`);
		await t.type("n\r");
		expect(await answer).toBe("n");
	});

	it("ends pending reads when closed", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		t.reader.close();
		expect(await line).toBeUndefined();
		expect(await t.reader.next(2)).toBeUndefined();
	});
});
