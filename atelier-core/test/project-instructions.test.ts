import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEvent, FakeBackend, Session } from "../src/index.ts";
import { MAX_INSTRUCTIONS_BYTES } from "../src/project-instructions.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const BASE = "base prompt";

let home: string;
beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-instructions-")));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function put(path: string, text: string) {
	await mkdir(dirname(join(home, path)), { recursive: true });
	await writeFile(join(home, path), text);
}

async function start(cwd: string, enabled = true) {
	const backend = new FakeBackend([[{ event: { type: "turn_finished", stopReason: "end_turn", usage } }]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [],
		systemPromptAppend: BASE,
		...(enabled ? { projectInstructions: { home } } : {}),
	});
	const events: AtelierEvent[] = [];
	for await (const event of session.send("hi")) events.push(event);
	const prompt = backend.startOptions?.systemPromptAppend ?? "";
	const loaded = events.find((event) => event.type === "project_instructions");
	return { prompt, loaded, events, backend, session };
}

describe("project instructions", () => {
	it("adds a single AGENTS.md, preceded by its path", async () => {
		await put("proj/AGENTS.md", "Use tabs.");
		const { prompt, loaded } = await start(join(home, "proj"));
		expect(prompt).toBe(`${BASE}\n\nProject instructions from ${join(home, "proj", "AGENTS.md")}:\n\nUse tabs.`);
		expect(loaded).toMatchObject({ files: [join(home, "proj", "AGENTS.md")], dropped: [] });
	});

	it("falls back to CLAUDE.md when the folder has no AGENTS.md", async () => {
		await put("proj/CLAUDE.md", "Claude rules.");
		const { prompt, loaded } = await start(join(home, "proj"));
		expect(prompt).toContain(`${join(home, "proj", "CLAUDE.md")}:\n\nClaude rules.`);
		expect(loaded).toMatchObject({ files: [join(home, "proj", "CLAUDE.md")] });
	});

	it("prefers AGENTS.md over CLAUDE.md in the same folder", async () => {
		await put("proj/AGENTS.md", "agents text");
		await put("proj/CLAUDE.md", "claude text");
		const { prompt, loaded } = await start(join(home, "proj"));
		expect(prompt).toContain("agents text");
		expect(prompt).not.toContain("claude text");
		expect(loaded).toMatchObject({ files: [join(home, "proj", "AGENTS.md")] });
	});

	it("orders several levels from the outermost folder to the closest", async () => {
		await put("a/AGENTS.md", "outer");
		await put("a/b/CLAUDE.md", "middle");
		await put("a/b/c/AGENTS.md", "inner");
		const { prompt, loaded } = await start(join(home, "a", "b", "c"));
		expect(prompt.indexOf("outer")).toBeLessThan(prompt.indexOf("middle"));
		expect(prompt.indexOf("middle")).toBeLessThan(prompt.indexOf("inner"));
		expect(prompt.endsWith("inner")).toBe(true);
		expect(loaded).toMatchObject({
			files: [join(home, "a", "AGENTS.md"), join(home, "a", "b", "CLAUDE.md"), join(home, "a", "b", "c", "AGENTS.md")],
		});
	});

	it("stops before the home folder", async () => {
		await put("AGENTS.md", "home rules");
		await put("proj/AGENTS.md", "project rules");
		const { prompt } = await start(join(home, "proj"));
		expect(prompt).toContain("project rules");
		expect(prompt).not.toContain("home rules");
	});

	it("adds the user's ~/.agents/AGENTS.md first, before the project's files", async () => {
		await put(".agents/AGENTS.md", "Answer in Spanish.");
		await put("proj/AGENTS.md", "Use tabs.");
		const { prompt, loaded } = await start(join(home, "proj"));
		const user = join(home, ".agents", "AGENTS.md");
		const project = join(home, "proj", "AGENTS.md");
		expect(prompt).toBe(
			`${BASE}\n\nUser instructions from ${user}:\n\nAnswer in Spanish.\n\nProject instructions from ${project}:\n\nUse tabs.`,
		);
		expect(loaded).toMatchObject({ files: [user, project], dropped: [] });
	});

	it("drops the user's instructions before any project file when over the cap", async () => {
		await put(".agents/AGENTS.md", "u".repeat(MAX_INSTRUCTIONS_BYTES));
		await put("proj/AGENTS.md", "Use tabs.");
		const { prompt, loaded } = await start(join(home, "proj"));
		expect(prompt).not.toContain("User instructions");
		expect(loaded).toMatchObject({
			files: [join(home, "proj", "AGENTS.md")],
			dropped: [join(home, ".agents", "AGENTS.md")],
		});
	});

	it("changes nothing when no folder has instructions", async () => {
		await mkdir(join(home, "proj"), { recursive: true });
		const { prompt, loaded } = await start(join(home, "proj"));
		expect(prompt).toBe(BASE);
		expect(loaded).toBeUndefined();
	});

	it("changes nothing when the option is off", async () => {
		await put("proj/AGENTS.md", "rules");
		const { prompt, loaded } = await start(join(home, "proj"), false);
		expect(prompt).toBe(BASE);
		expect(loaded).toBeUndefined();
	});

	it("drops the outermost files first when over the cap, and says which", async () => {
		const big = "x".repeat(MAX_INSTRUCTIONS_BYTES / 2 - 200);
		await put("a/AGENTS.md", big);
		await put("a/b/AGENTS.md", big);
		await put("a/b/c/AGENTS.md", big);
		const { prompt, loaded } = await start(join(home, "a", "b", "c"));
		expect(prompt).not.toContain(join(home, "a", "AGENTS.md"));
		expect(prompt).toContain(join(home, "a", "b", "AGENTS.md"));
		expect(prompt).toContain(join(home, "a", "b", "c", "AGENTS.md"));
		expect(loaded).toMatchObject({
			files: [join(home, "a", "b", "AGENTS.md"), join(home, "a", "b", "c", "AGENTS.md")],
			dropped: [join(home, "a", "AGENTS.md")],
		});
		expect(Buffer.byteLength(prompt) - BASE.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES + 2);
	});

	it("reports the files before anything else in the first turn", async () => {
		await put("proj/AGENTS.md", "rules");
		const { events } = await start(join(home, "proj"));
		expect(events[0]?.type).toBe("project_instructions");
	});
});
