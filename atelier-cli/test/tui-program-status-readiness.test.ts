import { PassThrough } from "node:stream";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeProgramStatus, onProgramStatusReady, writeProgramStatus } from "../src/tui/program-status-terminal.ts";

const REPLY = "\x1b]7501;?\x1b\\";
const ROOT = "\x1b]7501;state=working:app=atelier:progress=25\x1b\\";
let events: string[];
let input: PassThrough;
let terminal: Terminal;

beforeEach(() => {
	// Armed whatever the runner's environment says.
	vi.stubEnv("PI_PROGRAM_STATUS", "");
	events = [];
	input = new PassThrough();
	const fake = {
		start: () => {},
		stop: () => {},
		write: (data: string) => {
			events.push(data);
		},
		setProgramStatus: () => {},
	};
	terminal = observeProgramStatus(fake as unknown as Terminal, input);
});
afterEach(() => {
	try {
		terminal.stop();
	} finally {
		input.destroy();
		vi.unstubAllEnvs();
	}
});

const noop = () => {};
const begin = () => terminal.start(noop, noop);

/** Sends a reply and waits until the input has delivered it to the watcher. */
async function reply() {
	input.write(REPLY);
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

it("calls a subscriber once per positive reply and keeps it across restarts until disposed", async () => {
	const dispose = onProgramStatusReady(terminal, () => events.push("ready"));
	begin();
	await reply();
	expect(events).toEqual(["ready"]);
	await reply();
	expect(events).toEqual(["ready"]);

	writeProgramStatus(terminal, { state: "working", app: "atelier", progress: 25 });
	expect(events).toEqual(["ready", ROOT]);

	terminal.stop();
	begin();
	await reply();
	expect(events).toEqual(["ready", ROOT, ROOT, "ready"]);

	dispose();
	terminal.stop();
	begin();
	await reply();
	expect(events).toEqual(["ready", ROOT, ROOT, "ready", ROOT]);
});
