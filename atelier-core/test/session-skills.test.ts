import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEvent, type AtelierEventBody, FakeBackend, type FakeStep, Session } from "../src/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const BASE = "base prompt";

let home: string;
let cwd: string;
beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-skills-")));
	cwd = join(home, "proj");
	await mkdir(cwd);
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function put(path: string, text: string) {
	await mkdir(dirname(join(home, path)), { recursive: true });
	await writeFile(join(home, path), text);
}

async function start(steps: FakeStep[] = [{ event: finished }], extra: Record<string, unknown> = {}) {
	const backend = new FakeBackend([steps]);
	const session = await Session.start({ backend, cwd, tools: [], systemPromptAppend: BASE, ...extra });
	const events: AtelierEvent[] = [];
	for await (const event of session.send("hi")) events.push(event);
	await session.close();
	return { prompt: backend.startOptions?.systemPromptAppend ?? "", events };
}

describe("skills in a session", () => {
	it("lists each skill's name, description and SKILL.md path, never its body", async () => {
		await put(
			"proj/.agents/skills/pdf/SKILL.md",
			"---\nname: pdf\ndescription: Fill <PDF> forms & more.\n---\nSECRET BODY\n",
		);
		await put(".agents/skills/notes/SKILL.md", "---\nname: notes\ndescription: Take notes.\n---\nBody\n");
		const { prompt } = await start(undefined, { skills: { home } });
		expect(prompt).toBe(
			`${BASE}\n\n` +
				"The following skills provide specialized instructions for specific tasks.\n" +
				"When a task matches a skill's description, read its SKILL.md with the read tool before acting.\n" +
				"Resolve paths relative to a skill against its folder (the folder of its SKILL.md).\n\n" +
				"<available_skills>\n" +
				"  <skill>\n" +
				"    <name>pdf</name>\n" +
				"    <description>Fill &lt;PDF&gt; forms &amp; more.</description>\n" +
				`    <location>${join(cwd, ".agents/skills/pdf/SKILL.md")}</location>\n` +
				"  </skill>\n" +
				"  <skill>\n" +
				"    <name>notes</name>\n" +
				"    <description>Take notes.</description>\n" +
				`    <location>${join(home, ".agents/skills/notes/SKILL.md")}</location>\n` +
				"  </skill>\n" +
				"</available_skills>",
		);
		expect(prompt).not.toContain("BODY");
	});

	it("reports the skills and the warnings in the first turn, after the instructions", async () => {
		await put("proj/AGENTS.md", "rules");
		await put("proj/.agents/skills/ok/SKILL.md", "---\nname: ok\ndescription: Fine.\n---\n");
		await put("proj/.agents/skills/bad/SKILL.md", "---\nname: bad\n---\n");
		const { events, prompt } = await start(undefined, { skills: { home }, projectInstructions: { home } });
		expect(events.map(({ type }) => type).slice(0, 2)).toEqual(["project_instructions", "skills_loaded"]);
		expect(events.find((event) => event.type === "skills_loaded")).toMatchObject({
			skills: [{ name: "ok", path: join(cwd, ".agents/skills/ok/SKILL.md") }],
			warnings: [{ path: join(cwd, ".agents/skills/bad/SKILL.md"), message: "no description; not loaded" }],
		});
		expect(prompt.indexOf("rules")).toBeLessThan(prompt.indexOf("<available_skills>"));
	});

	it("says nothing and adds nothing without skills, or without the option", async () => {
		const none = await start(undefined, { skills: { home } });
		expect(none.prompt).toBe(BASE);
		expect(none.events.some(({ type }) => type === "skills_loaded")).toBe(false);

		await put("proj/.agents/skills/ok/SKILL.md", "---\nname: ok\ndescription: Fine.\n---\n");
		const off = await start();
		expect(off.prompt).toBe(BASE);
		expect(off.events.some(({ type }) => type === "skills_loaded")).toBe(false);
	});

	it("does not give the list to subagents", async () => {
		await put("proj/.agents/skills/ok/SKILL.md", "---\nname: ok\ndescription: Fine.\n---\n");
		const child = new FakeBackend([[{ event: { type: "text_delta", text: "r" } }, { event: finished }]]);
		await start(
			[{ toolCall: { tool: "task", input: { agent: "w", prompt: "x" } as never, callId: "t" } }, { event: finished }],
			{
				skills: { home },
				subagents: {
					agents: [{ name: "w", description: "w", tools: ["read"], prompt: "role", models: {}, maxRequests: 5 }],
					createBackend: () => child,
				},
			},
		);
		expect(child.startOptions?.systemPromptAppend).toBe("role");
	});
});

describe("herdr-app's guide in a session", () => {
	const inCore = { HC_TERMINAL_ID: "t1", TERM_PROGRAM: "ghostty" };
	const GUIDE = "# Herdr app\nGUIDE BODY\n";
	const loaded = (events: AtelierEvent[]) => events.find((event) => event.type === "skills_loaded");
	const entry = (location: string) =>
		expect.stringMatching(
			new RegExp(
				`<name>herdr-app</name>\\n    <description>[^<]*Herdr window[^<]*over 50 KB[^<]*offset and limit[^<]*herdr-app --skill[^<]*</description>\\n    <location>${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</location>`,
			),
		);

	it("lists the guide herdr-app writes in its home, never its body", async () => {
		await put(".config/herdr-app/AGENTS.md", GUIDE);
		const { prompt, events } = await start(undefined, { skills: { home, env: inCore } });
		const path = join(home, ".config/herdr-app/AGENTS.md");
		expect(prompt).toEqual(entry(path));
		expect(prompt).not.toContain("GUIDE BODY");
		expect(loaded(events)).toMatchObject({ skills: [{ name: "herdr-app", path }], warnings: [] });
	});

	it("finds it where herdr-app keeps its home: HERDR_APP_HOME, else XDG_CONFIG_HOME", async () => {
		await put(".config/herdr-app/AGENTS.md", GUIDE);
		await put("elsewhere/AGENTS.md", GUIDE);
		await put("xdg/herdr-app/AGENTS.md", GUIDE);
		const chosen = await start(undefined, {
			skills: { home, env: { ...inCore, HERDR_APP_HOME: join(home, "elsewhere"), XDG_CONFIG_HOME: join(home, "xdg") } },
		});
		expect(chosen.prompt).toEqual(entry(join(home, "elsewhere/AGENTS.md")));
		const xdg = await start(undefined, {
			skills: { home, env: { ...inCore, HERDR_APP_HOME: "", XDG_CONFIG_HOME: join(home, "xdg") } },
		});
		expect(xdg.prompt).toEqual(entry(join(home, "xdg/herdr-app/AGENTS.md")));
	});

	it("escapes the path in the list", async () => {
		await put("a&b<c>/AGENTS.md", GUIDE);
		const { prompt } = await start(undefined, {
			skills: { home, env: { ...inCore, HERDR_APP_HOME: join(home, "a&b<c>") } },
		});
		expect(prompt).toContain(`<location>${join(home, "a&amp;b&lt;c&gt;/AGENTS.md")}</location>`);
	});

	it("lists nothing outside herdr-core, without the file, or where herdr-app's home cannot be told", async () => {
		await put(".config/herdr-app/AGENTS.md", GUIDE);
		await put("rel/AGENTS.md", GUIDE);
		await mkdir(join(home, "folder/AGENTS.md"), { recursive: true });
		await put("bad\nline/AGENTS.md", GUIDE);
		for (const env of [
			{ TERM_PROGRAM: "ghostty" },
			{ ...inCore, HC_TERMINAL_ID: "" },
			{ ...inCore, HERDR_APP_HOME: join(home, "missing") },
			{ ...inCore, HERDR_APP_HOME: "rel" },
			{ ...inCore, HERDR_APP_HOME: "~/rel" },
			{ ...inCore, XDG_CONFIG_HOME: "." },
			{ ...inCore, HERDR_APP_HOME: join(home, "folder") },
			{ ...inCore, HERDR_APP_HOME: join(home, "bad\nline") },
		]) {
			const { prompt, events } = await start(undefined, { skills: { home, env } });
			expect(prompt).toBe(BASE);
			expect(loaded(events)).toBeUndefined();
		}
		const { prompt } = await start(undefined, { skills: { home } });
		expect(prompt).toBe(BASE);
	});

	it("lists it only when herdr-app is the nearest host of those in the environment", async () => {
		await put(".config/herdr-app/AGENTS.md", GUIDE);
		const herdr = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
		// An Orca pane, or a herdr pane, opened from a herdr-core terminal keeps HC_TERMINAL_ID.
		for (const env of [
			{ ...inCore, ORCA_PANE_KEY: "tab:1", TERM_PROGRAM: "Orca" },
			{ ...inCore, ...herdr, TERM_PROGRAM: "herdr" },
		]) {
			const { prompt, events } = await start(undefined, { skills: { home, env } });
			expect(prompt).toBe(BASE);
			expect(loaded(events)).toBeUndefined();
		}
		// A herdr-core terminal whose server was started in Orca or herdr inherits their variables.
		const path = join(home, ".config/herdr-app/AGENTS.md");
		for (const env of [
			{ ...inCore, ORCA_PANE_KEY: "tab:1" },
			{ ...inCore, ...herdr },
		]) {
			const { events } = await start(undefined, { skills: { home, env } });
			expect(loaded(events)).toMatchObject({ skills: [{ name: "herdr-app", path }] });
		}
	});

	it("gives way to a skill of the same name, and reports the guide as ignored", async () => {
		await put(".config/herdr-app/AGENTS.md", GUIDE);
		await put(".agents/skills/herdr-app/SKILL.md", "---\nname: herdr-app\ndescription: My own.\n---\n");
		const { prompt, events } = await start(undefined, { skills: { home, env: inCore } });
		const mine = join(home, ".agents/skills/herdr-app/SKILL.md");
		expect(prompt).toContain(`<description>My own.</description>\n    <location>${mine}</location>`);
		expect(prompt).not.toContain("AGENTS.md");
		expect(loaded(events)).toMatchObject({
			skills: [{ name: "herdr-app", path: mine }],
			warnings: [
				{
					path: join(home, ".config/herdr-app/AGENTS.md"),
					message: `skill "herdr-app" is already loaded from ${mine}; this one is ignored`,
				},
			],
		});
	});

	it("comes after the other skills and leaves out a guide the agent's read could not open", async () => {
		await put(".config/herdr-app/AGENTS.md", GUIDE);
		await put(".agents/skills/notes/SKILL.md", "---\nname: notes\ndescription: Take notes.\n---\n");
		const listed = await start(undefined, { skills: { home, env: inCore } });
		expect(loaded(listed.events)).toMatchObject({
			skills: [{ name: "notes" }, { name: "herdr-app" }],
		});

		await put(".claude/herdr-app/AGENTS.md", GUIDE);
		const hidden = await start(undefined, {
			skills: { home, env: { ...inCore, HERDR_APP_HOME: join(home, ".claude/herdr-app") } },
		});
		expect(hidden.prompt).not.toContain("herdr-app");
		expect(loaded(hidden.events)).toMatchObject({
			skills: [{ name: "notes" }],
			warnings: [
				{
					path: join(home, ".claude/herdr-app/AGENTS.md"),
					message: "it is in a protected location the agent cannot read; not loaded",
				},
			],
		});
	});
});
