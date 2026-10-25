import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	type AtelierEvent,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import type { SubagentDefinition } from "../src/subagents/definitions.ts";
import { bashTool, createEditTool, createReadTool } from "../src/tools/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

let base: string;
let cwd: string;
let outside: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-edit-outside-")));
	cwd = join(base, "work");
	outside = join(base, "outside");
	home = join(base, "home");
	for (const dir of [cwd, outside, join(home, ".ssh"), join(home, ".atelier"), join(base, "shared")])
		await mkdir(dir, { recursive: true });
	await writeFile(join(cwd, "inside.txt"), "alpha\n");
	await writeFile(join(outside, "x.txt"), "alpha\n");
	await writeFile(join(outside, "y.txt"), "alpha\n");
	await writeFile(join(outside, ".env"), "alpha\n");
	await writeFile(join(outside, "server.pem"), "alpha\n");
	await writeFile(join(home, ".ssh", "config"), "alpha\n");
	await writeFile(join(base, "shared", "z.txt"), "alpha\n");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const editCall = (path: string, callId: string): FakeStep => ({
	toolCall: { tool: "edit", input: { path, edits: [{ oldText: "alpha", newText: "beta" }] }, callId },
});
const text = (path: string) => readFile(path, "utf8");

/** Runs one turn that makes the given edit calls, answering every question with `answer`. */
async function run(calls: string[], options: { answer?: boolean; ask?: boolean } & Partial<SessionOptions> = {}) {
	const { answer = true, ask = true, ...rest } = options;
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[...calls.map((path, i) => editCall(path, `e${i + 1}`)), finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createEditTool({ home })],
		...(ask
			? {
					approve: async (request: ApprovalRequest) => {
						questions.push(request);
						return answer;
					},
				}
			: {}),
		...rest,
	});
	const events: AtelierEvent[] = [];
	for await (const event of session.send("go")) events.push(event);
	await session.close();
	return { questions, events, results: backend.toolResults };
}

describe("edit where the agent could always write", () => {
	it("does not ask inside the working directory", async () => {
		const { questions, results } = await run(["inside.txt"]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(join(cwd, "inside.txt"))).toBe("beta\n");
	});

	it("does not ask inside a directory the configuration allows writing", async () => {
		await writeFile(join(home, ".atelier", "sandbox.json"), JSON.stringify({ allowWrite: [outside] }));
		const { questions, results } = await run([join(outside, "x.txt")]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(join(outside, "x.txt"))).toBe("beta\n");
	});

	it("does not ask inside the session's scratch directory", async () => {
		const tool = createEditTool({ home });
		const scratchDir = join(base, "scratch");
		await mkdir(scratchDir);
		await writeFile(join(scratchDir, "s.txt"), "alpha\n");
		const outcome = await tool.execute(
			{ path: join(scratchDir, "s.txt"), edits: [{ oldText: "alpha", newText: "beta" }] },
			{ cwd, scratchDir },
		);
		expect(outcome.ok).toBe(true);
		expect(await text(join(scratchDir, "s.txt"))).toBe("beta\n");
	});
});

describe("edit outside the working directory", () => {
	it("asks with the real absolute path, always, and writes after approval", async () => {
		const { questions, events, results } = await run(["../outside/x.txt"]);
		expect(questions).toEqual([
			{
				callId: "e1",
				command: `edit ${join(outside, "x.txt")}`,
				reason: "outside the working directory",
				always: true,
				tool: "edit",
			},
		]);
		expect(events.find((e) => e.type === "approval_requested")).toMatchObject({
			command: `edit ${join(outside, "x.txt")}`,
			reason: "outside the working directory",
			tool: "edit",
		});
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(join(outside, "x.txt"))).toBe("beta\n");
	});

	it("asks even with autoApprove (--yes)", async () => {
		const { questions } = await run([join(outside, "x.txt")], { autoApprove: true });
		expect(questions).toHaveLength(1);
	});

	it("keeps an approved file allowed for the session, and asks again for another file", async () => {
		const backend = new FakeBackend([
			[editCall(join(outside, "x.txt"), "e1"), finished],
			[
				{
					toolCall: {
						tool: "edit",
						input: { path: join(outside, "x.txt"), edits: [{ oldText: "beta", newText: "gamma" }] },
						callId: "e2",
					},
				},
				editCall(join(outside, "y.txt"), "e3"),
				finished,
			],
		]);
		const questions: string[] = [];
		const session = await Session.start({
			backend,
			cwd,
			tools: [createEditTool({ home })],
			approve: async ({ command }) => {
				questions.push(command);
				return true;
			},
		});
		for await (const _ of session.send("one"));
		for await (const _ of session.send("two"));
		await session.close();
		expect(questions).toEqual([`edit ${join(outside, "x.txt")}`, `edit ${join(outside, "y.txt")}`]);
		expect(await text(join(outside, "x.txt"))).toBe("gamma\n");
		expect(await text(join(outside, "y.txt"))).toBe("beta\n");
	});

	it("leaves the file untouched and says so when the user denies", async () => {
		const { results } = await run([join(outside, "x.txt")], { answer: false });
		expect(results[0]).toEqual({
			ok: false,
			output: `Not edited: ${join(outside, "x.txt")} is outside the working directory and the user did not approve editing it.`,
		});
		expect(await text(join(outside, "x.txt"))).toBe("alpha\n");
	});

	it("leaves the file untouched and says so when there is no way to ask", async () => {
		const { results } = await run([join(outside, "x.txt")], { ask: false });
		expect(results[0]).toMatchObject({
			ok: false,
			output: `Not edited: ${join(outside, "x.txt")} is outside the working directory and the user did not approve editing it.`,
		});
		expect(await text(join(outside, "x.txt"))).toBe("alpha\n");
	});

	it("asks with the resolved target of a symlink in the working directory", async () => {
		await symlink(join(outside, "x.txt"), join(cwd, "link.txt"));
		const { questions } = await run(["link.txt"]);
		expect(questions.map((q) => q.command)).toEqual([`edit ${join(outside, "x.txt")}`]);
		expect(await text(join(outside, "x.txt"))).toBe("beta\n");
	});

	it("does not ask about a missing file, and says it is missing", async () => {
		const { questions, results } = await run([join(outside, "nope.txt")]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: false });
		expect(results[0]?.output).toMatch(/ENOENT|no such file/i);
	});
});

describe("edit never writes secrets", () => {
	it.each([
		["a secret directory of the home", () => join(home, ".ssh", "config")],
		["a file of the user's own configuration", () => join(home, ".atelier", "sandbox.json")],
		["a .env file", () => join(outside, ".env")],
		["a .pem file", () => join(outside, "server.pem")],
	])("refuses %s without asking, even with approvals granted", async (_name, target) => {
		await writeFile(join(home, ".atelier", "sandbox.json"), "alpha\n");
		const path = target();
		const { questions, results } = await run([path], { autoApprove: true });
		expect(questions).toEqual([]);
		expect(results[0]).toEqual({ ok: false, output: `Path is a protected secret location: ${path}` });
		expect(await text(path)).toBe("alpha\n");
	});

	it("refuses a symlink in the working directory that leads to a secret", async () => {
		await symlink(join(home, ".ssh", "config"), join(cwd, "sneaky.txt"));
		const { questions, results } = await run(["sneaky.txt"]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: false });
		expect(results[0]?.output).toMatch(/^Path is a protected secret location: /);
		expect(await text(join(home, ".ssh", "config"))).toBe("alpha\n");
	});
});

describe("edit approved for one file only", () => {
	it("refuses to write when the approved path now leads somewhere else", async () => {
		await symlink(join(outside, "x.txt"), join(cwd, "swap.txt"));
		const tool = createEditTool({ home });
		const edits = [{ oldText: "alpha", newText: "beta" }];
		const approvedPaths = new Set([join(outside, "x.txt")]);
		// The link was swapped after the question: the approval no longer covers where it points.
		await rm(join(cwd, "swap.txt"));
		await symlink(join(outside, "y.txt"), join(cwd, "swap.txt"));
		const outcome = await tool.execute({ path: "swap.txt", edits }, { cwd, approvedPaths });
		expect(outcome.ok).toBe(false);
		expect(await text(join(outside, "y.txt"))).toBe("alpha\n");
		expect(await text(join(outside, "x.txt"))).toBe("alpha\n");
	});

	it("does not write outside the working directory when called without any approval", async () => {
		const outcome = await createEditTool({ home }).execute(
			{ path: join(outside, "x.txt"), edits: [{ oldText: "alpha", newText: "beta" }] },
			{ cwd },
		);
		expect(outcome.ok).toBe(false);
		expect(await text(join(outside, "x.txt"))).toBe("alpha\n");
	});
});

describe("a worker subagent editing outside", () => {
	const worker: SubagentDefinition = {
		name: "worker",
		description: "Changes code",
		tools: ["edit"],
		prompt: "WORKER",
		models: {},
		maxRequests: 5,
	};

	it("asks the user through the parent's approval channel, tagged with the task call", async () => {
		const parent = new FakeBackend([
			[{ toolCall: { tool: "task", input: { agent: "worker", prompt: "Do it." }, callId: "t1" } }, finished],
		]);
		const asked: ApprovalRequest[] = [];
		const session = await Session.start({
			backend: parent,
			cwd,
			tools: [createEditTool({ home })],
			subagents: {
				agents: [worker],
				createBackend: () =>
					new FakeBackend([
						[editCall(join(outside, "x.txt"), "w1"), { event: { type: "text_delta", text: "Done." } }, finished],
					]),
			},
			autoApprove: true,
			approve: async (request) => {
				asked.push(request);
				return true;
			},
		});
		const events: AtelierEvent[] = [];
		for await (const event of session.send("go")) events.push(event);
		await session.close();
		expect(asked.map((q) => [q.callId, q.command, q.always])).toEqual([["w1", `edit ${join(outside, "x.txt")}`, true]]);
		expect(events.find((e) => e.type === "approval_requested")).toMatchObject({ parentCallId: "t1", agent: "worker" });
		expect(await text(join(outside, "x.txt"))).toBe("beta\n");
	});
});

describe("tools that do not change", () => {
	it("bash still asks only with its command, and read is untouched", async () => {
		expect(bashTool.approvalCommand({ command: "ls" })).toBe("ls");
		expect(createReadTool({ outside: true, home }).name).toBe("read");
	});
});
