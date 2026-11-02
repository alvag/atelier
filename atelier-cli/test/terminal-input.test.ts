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

	it("reads a hidden line, typed or pasted, without echoing any of it", async () => {
		const t = terminal();
		const line = t.reader.next(10, { hidden: true });
		await t.type("sk-ax\x7f");
		await t.type(`${PASTE_START}nt-secret${PASTE_END}\r`);
		expect(await line).toBe("sk-ant-secret");
		expect(t.echo()).toBe("");
		const shown = t.reader.next(2);
		await t.type("ok\r");
		expect(await shown).toBe("ok");
		expect(t.echo()).toBe("ok");
	});

	it("leaves the input alone while paused, for another program, and reads again once resumed", async () => {
		const t = terminal();
		t.reader.pause();
		await t.type("meant for the other program\r");
		t.stdin.read();
		t.reader.resume();
		const line = t.reader.next(2);
		await t.type("after\r");
		expect(await line).toBe("after");
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

	it("keeps a blank line after a line break split across reads", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type(`${PASTE_START}one\r`);
		await t.type("\n");
		await t.type(`\ntwo${PASTE_END}\r`);
		expect(await line).toBe("one\n\ntwo");
	});

	it("takes a typed Enter sent as CR and LF in two reads as one line", async () => {
		const t = terminal();
		const line = t.reader.next(2);
		await t.type("one\r");
		await t.type("\n");
		t.stdin.end();
		expect(await line).toBe("one");
		expect(await t.reader.next(2)).toBeUndefined();
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
	describe("a pasted note", () => {
		const NOTE = "<hc from=peer>go</hc>";
		const read = async (t: ReturnType<typeof terminal>, keys: string) => {
			const line = t.reader.next();
			await t.type(keys);
			return { line: await line, note: t.reader.notePasted?.() };
		};

		it("marks the whole line when a paste begins <hc after whitespace, a typed draft before it included", async () => {
			const t = terminal();
			expect(await read(t, `draft ${PASTE_START} \n${NOTE}${PASTE_END}\r`)).toEqual({
				line: `draft  \n${NOTE}`,
				note: true,
			});
		});

		it("finds the marker across split chunks and in a large paste", async () => {
			const t = terminal();
			const line = t.reader.next();
			await t.type(PASTE_START.slice(0, 3));
			await t.type(`${PASTE_START.slice(3)}  <`);
			await t.type("hc>");
			await t.type(`${"y".repeat(100_000)}${PASTE_END.slice(0, 2)}`);
			await t.type(`${PASTE_END.slice(2)}\r`);
			expect((await line)?.length).toBe(100_000 + 6);
			expect(t.reader.notePasted?.()).toBe(true);
		});

		it("does not mark typed <hc or a paste with it later; a second paste starting with it does", async () => {
			const t = terminal();
			expect((await read(t, `${NOTE}\r`)).note).toBe(false);
			expect((await read(t, `${PASTE_START}hi ${NOTE}${PASTE_END}\r`)).note).toBe(false);
			expect((await read(t, `${PASTE_START}hi${PASTE_END}${PASTE_START}${NOTE}${PASTE_END}\r`)).note).toBe(true);
		});

		it("keeps the mark per typed-ahead line and through abandon", async () => {
			const t = terminal();
			await t.type(`${PASTE_START}${NOTE}${PASTE_END}\rplain\r`);
			expect((await read(t, "")).note).toBe(true);
			expect((await read(t, "")).note).toBe(false);
			const delivered = t.reader.next();
			await t.type(`${PASTE_START}  <hcX${PASTE_END}\r`);
			await delivered;
			t.reader.abandon();
			expect((await read(t, "")).note).toBe(true);
		});

		it("clears the mark when the draft is emptied, Ctrl+C or discarded, but not when only edited", async () => {
			const t = terminal();
			expect((await read(t, `${PASTE_START}${NOTE}${PASTE_END}\x7f\r`)).note).toBe(true);
			expect((await read(t, `${PASTE_START}${NOTE}${PASTE_END}\x15typed\r`)).note).toBe(false);
			expect((await read(t, `${PASTE_START}${NOTE}${PASTE_END}\x03ok\r`)).note).toBe(false);
			await t.type(`${PASTE_START}${NOTE}${PASTE_END}`);
			t.reader.discardTyped();
			expect((await read(t, "z\r")).note).toBe(false);
		});

		it("does not weaken pasted()", async () => {
			const t = terminal();
			await read(t, `${PASTE_START}${NOTE}${PASTE_END}\r`);
			expect(t.reader.pasted()).toBe(true);
		});
	});
});
