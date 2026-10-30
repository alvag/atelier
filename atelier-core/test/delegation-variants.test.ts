import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeBackend, Session, type SessionOptions } from "../src/index.ts";
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

	it("say nothing of an explorer the session lacks", async () => {
		expect((await started({ variant: "rule" }, [scout])).prompt).not.toContain("judge its breadth");
		expect((await started({ variant: "why" }, [scout])).task).not.toContain(WHY);
	});
});
