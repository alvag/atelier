import { describe, expect, it } from "vitest";
import { detectHost } from "../src/index.ts";

const ORCA = { ORCA_PANE_KEY: "tab:1" };
const HERDR = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const HERDR_APP = { HC_TERMINAL_ID: "t1" };

describe("detectHost", () => {
	it("tells each host by its own variable", () => {
		expect(detectHost({ ...ORCA, TERM_PROGRAM: "Orca" })).toEqual({
			kind: "orca",
			seen: ["orca"],
			supports: { notifications: "bell", herdrAppSkill: false, herdrPanes: false },
		});
		expect(detectHost({ ...HERDR, TERM_PROGRAM: "herdr" })).toEqual({
			kind: "herdr",
			seen: ["herdr"],
			supports: { notifications: "host", herdrAppSkill: false, herdrPanes: true },
			herdr: { paneId: "w1:p1", socketPath: "/tmp/herdr.sock" },
		});
		expect(detectHost({ ...HERDR_APP, TERM_PROGRAM: "ghostty" })).toEqual({
			kind: "herdr-app",
			seen: ["herdr-app"],
			supports: { notifications: "host", herdrAppSkill: true, herdrPanes: false },
		});
		expect(detectHost({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" })).toEqual({
			kind: "other",
			seen: [],
			supports: { notifications: "terminal", herdrAppSkill: false, herdrPanes: false },
		});
	});

	it("takes HERDR_ENV=1 alone as herdr, leaving the pane and socket to the reporter", () => {
		expect(detectHost({ HERDR_ENV: "1" })).toMatchObject({
			kind: "herdr",
			supports: { herdrPanes: true },
			herdr: { paneId: undefined, socketPath: undefined },
		});
		expect(detectHost({ ...HERDR, HERDR_PANE_ID: " w1:p1 " }).herdr).toEqual({
			paneId: " w1:p1 ",
			socketPath: "/tmp/herdr.sock",
		});
	});

	it("takes an empty value, or HERDR_ENV other than 1, as no host", () => {
		for (const env of [
			{ ORCA_PANE_KEY: "" },
			{ HC_TERMINAL_ID: "" },
			{ HERDR_ENV: "" },
			{ ...HERDR, HERDR_ENV: "0" },
			{ ORCA_PANE_KEY: "", HC_TERMINAL_ID: "", HERDR_ENV: "", TERM_PROGRAM: "Orca" },
		]) {
			expect(detectHost(env)).toMatchObject({ kind: "other", seen: [] });
		}
		expect(detectHost({ ...ORCA, HC_TERMINAL_ID: "", TERM_PROGRAM: "ghostty" })).toMatchObject({
			kind: "orca",
			seen: ["orca"],
		});
	});

	it("keeps one host's answer whatever TERM_PROGRAM says", () => {
		expect(detectHost({ ...HERDR_APP, TERM_PROGRAM: "Orca" }).kind).toBe("herdr-app");
		expect(detectHost({ ...ORCA, TERM_PROGRAM: "herdr" }).kind).toBe("orca");
		expect(detectHost({ ...HERDR, TERM_PROGRAM: "ghostty" }).kind).toBe("herdr");
	});
});

describe("detectHost with nested hosts", () => {
	it("takes an Orca pane with herdr-core's variables, as Orca stamps TERM_PROGRAM=Orca", () => {
		expect(detectHost({ ...ORCA, ...HERDR_APP, TERM_PROGRAM: "Orca" })).toEqual({
			kind: "orca",
			seen: ["orca", "herdr-app"],
			supports: { notifications: "bell", herdrAppSkill: false, herdrPanes: false },
		});
		expect(detectHost({ ...ORCA, ...HERDR, TERM_PROGRAM: "Orca" })).toMatchObject({
			kind: "orca",
			seen: ["orca", "herdr"],
		});
	});

	it("takes a herdr pane as herdr, as herdr-core would have turned TERM_PROGRAM=herdr into ghostty", () => {
		expect(detectHost({ ...HERDR, ...HERDR_APP, TERM_PROGRAM: "herdr" })).toEqual({
			kind: "herdr",
			seen: ["herdr", "herdr-app"],
			supports: { notifications: "host", herdrAppSkill: false, herdrPanes: true },
			herdr: { paneId: "w1:p1", socketPath: "/tmp/herdr.sock" },
		});
		expect(detectHost({ ...HERDR, ...ORCA, TERM_PROGRAM: "herdr" })).toMatchObject({
			kind: "herdr",
			seen: ["herdr", "orca"],
		});
	});

	it("takes herdr-app's terminal over another host's variables it inherited from herdr-core's server", () => {
		expect(detectHost({ ...HERDR, ...HERDR_APP, TERM_PROGRAM: "ghostty" })).toEqual({
			kind: "herdr-app",
			seen: ["herdr-app", "herdr"],
			supports: { notifications: "host", herdrAppSkill: true, herdrPanes: false },
		});
		expect(detectHost({ ...ORCA, ...HERDR_APP, TERM_PROGRAM: "ghostty" })).toMatchObject({
			kind: "herdr-app",
			seen: ["herdr-app", "orca"],
		});
		expect(detectHost({ ...ORCA, ...HERDR_APP })).toMatchObject({ kind: "herdr-app" });
	});

	it("takes `hc run` from an Orca pane, with herdr-core's server started in Orca, as Orca", () => {
		// The terminal gets the caller's TERM_PROGRAM and the server's stale ORCA_PANE_KEY: it reads as an Orca pane.
		expect(detectHost({ ORCA_PANE_KEY: "tab:old", HC_TERMINAL_ID: "t7", TERM_PROGRAM: "Orca" })).toMatchObject({
			kind: "orca",
			seen: ["orca", "herdr-app"],
		});
	});

	it("falls back to herdr-app, then herdr, then Orca when TERM_PROGRAM names none of them", () => {
		expect(detectHost({ ...ORCA, ...HERDR, ...HERDR_APP, TERM_PROGRAM: "ghostty" })).toMatchObject({
			kind: "herdr-app",
			seen: ["herdr-app", "herdr", "orca"],
		});
		expect(detectHost({ ...ORCA, ...HERDR, TERM_PROGRAM: "WezTerm" })).toMatchObject({
			kind: "herdr",
			seen: ["herdr", "orca"],
		});
		expect(detectHost({ ...ORCA, ...HERDR, ...HERDR_APP, TERM_PROGRAM: "Orca" })).toMatchObject({
			kind: "orca",
			seen: ["orca", "herdr-app", "herdr"],
		});
	});
});
