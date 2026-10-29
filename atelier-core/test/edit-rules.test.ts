import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalAnswer,
	type ApprovalRequest,
	type AtelierEvent,
	FakeBackend,
	type FakeStep,
	PermissionRules,
	Session,
} from "../src/index.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

let base: string;
let cwd: string;
let notes: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-edit-rules-")));
	cwd = join(base, "work");
	notes = join(base, "notes");
	home = join(base, "home");
	for (const dir of [cwd, join(notes, "sub"), join(base, "other"), join(home, ".atelier")])
		await mkdir(dir, { recursive: true });
	await writeFile(join(notes, "a.txt"), "alpha\n");
	await writeFile(join(home, "todo.txt"), "alpha\n");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const writeCall = (path: string, callId: string): FakeStep => ({
	toolCall: { tool: "write", input: { path, content: "written\n" }, callId },
});
const editCall = (path: string, callId: string): FakeStep => ({
	toolCall: { tool: "edit", input: { path, edits: [{ oldText: "alpha", newText: "beta" }] }, callId },
});

/** Runs one turn of calls, answering each question with the next answer (then no). */
async function run(calls: FakeStep[], answers: ApprovalAnswer[] = [], rules = new PermissionRules({ home })) {
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[...calls, finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createEditTool({ home }), createWriteTool({ home })],
		permissionRules: rules,
		approve: async (request) => {
			questions.push(request);
			return answers[questions.length - 1] ?? false;
		},
	});
	const events: AtelierEvent[] = [];
	for await (const event of session.send("go")) events.push(event);
	return { questions, results: backend.toolResults, rules };
}

describe("folder rules for edit and write", () => {
	it("offers the file's folder, and Allow in this session lets edit and write in it and below", async () => {
		const { questions, results, rules } = await run(
			[
				editCall(join(notes, "a.txt"), "e1"),
				writeCall(join(notes, "sub", "b.txt"), "w1"),
				writeCall(join(base, "other", "c.txt"), "w2"),
			],
			[{ remember: "session" }],
		);
		expect(questions.map(({ callId, remember }) => ({ callId, remember }))).toEqual([
			{ callId: "e1", remember: { rules: [notes], always: true } },
			{ callId: "w2", remember: { rules: [join(base, "other")], always: true } },
		]);
		expect(results.map(({ ok }) => ok)).toEqual([true, true, false]);
		expect(await readFile(join(notes, "sub", "b.txt"), "utf8")).toBe("written\n");
		expect(await rules.list()).toEqual([expect.objectContaining({ scope: "session", kind: "path", value: notes })]);
	});

	it("Allow always saves the folder for every session", async () => {
		await run([editCall(join(notes, "a.txt"), "e1")], [{ remember: "always" }]);
		expect(JSON.parse(await readFile(join(home, ".atelier", "permissions.json"), "utf8")).allow).toEqual([
			{ path: notes },
		]);
		const later = await run([writeCall(join(notes, "new.txt"), "w1")]);
		expect(later.questions).toEqual([]);
		expect(later.results[0]?.ok).toBe(true);
	});

	it("offers the file alone when its folder is the home directory", async () => {
		const { questions } = await run([editCall(join(home, "todo.txt"), "e1")], [{ remember: "session" }]);
		expect(questions[0]?.remember).toEqual({ rules: [join(home, "todo.txt")], always: true });
	});

	it("never lets a rule reach the rules saved for projects", async () => {
		const rules = new PermissionRules({ home });
		await rules.allow([{ kind: "path", value: join(home, ".atelier") }], "session");
		const target = join(home, ".atelier", "project-permissions.json");
		const { questions, results } = await run([writeCall(target, "w1"), editCall(target, "e1")], [], rules);
		expect(questions).toEqual([]);
		expect(results.map(({ ok }) => ok)).toEqual([false, false]);
		expect(results[0]?.output).toContain("protected");
	});

	it("never lets a rule reach ~/.atelier", async () => {
		const rules = new PermissionRules({ home });
		await rules.allow([{ kind: "path", value: join(home, ".atelier") }], "session");
		const { questions, results } = await run([writeCall(join(home, ".atelier", "permissions.json"), "w1")], [], rules);
		expect(questions).toEqual([]);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.output).toContain("protected");
	});
});
