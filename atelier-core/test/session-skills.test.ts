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
