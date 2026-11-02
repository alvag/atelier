import { EventEmitter } from "node:events";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProgramStatusReporter } from "../src/tui/program-status.ts";
import { observeProgramStatus } from "../src/tui/program-status-terminal.ts";

const noop = () => {};
const REPLY = "\x1b]7501;?\x07";
const CLEAR = "\x1b]7501;state=clear:app=atelier\x1b\\";
const STOP_CLEAR = "\x1b]7501;state=clear\x1b\\";
const b64 = (text: string) => Buffer.from(text).toString("base64");
const env = process.env.PI_PROGRAM_STATUS;
let out: string[];
let stop: (() => void) | undefined;
// biome-ignore lint/suspicious/noControlCharactersInRegex: capture status frames, not the probe query
const frames = () => out.join("").match(/\x1b\]7501;(?!\?)[^\x07\x1b]*(?:\x07|\x1b\\)/g) ?? [];
beforeEach(() => {
	delete process.env.PI_PROGRAM_STATUS;
	out = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out.push(String(chunk));
		return true;
	});
	const input = Object.assign(new EventEmitter(), {
		isRaw: false,
		setRawMode: noop,
		setEncoding: noop,
		resume: noop,
		pause: noop,
	});
	vi.stubGlobal("process", Object.create(process, { stdin: { value: input } }));
	vi.useFakeTimers();
});
afterEach(() => {
	stop?.();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (env === undefined) delete process.env.PI_PROGRAM_STATUS;
	else process.env.PI_PROGRAM_STATUS = env;
});
it("replays the cached root status with progress after a reply and a terminal restart", () => {
	const input = process.stdin as unknown as EventEmitter;
	const terminal = observeProgramStatus(new ProcessTerminal(), input as NodeJS.ReadStream);
	stop = () => terminal.stop();
	terminal.start(noop, noop);
	const reporter = new ProgramStatusReporter(terminal, 0);
	const msg = b64("msgx");
	reporter.report("working", { message: "msgx" });
	expect(frames()).toEqual([]);
	input.emit("data", REPLY);
	expect(frames()).toEqual([`\x1b]7501;state=working:app=atelier:msg=${msg}\x1b\\`]);
	out.length = 0;
	const tasks = Array.from({ length: 8 }, (_, i) => ({
		id: `T${i}`,
		title: "task",
		specs: [],
		status: i < 3 ? "done" : "pending",
	}));
	reporter.feature(tasks);
	reporter.report("working", { message: "msgx" });
	const enhanced = `\x1b]7501;state=working:app=atelier:progress=37:msg=${msg}\x1b\\`;
	expect(frames()).toEqual([enhanced]);
	out.length = 0;
	terminal.stop();
	expect(frames()).toEqual([STOP_CLEAR]);
	out.length = 0;
	terminal.start(noop, noop);
	input.emit("data", REPLY);
	expect(frames()).toEqual([enhanced]);
	out.length = 0;
	terminal.stop();
	terminal.start(noop, noop);
	input.emit("data", REPLY);
	expect(frames()).toEqual([STOP_CLEAR, enhanced]);
	out.length = 0;
	reporter.clear();
	terminal.stop();
	expect(frames()).toEqual([CLEAR]);
});
