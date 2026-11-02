import { EventEmitter } from "node:events";
import { ProcessTerminal, StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramStatusReporter } from "../src/tui/program-status.ts";
import { observeProgramStatus, supportsProgramStatus, writeProgramStatus } from "../src/tui/program-status-terminal.ts";

const noop = () => {};
const REPLY = "\x1b]7501;?\x07";
const REPLY_ST = "\x1b]7501;?\x1b\\";
const DA = "\x1b[?62;4c";
const osc = (body: string) => `\x1b]7501;${body}\x1b\\`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A stdin that takes listeners and nothing else. */
const fakeInput = () =>
	Object.assign(new EventEmitter(), { isRaw: false, setRawMode: noop, setEncoding: noop, resume: noop, pause: noop });

/** A terminal that reads its input the way pi-tui does and keeps the writes it is given. */
function fakeTerminal(input: EventEmitter) {
	const written: string[] = [];
	let buffer: StdinBuffer | undefined;
	let handler: ((data: string) => void) | undefined;
	const terminal = {
		start(onInput: (data: string) => void) {
			buffer = new StdinBuffer();
			buffer.on("data", (sequence) => {
				if (!sequence.startsWith("\x1b]7501;?") && !sequence.startsWith("\x1b[?")) onInput(sequence);
			});
			buffer.on("paste", (content: string) => onInput(`\x1b[200~${content}\x1b[201~`));
			handler = (data) => buffer?.process(data);
			input.on("data", handler);
		},
		stop() {
			buffer?.destroy();
			if (handler) input.removeListener("data", handler);
		},
		write: (data: string) => written.push(data),
	};
	return { terminal: terminal as unknown as Terminal, written };
}

function observed(env?: string) {
	if (env === undefined) delete process.env.PI_PROGRAM_STATUS;
	else process.env.PI_PROGRAM_STATUS = env;
	const input = fakeInput();
	const { terminal, written } = fakeTerminal(input);
	const seen: string[] = [];
	const proxy = observeProgramStatus(terminal, input as unknown as NodeJS.ReadStream);
	proxy.start((data) => seen.push(data), noop);
	return { input, proxy, written, seen, terminal };
}

const extended = { state: "working" as const, app: "atelier", id: "a/b", title: "T", message: "m", progress: 40 };

describe("observeProgramStatus", () => {
	const env = process.env.PI_PROGRAM_STATUS;
	afterEach(() => {
		if (env === undefined) delete process.env.PI_PROGRAM_STATUS;
		else process.env.PI_PROGRAM_STATUS = env;
	});

	describe("root output", () => {
		let out: string[];
		beforeEach(() => {
			process.env.PI_PROGRAM_STATUS = "1";
			out = [];
			vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => out.push(String(chunk))) as never);
			vi.stubGlobal("process", Object.create(process, { stdin: { value: fakeInput() } }));
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		function run(wrap: (terminal: Terminal) => Terminal) {
			out.length = 0;
			const terminal = wrap(new ProcessTerminal());
			terminal.start(noop, noop);
			const reporter = new ProgramStatusReporter(terminal, 0);
			reporter.report("working");
			reporter.report("working", { message: "bash ls" });
			reporter.report("blocked", { kind: "permission", message: "Run rm?" });
			reporter.report("blocked", { kind: "question" });
			reporter.report("done", { message: "All done." });
			reporter.report("error", { message: "Boom" });
			reporter.clear();
			terminal.stop();
			return out.join("");
		}

		it("sends the same bytes as the plain terminal for every root state", () => {
			const legacy = run((terminal) => terminal);
			expect(legacy).toContain(
				[
					osc("state=working:app=atelier"),
					osc(`state=working:app=atelier:msg=${b64("bash ls")}`),
					osc(`state=blocked:app=atelier:kind=permission:msg=${b64("Run rm?")}`),
					osc("state=blocked:app=atelier:kind=question"),
					osc(`state=done:app=atelier:msg=${b64("All done.")}`),
					osc(`state=error:app=atelier:msg=${b64("Boom")}`),
					osc("state=clear:app=atelier"),
				].join(""),
			);
			expect(run((terminal) => observeProgramStatus(terminal))).toBe(legacy);
		});
	});

	describe("input", () => {
		const scripts: Record<string, string[]> = {
			"a reply split with its ESC alone": ["\x1b", "]7501;", "?\x07", DA, "a"],
			"mixed keys": ["ab", "\x1b[A", "\x1b", "[B", "\r", REPLY_ST, "\x1b[1;5C", DA],
			"a spoofed reply in a paste": ["\x1b[200~x", REPLY, "y\x1b[201~", "k", DA],
			"no reply at all": ["q", DA, "w"],
		};
		for (const [name, chunks] of Object.entries(scripts)) {
			it(`leaves the input untouched with ${name}`, () => {
				const legacyInput = fakeInput();
				const legacy = fakeTerminal(legacyInput);
				const got: string[] = [];
				legacy.terminal.start((data) => got.push(data), noop);
				const run = observed();
				for (const chunk of chunks) {
					legacyInput.emit("data", chunk);
					run.input.emit("data", chunk);
					expect(run.seen).toEqual(got);
				}
				expect(run.seen.join("")).toBe(
					{
						"a reply split with its ESC alone": "a",
						"mixed keys": "ab\x1b[A\x1b[B\r\x1b[1;5C",
						"a spoofed reply in a paste": `\x1b[200~x${REPLY}y\x1b[201~k`,
						"no reply at all": "qw",
					}[name],
				);
				run.proxy.stop();
				legacy.terminal.stop();
			});
		}
	});

	describe("capability", () => {
		it("needs a reply before the device attributes, whole or split, with BEL or ST", () => {
			for (const chunks of [[REPLY, DA], [REPLY_ST], ["\x1b", "]75", "01;?", "\x07"]]) {
				const { input, proxy } = observed();
				expect(supportsProgramStatus(proxy)).toBe(false);
				for (const chunk of chunks) input.emit("data", chunk);
				expect(supportsProgramStatus(proxy)).toBe(true);
				proxy.stop();
				expect(supportsProgramStatus(proxy)).toBe(false);
			}
		});

		it("stays off with no reply, a late reply, a reply in a paste or a forced mode", () => {
			const cases: [string | undefined, string[]][] = [
				[undefined, ["a"]],
				[undefined, [DA, REPLY]],
				[undefined, ["\x1b]7501;?\x1b[31m\x07"]],
				[undefined, ["\x1b[200~", REPLY, "\x1b[201~"]],
				["1", [REPLY]],
				["0", [REPLY]],
			];
			for (const [mode, chunks] of cases) {
				const { input, proxy } = observed(mode);
				for (const chunk of chunks) input.emit("data", chunk);
				expect(supportsProgramStatus(proxy)).toBe(false);
				proxy.stop();
			}
		});

		it("needs a new reply after a restart and keeps the capability through a forwarding proxy", () => {
			const { input, proxy } = observed();
			input.emit("data", REPLY);
			const outer = new Proxy(proxy, {});
			expect(supportsProgramStatus(outer)).toBe(true);
			proxy.stop();
			proxy.start(noop, noop);
			expect(supportsProgramStatus(outer)).toBe(false);
			proxy.stop();
		});

		it("turns off quietly when the input cannot be watched, and removes a half-attached listener", () => {
			delete process.env.PI_PROGRAM_STATUS;
			const input = fakeInput();
			const on = input.on.bind(input);
			input.on = ((event: string, listener: () => void) => {
				on(event, listener);
				throw new Error("nope");
			}) as never;
			const { terminal, written } = fakeTerminal(fakeInput());
			const proxy = observeProgramStatus(terminal, input as unknown as NodeJS.ReadStream);
			expect(() => proxy.start(noop, noop)).not.toThrow();
			expect(input.listenerCount("data")).toBe(0);
			expect(supportsProgramStatus(proxy)).toBe(false);
			writeProgramStatus(proxy, extended);
			expect(written).toEqual([]);
		});

		it("does not hide a failing start", () => {
			const terminal = { start: vi.fn(() => Reflect.get({}, "x").y), stop: noop } as unknown as Terminal;
			expect(() => observeProgramStatus(terminal, fakeInput() as never).start(noop, noop)).toThrow(TypeError);
		});
	});

	describe("writeProgramStatus", () => {
		it("hands a root record to the terminal unchanged", () => {
			const setProgramStatus = vi.fn();
			const terminal = { setProgramStatus, write: vi.fn() } as unknown as Terminal;
			writeProgramStatus(terminal, { state: "working", app: "atelier", message: "x" });
			expect(setProgramStatus).toHaveBeenCalledWith({ state: "working", app: "atelier", message: "x" });
			expect(terminal.write).not.toHaveBeenCalled();
		});

		it("writes the extended fields in a fixed order once the terminal answered", () => {
			const { input, proxy, written } = observed();
			input.emit("data", REPLY);
			writeProgramStatus(proxy, { ...extended, title: "Fix\nthe bug", message: "line" });
			writeProgramStatus(proxy, { state: "blocked", app: "atelier", kind: "question", id: "a/b", progress: 5.4 });
			writeProgramStatus(proxy, { state: "done", app: "atelier", kind: "question", id: "a", progress: 9 });
			writeProgramStatus(proxy, { state: "clear", app: "atelier", id: "a/b" });
			expect(written).toEqual([
				osc(`state=working:app=atelier:id=a/b:progress=40:title=${b64("Fix")}:msg=${b64("line")}`),
				osc("state=blocked:app=atelier:kind=question:id=a/b:progress=5"),
				osc("state=done:app=atelier:id=a"),
				osc("state=clear:app=atelier:id=a/b"),
			]);
		});

		it("cuts a title at 192 bytes and writes nothing for a bad id", () => {
			const { input, proxy, written } = observed();
			input.emit("data", REPLY);
			writeProgramStatus(proxy, { state: "idle", app: "atelier", id: "a", title: "é".repeat(150) });
			expect(written[0]).toContain(`title=${b64("é".repeat(96))}`);
			const bad = ["", "a//b", "a/ b", "x".repeat(33), `${"a/".repeat(8)}a`, `${"x".repeat(30)}/`.repeat(5)];
			for (const id of bad) writeProgramStatus(proxy, { state: "idle", app: "atelier", id });
			expect(written).toHaveLength(1);
		});

		it("writes nothing for an extended record without an answer", () => {
			const { proxy, written } = observed("1");
			writeProgramStatus(proxy, extended);
			writeProgramStatus(fakeTerminal(fakeInput()).terminal, extended);
			expect(written).toEqual([]);
		});
	});
});
