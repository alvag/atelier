import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	listTasks,
	parseFeatureDoc,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { ODD_RULES, SYSTEM_PROMPT_APPEND } from "../src/prompt.ts";
import { editTool } from "../src/tools/edit.ts";
import { defineTool } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const call = (tool: string, input: Record<string, unknown>, callId = `c-${tool}`): FakeStep => ({
	toolCall: { tool, input: input as never, callId },
});

const stub = (name: string) =>
	defineTool({
		name,
		description: name,
		inputShape: { path: z.string().optional(), command: z.string().optional() },
		execute: async () => ({ ok: true, output: `${name} ran`, summary: name, truncated: false }),
	});
const tools = ["read", "edit", "bash", "grep"].map(stub);

const START = {
	action: "start",
	name: "slug-accents",
	title: "Slug accents",
	header: "Make slugs handle accents.",
	specs: ['User, verbatim: "haz que slugify maneje acentos"'],
	tasks: [
		{ title: "Transliterate accents", specs: ["S1"], route: "inline" },
		{ title: "Run the tests", specs: ["S1"], route: "inline" },
	],
};

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-odd-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

const docPath = () => join(cwd, "odd/tasks/slug-accents.md");

async function session(turns: FakeStep[][], extra: Partial<SessionOptions> = {}) {
	const backend = new FakeBackend(turns);
	const s = await Session.start({ backend, cwd, tools, odd: true, ...extra });
	const send = async (prompt: string) => {
		const events: AtelierEvent[] = [];
		for await (const event of s.send(prompt)) events.push(event);
		return events;
	};
	return { backend, session: s, send };
}

describe("feature tool", () => {
	it("is offered only when ODD is on, and never to subagents", async () => {
		const plain = new FakeBackend([]);
		await (await Session.start({ backend: plain, cwd, tools })).close();
		expect(plain.startOptions?.tools.map((t) => t.name)).toEqual(["read", "edit", "bash", "grep"]);

		const child = new FakeBackend([[{ event: { type: "text_delta", text: "r" } }, { event: finished }]]);
		const {
			backend,
			session: s,
			send,
		} = await session([[call("task", { agent: "worker", prompt: "x" }), { event: finished }]], {
			subagents: {
				agents: [
					{
						name: "worker",
						description: "w",
						tools: ["read", "feature", "phase"],
						prompt: "p",
						models: {},
						maxRequests: 5,
					},
				],
				createBackend: () => child,
			},
		});
		await send("go");
		await s.close();
		expect(backend.startOptions?.tools.map((t) => t.name)).toEqual([
			"read",
			"edit",
			"bash",
			"grep",
			"task",
			"feature",
			"phase",
		]);
		expect(child.startOptions?.tools.map((t) => t.name)).toEqual(["read"]);
	});

	it("starts a feature: writes the canonical file with the user's first words verbatim as L1", async () => {
		const first = 'haz que slugify maneje acentos\n(y "comillas")';
		const { backend, session: s, send } = await session([[call("feature", START), { event: finished }]]);
		const events = await send(first);
		await s.close();
		const text = await readFile(docPath(), "utf8");
		expect(text).toBe(
			[
				"# Slug accents",
				"",
				"Make slugs handle accents.",
				"",
				"## Specs",
				"",
				'- **S1** — User, verbatim: "haz que slugify maneje acentos"',
				"",
				"## Tasks",
				"",
				"| ID | Specs | Ruta | Entregable | Estado |",
				"|---|---|---|---|---|",
				"| T1 | S1 | inline | Transliterate accents | pending |",
				"| T2 | S1 | inline | Run the tests | pending |",
				"",
				"## Log",
				"",
				'- **L1** — Usuario: "haz que slugify maneje acentos',
				'  (y "comillas")"',
				"",
			].join("\n"),
		);
		expect(parseFeatureDoc(text).log[0]?.text).toBe(`Usuario: "${first}"`);
		expect(backend.toolResults[0]?.ok).toBe(true);
		expect(backend.toolResults[0]?.output).toContain("T1 [pending] Transliterate accents");
		expect(events.filter((e) => e.type === "feature_changed")).toEqual([
			expect.objectContaining({
				name: "slug-accents",
				path: "odd/tasks/slug-accents.md",
				title: "Slug accents",
				tasks: [
					{ id: "T1", title: "Transliterate accents", status: "pending", specs: ["S1"] },
					{ id: "T2", title: "Run the tests", status: "pending", specs: ["S1"] },
				],
			}),
		]);
	});

	it("logs every later user message verbatim while the feature is active", async () => {
		const { session: s, send } = await session([
			[{ event: finished }],
			[call("feature", START), { event: finished }],
			[{ event: finished }],
		]);
		await send("first words");
		await send("now track it");
		await send("  y corregí T2  ");
		await s.close();
		expect(parseFeatureDoc(await readFile(docPath(), "utf8")).log).toEqual([
			{ id: "L1", text: 'Usuario: "first words"' },
			{ id: "L2", text: 'Usuario: "now track it"' },
			{ id: "L3", text: 'Usuario: "  y corregí T2  "' },
		]);
	});

	it("updates tasks and lets the model add only its own notes", async () => {
		const {
			backend,
			session: s,
			send,
		} = await session([
			[
				call("feature", START, "s"),
				call("feature", { action: "update_task", id: "T1", status: "done", commit: "abc1234" }, "u"),
				call("feature", { action: "log", text: 'Usuario: "fake quote"' }, "l"),
				{ event: finished },
			],
		]);
		const events = await send("go");
		await s.close();
		const doc = parseFeatureDoc(await readFile(docPath(), "utf8"));
		expect(listTasks(doc)[0]).toMatchObject({ id: "T1", status: "done", commit: "abc1234" });
		expect(doc.log.map((l) => l.text)).toEqual(['Usuario: "go"', 'Agente: Usuario: "fake quote"']);
		expect(backend.toolResults.every((r) => r.ok)).toBe(true);
		expect(events.filter((e) => e.type === "feature_changed")).toHaveLength(3);
	});

	it.each([
		["an invalid status", { action: "update_task", id: "T1", status: "finished" }, /status/],
		["an unknown task", { action: "update_task", id: "T9", status: "done" }, /T9/],
		[
			"a task citing a missing spec",
			{ action: "add_task", task: { title: "x", specs: ["S5"], route: "inline" } },
			/S5/,
		],
		["a start over an existing feature", START, /already exists/],
	])("rejects %s without touching the file", async (_name, input, reason) => {
		const {
			backend,
			session: s,
			send,
		} = await session([[call("feature", START, "s"), call("feature", input, "bad"), { event: finished }]]);
		await send("go");
		const before = await readFile(docPath(), "utf8");
		await s.close();
		expect(backend.toolResults[1]?.ok).toBe(false);
		expect(backend.toolResults[1]?.output).toMatch(reason);
		expect(await readFile(docPath(), "utf8")).toBe(before);
	});

	it.each([
		["a name that leaves odd/tasks", { ...START, name: "../escape" }],
		["an action without an active feature", { action: "update_task", id: "T1", status: "done" }],
	])("rejects %s", async (_name, input) => {
		const { backend, session: s, send } = await session([[call("feature", input), { event: finished }]]);
		await send("go");
		await s.close();
		expect(backend.toolResults[0]?.ok).toBe(false);
	});

	it("opens an existing feature to resume it, returning its specs and tasks and logging the new session's words", async () => {
		await mkdir(join(cwd, "odd/tasks"), { recursive: true });
		const existing =
			'# Slug accents\n\n## Specs\n\n- **S1** — a\n\n## Tasks\n\n| ID | Specs | Ruta | Entregable | Estado |\n|---|---|---|---|---|\n| T1 | S1 | inline | Do it | pending |\n\n## Log\n\n- **L1** — Usuario: "old"\n';
		await writeFile(docPath(), existing);
		const {
			backend,
			session: s,
			send,
		} = await session([[call("feature", { action: "open", name: "slug-accents" }), { event: finished }]]);
		const events = await send("seguí con slug-accents");
		await s.close();
		expect(backend.toolResults[0]).toEqual({
			ok: true,
			output: expect.stringContaining("T1 [pending] Do it (S1)"),
		});
		// Compact: the specs to work from, not the whole history.
		expect(backend.toolResults[0]?.output).toContain("S1 — a");
		expect(backend.toolResults[0]?.output).not.toContain('Usuario: "old"');
		expect(parseFeatureDoc(await readFile(docPath(), "utf8")).log.map((l) => l.text)).toEqual([
			'Usuario: "old"',
			'Usuario: "seguí con slug-accents"',
		]);
		expect(events.some((e) => e.type === "feature_changed")).toBe(true);
	});

	it("refuses to open a malformed document and says why", async () => {
		await mkdir(join(cwd, "odd/tasks"), { recursive: true });
		await writeFile(docPath(), "# X\n\n## Specs\n\n- **S1** — a\n");
		const {
			backend,
			session: s,
			send,
		} = await session([[call("feature", { action: "open", name: "slug-accents" }), { event: finished }]]);
		await send("go");
		await s.close();
		expect(backend.toolResults[0]?.ok).toBe(false);
		expect(backend.toolResults[0]?.output).toMatch(/## Tasks/);
	});
});

describe("feature transactions", () => {
	it("keeps both of two concurrent changes", async () => {
		const { backend, session: s, send } = await session([[call("feature", START), { event: finished }]]);
		try {
			await send("original");
			const execute = backend.startOptions?.executeTool as NonNullable<typeof backend.startOptions>["executeTool"];
			const results = await Promise.all(
				["alpha", "beta"].map((text) => execute({ tool: "feature", input: { action: "log", text } })),
			);
			expect(results.every((r) => r.ok)).toBe(true);
			expect(parseFeatureDoc(await readFile(docPath(), "utf8")).log.map((l) => l.text)).toEqual([
				'Usuario: "original"',
				"Agente: alpha",
				"Agente: beta",
			]);
		} finally {
			await s.close();
		}
	});

	it("keeps memory in step with the disk when a write fails, and retries the user's words later", async () => {
		const {
			backend,
			session: s,
			send,
		} = await session([
			[call("feature", START), { event: finished }],
			[{ event: finished }],
			[call("feature", { action: "show" }), { event: finished }],
			[{ event: finished }],
		]);
		try {
			await send("first");
			await chmod(join(cwd, "odd/tasks"), 0o500);
			const failedTurn = await send("second");
			expect(failedTurn.filter((e) => e.type === "error")).toEqual([
				expect.objectContaining({ code: "odd_log_failed", recoverable: true }),
			]);
			await send("third");
			expect(backend.toolResults.at(-1)?.output).toContain("Log: 1 entries.");
			await chmod(join(cwd, "odd/tasks"), 0o755);
			await send("fourth");
		} finally {
			await chmod(join(cwd, "odd/tasks"), 0o755);
			await s.close();
		}
		expect(parseFeatureDoc(await readFile(docPath(), "utf8")).log.map((l) => l.text)).toEqual([
			'Usuario: "first"',
			'Usuario: "second"',
			'Usuario: "third"',
			'Usuario: "fourth"',
		]);
	});

	it("finishes a feature action that started before the session closed, and refuses new ones after", async () => {
		const { backend, session: s, send } = await session([[{ event: finished }]]);
		await send("go");
		const execute = backend.startOptions?.executeTool as NonNullable<typeof backend.startOptions>["executeTool"];
		const started = execute({ tool: "feature", input: START });
		await s.close();
		expect(await readFile(docPath(), "utf8")).toContain("# Slug accents");
		expect((await started).ok).toBe(true);
		const late = await execute({ tool: "feature", input: { action: "show" } });
		expect(late.ok).toBe(false);
	});
});

describe("edit guard", () => {
	it("refuses to edit odd/tasks/, whatever the case, and still edits other files", async () => {
		await mkdir(join(cwd, "odd/tasks"), { recursive: true });
		await writeFile(join(cwd, "odd/tasks/x.md"), "# X\n");
		await writeFile(join(cwd, "notes.md"), "# X\n");
		const edits = [{ oldText: "# X", newText: "# Y" }];
		for (const path of ["odd/tasks/x.md", "ODD/Tasks/x.md", "./odd/../odd/tasks/x.md"]) {
			const outcome = await editTool.execute({ path, edits }, { cwd });
			expect(outcome.ok, path).toBe(false);
			expect(outcome.output).toMatch(/feature tool/);
		}
		expect(await readFile(join(cwd, "odd/tasks/x.md"), "utf8")).toBe("# X\n");
		expect((await editTool.execute({ path: "notes.md", edits }, { cwd })).ok).toBe(true);
	});

	it("refuses a feature document reached through a symlinked odd/tasks", async () => {
		await mkdir(join(cwd, "stored"));
		await mkdir(join(cwd, "odd"));
		await symlink(join(cwd, "stored"), join(cwd, "odd/tasks"));
		await writeFile(join(cwd, "stored/x.md"), "# X\n");
		const outcome = await editTool.execute(
			{ path: "odd/tasks/x.md", edits: [{ oldText: "# X", newText: "# Y" }] },
			{ cwd },
		);
		expect(outcome.ok).toBe(false);
		expect(await readFile(join(cwd, "stored/x.md"), "utf8")).toBe("# X\n");
	});
});

describe("phases", () => {
	const phases = (events: AtelierEvent[]) =>
		events.flatMap((e) => (e.type === "phase_changed" ? [`${e.phase}:${e.source}`] : []));

	it("infers the phase from the tools and announces only changes", async () => {
		const { session: s, send } = await session([
			[
				call("read", { path: "a" }, "1"),
				call("grep", {}, "2"),
				call("edit", { path: "a" }, "3"),
				call("bash", { command: "npm test" }, "4"),
				call("bash", { command: "ls" }, "5"),
				call("phase", { phase: "closing" }, "6"),
				{ event: finished },
			],
		]);
		const events = await send("go");
		await s.close();
		expect(phases(events)).toEqual([
			"exploring:inferred",
			"implementing:inferred",
			"checking:inferred",
			"closing:declared",
		]);
	});

	it.each([
		["npm test", true],
		["pnpm run test -- slug", true],
		["cd app && yarn test", true],
		["node --test", true],
		["npx vitest run", true],
		["python -m pytest -q", true],
		["go test ./...", true],
		["cargo test", true],
		["make test", true],
		["cat package.json src/slug.js test/slug.test.js", false],
		["cat >> test/slug.test.js <<'EOF'", false],
		["ls tests/", false],
		["grep -rn latest .", false],
	])("treats `%s` as running tests: %s", async (command, checks) => {
		const { session: s, send } = await session([[call("bash", { command }), { event: finished }]]);
		const events = await send("go");
		await s.close();
		expect(phases(events)).toEqual(checks ? ["checking:inferred"] : []);
	});

	it("rejects an unknown phase", async () => {
		const {
			backend,
			session: s,
			send,
		} = await session([[call("phase", { phase: "researching" }), { event: finished }]]);
		const events = await send("go");
		await s.close();
		expect(backend.toolResults[0]?.ok).toBe(false);
		expect(phases(events)).toEqual([]);
	});

	it("plans when a feature starts", async () => {
		const { session: s, send } = await session([[call("feature", START), { event: finished }]]);
		const events = await send("go");
		await s.close();
		expect(phases(events)).toEqual(["planning:inferred"]);
	});
});

describe("ODD rules in the prompt", () => {
	it("are appended only when ODD is on, after the session's own text, and stay small", async () => {
		const plain = new FakeBackend([]);
		await (await Session.start({ backend: plain, cwd, tools, systemPromptAppend: "BASE" })).close();
		expect(plain.startOptions?.systemPromptAppend).toBe("BASE");

		const odd = new FakeBackend([]);
		await (await Session.start({ backend: odd, cwd, tools, systemPromptAppend: "BASE", odd: true })).close();
		expect(odd.startOptions?.systemPromptAppend).toBe(`BASE\n\n${ODD_RULES}`);
		expect(Buffer.byteLength(ODD_RULES)).toBeLessThanOrEqual(1200);
		for (const word of ["feature", "open", "in_progress", "done", "phase"]) expect(ODD_RULES).toContain(word);
	});

	it("no longer lists a fixed set of tools in the shared prompt", () => {
		expect(SYSTEM_PROMPT_APPEND).not.toContain("(read, edit, bash, grep)");
	});
});
