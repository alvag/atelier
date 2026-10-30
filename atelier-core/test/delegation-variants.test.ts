import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AtelierEventBody, FakeBackend, type FakeStep, Session, type SessionOptions } from "../src/index.ts";
import { BUILTIN_AGENTS, type SubagentDefinition, TASK_TOOL } from "../src/subagents/definitions.ts";
import { defineTool, type ToolDefinition } from "../src/tools/types.ts";

const tool = (name: string): ToolDefinition =>
	defineTool({
		name,
		description: name,
		inputShape: { path: z.string().optional() },
		execute: async () => ({ ok: true, output: `${name} ran`, summary: name, truncated: false }),
	});
const tools = ["read", "edit", "grep"].map(tool);
/** `read` and `grep` here give back as many characters as their `path` says, and fail when it says `fail`. */
const sized = (name: string): ToolDefinition =>
	defineTool({
		name,
		description: name,
		inputShape: { path: z.string() },
		execute: async ({ path }) =>
			path === "fail"
				? { ok: false, output: "x".repeat(9000), summary: "failed", truncated: false }
				: { ok: true, output: "x".repeat(Number(path)), summary: name, truncated: false },
	});
const sizedTools = [sized("read"), sized("grep"), tool("edit")];
const finished: AtelierEventBody = {
	type: "turn_finished",
	stopReason: "end_turn",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const call = (name: string, path = "4000"): FakeStep => ({ toolCall: { tool: name, input: { path } } });
const reads = (n: number, path = "4000"): FakeStep[] =>
	Array.from({ length: n }, (_, i) => call(i % 2 === 0 ? "read" : "grep", path));
const NOTICE =
	"You have read 5 times in this turn, about 5k tokens, past the task tool's limit for reading inline. For what is left, send one explorer with the question and the paths you already know, and ask for at most about 2k tokens with path:line evidence, instead of reading on yourself.";
const scout: SubagentDefinition = { ...(BUILTIN_AGENTS[0] as SubagentDefinition), name: "scout" };

const ROUTE =
	"- A task's route says who does it: inline (you), explorer or worker, following the task tool's rules on when to delegate.";
const BREADTH =
	"- Before your first read for a question, judge its breadth: if answering needs more than about 3 reads or 10k tokens of code, do not read it yourself; send one explorer with the question and the paths you know, and ask for at most about 2k tokens with path:line evidence. A question you can answer in up to 3 reads stays inline.";
const EXPLORER_RULE =
	"- Read inline when it takes up to about 3 parallel calls or 10k tokens; beyond that, send one explorer and ask for an answer of at most about 2k tokens with path:line evidence.";
const WHY =
	"- Each file you read stays in your context and is sent again with every later request of yours; an explorer's reads do not.";

/** What the backend of a main agent with ODD and `agents` gets: its system prompt and the task tool's description. */
async function started(
	delegation?: SessionOptions["delegation"],
	agents: readonly SubagentDefinition[] = BUILTIN_AGENTS,
) {
	const backend = new FakeBackend([]);
	const session = await Session.start({
		backend,
		cwd: process.cwd(),
		tools,
		odd: true,
		subagents: { agents, createBackend: () => new FakeBackend([]) },
		...(delegation === undefined ? {} : { delegation }),
	});
	await session.close();
	return {
		prompt: backend.startOptions?.systemPromptAppend ?? "",
		task: backend.startOptions?.tools.find((t) => t.name === TASK_TOOL)?.description ?? "",
	};
}

describe("the delegation variants measured for #124", () => {
	it("leave the prompt and the task tool as they are without one, or with the baseline", async () => {
		const plain = await started();
		expect(plain.prompt).toContain(ROUTE);
		expect(plain.prompt).not.toContain("judge its breadth");
		expect(plain.task).not.toContain(WHY);
		expect(await started({ variant: "baseline" })).toEqual(plain);
	});

	it("put the breadth rule in the ODD rules right after the route line, with rule", async () => {
		for (const variant of ["rule", "rule+notice"] as const) {
			const { prompt, task } = await started({ variant });
			expect(prompt).toContain(`${ROUTE}\n${BREADTH}\n- Then go task by task`);
			expect(task).not.toContain(WHY);
		}
	});

	it("say why to delegate in the task tool right after the explorer rule, with why", async () => {
		const { prompt, task } = await started({ variant: "why" });
		expect(task).toContain(`When to delegate:\n${EXPLORER_RULE}\n${WHY}\n- Pass paths`);
		expect(prompt).not.toContain("judge its breadth");
	});

	it("add no line to the prompt or the task tool with notice", async () => {
		expect(await started({ variant: "notice" })).toEqual(await started());
	});

	it("say nothing of an explorer the session lacks", async () => {
		expect((await started({ variant: "rule" }, [scout])).prompt).not.toContain("judge its breadth");
		expect((await started({ variant: "why" }, [scout])).task).not.toContain(WHY);
	});
});

/** The steering each of the main agent's tool results carried, turn after turn, with `turns` played by its backend. */
async function steering(
	turns: FakeStep[][],
	delegation: SessionOptions["delegation"] = { variant: "notice" },
	agents: readonly SubagentDefinition[] = BUILTIN_AGENTS,
): Promise<(string | undefined)[]> {
	const backend = new FakeBackend(turns.map((steps) => [...steps, { event: finished }]));
	const session = await Session.start({
		backend,
		cwd: process.cwd(),
		tools: sizedTools,
		subagents: { agents, createBackend: () => new FakeBackend([[{ event: finished }]]) },
		delegation,
	});
	try {
		for (const _ of turns) for await (const _event of session.send("go"));
	} finally {
		await session.close();
	}
	return backend.toolResults.map((result) => result.steering);
}

describe("the read notice of the notice variant", () => {
	it("goes with the result of the read that reaches 5 reads and 20,000 characters in the turn, once", async () => {
		expect(await steering([reads(6)])).toEqual([undefined, undefined, undefined, undefined, NOTICE, undefined]);
		expect(await steering([reads(5, "3999")])).toEqual(Array(5).fill(undefined));
		expect((await steering([[...reads(4, "10000"), call("read", "1")]]))[4]).toContain("read 5 times");
		expect((await steering([reads(5)], { variant: "rule+notice" }))[4]).toBe(NOTICE);
	});

	it("counts no read that failed, and starts again in each turn", async () => {
		expect(await steering([[...reads(4), call("read", "fail")]])).toEqual(Array(5).fill(undefined));
		expect(await steering([reads(4), reads(1)])).toEqual(Array(5).fill(undefined));
	});

	it("never comes once the turn delegated or changed a file", async () => {
		const task: FakeStep = { toolCall: { tool: TASK_TOOL, input: { agent: "explorer", prompt: "Find it." } } };
		for (const first of [task, call("edit")])
			expect((await steering([[first, ...reads(5)]])).slice(1)).toEqual(Array(5).fill(undefined));
	});

	it("never comes without the variant or without an explorer", async () => {
		for (const variant of ["baseline", "rule", "why"] as const)
			expect(await steering([reads(5)], { variant })).toEqual(Array(5).fill(undefined));
		expect(await steering([reads(5)], { variant: "notice" }, [scout])).toEqual(Array(5).fill(undefined));
	});

	it("never reaches a subagent, whatever it reads", async () => {
		const children: FakeBackend[] = [];
		const backend = new FakeBackend([
			[{ toolCall: { tool: TASK_TOOL, input: { agent: "explorer", prompt: "Find it." } } }, { event: finished }],
		]);
		const session = await Session.start({
			backend,
			cwd: process.cwd(),
			tools: sizedTools,
			subagents: {
				agents: BUILTIN_AGENTS,
				createBackend: () => {
					const child = new FakeBackend([
						[...reads(6), { event: { type: "text_delta", text: "Found." } }, { event: finished }],
					]);
					children.push(child);
					return child;
				},
			},
			delegation: { variant: "notice" },
		});
		try {
			for await (const _event of session.send("go"));
		} finally {
			await session.close();
		}
		expect(children[0]?.toolResults.map((result) => result.steering)).toEqual(Array(6).fill(undefined));
	});
});
