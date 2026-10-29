import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AtelierEventBody, FakeBackend, type FakeStep, Session, type SessionOptions } from "../src/index.ts";
import { LEFT_YOLO, YOLO_RULES } from "../src/prompt.ts";
import type { SubagentDefinition } from "../src/subagents/definitions.ts";
import { defineTool } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const DONE: FakeStep[] = [{ event: finished }];
const tools = [
	defineTool({
		name: "read",
		description: "read",
		inputShape: { path: z.string().optional() },
		execute: async () => ({ ok: true, output: "", summary: "read", truncated: false }),
	}),
];

async function start(turns: FakeStep[][], extra: Partial<SessionOptions> = {}) {
	const backend = new FakeBackend(turns);
	const session = await Session.start({ backend, cwd: process.cwd(), tools, ...extra });
	const send = async (prompt: string) => {
		for await (const _ of session.send(prompt)) {
		}
	};
	return { backend, session, send };
}

describe("the yolo rules", () => {
	it("say what yolo covers, what still asks, and that the user's questions are never answered for them", () => {
		expect(YOLO_RULES).toBe(
			[
				"The session runs in yolo mode: tool calls that normal mode would ask the user about run without asking.",
				"- Commits, pushes and pull requests within the task go ahead without asking the user.",
				"- The guard's destructive confirmations still ask; never work around them.",
				"- Yolo covers the task you were given, not more: ask before widening its scope.",
				"- Never answer a question meant for the user or give a consent on the user's behalf, in text or with a tool.",
				"- Subagents do not inherit it: they run in normal mode.",
			].join("\n"),
		);
		expect(Buffer.byteLength(YOLO_RULES)).toBeLessThanOrEqual(700);
		expect(LEFT_YOLO).toBe(
			"The session left yolo mode: its rules no longer apply, and tool calls ask as in normal mode again.",
		);
	});

	it("reach the system prompt only of a session that starts in yolo", async () => {
		const yolo = await start([], { permissionMode: "yolo", odd: true });
		expect(yolo.backend.startOptions?.systemPromptAppend).toContain(`\n\n${YOLO_RULES}`);
		await yolo.session.close();
		for (const permissionMode of ["normal", "auto"] as const) {
			const other = await start([], { permissionMode });
			expect(other.backend.startOptions?.systemPromptAppend).not.toContain("yolo");
			await other.session.close();
		}
	});

	it("never reach a subagent of a yolo session", async () => {
		const child = new FakeBackend([[{ event: { type: "text_delta", text: "report" } }, { event: finished }]]);
		const agent: SubagentDefinition = {
			name: "scout",
			description: "Looks",
			tools: ["read"],
			prompt: "SCOUT",
			models: {},
			maxRequests: 5,
		};
		const s = await start(
			[[{ toolCall: { tool: "task", input: { agent: "scout", prompt: "look" }, callId: "c1" } }, ...DONE]],
			{
				permissionMode: "yolo",
				subagents: { agents: [agent], createBackend: () => child },
			},
		);
		await s.send("go");
		await s.session.close();
		expect(child.startOptions?.systemPromptAppend).toBe("SCOUT");
		expect(child.prompts).toEqual(["look"]);
	});
});

describe("a change of mode during the session", () => {
	it("gives the next prompt the yolo rules once, and the one after nothing", async () => {
		const s = await start([DONE, DONE, DONE]);
		await s.send("first");
		s.session.setPermissionMode("yolo");
		await s.send("second");
		await s.send("third");
		await s.session.close();
		expect(s.backend.prompts).toEqual(["first", `${YOLO_RULES}\n\nsecond`, "third"]);
		expect(s.backend.startOptions?.systemPromptAppend ?? "").not.toContain(YOLO_RULES);
	});

	it("says once that yolo no longer applies when the session leaves it, and the rules again if it returns", async () => {
		const s = await start([DONE, DONE, DONE, DONE], { permissionMode: "yolo" });
		await s.send("first");
		s.session.setPermissionMode("normal");
		await s.send("second");
		await s.send("third");
		s.session.setPermissionMode("yolo");
		await s.send("fourth");
		await s.session.close();
		expect(s.backend.prompts).toEqual(["first", `${LEFT_YOLO}\n\nsecond`, "third", `${YOLO_RULES}\n\nfourth`]);
	});

	it("gives the note again with the next prompt when the backend failed before taking the one that carried it", async () => {
		const refused: FakeStep[] = [
			{ event: { type: "error", code: "api_error", message: "overloaded", recoverable: false } },
			{ event: { ...finished, stopReason: "error" } },
		];
		const s = await start([[{ throw: "connection reset" }], refused, DONE, DONE]);
		s.session.setPermissionMode("yolo");
		await s.send("first");
		await s.send("second");
		await s.send("third");
		await s.send("fourth");
		await s.session.close();
		expect(s.backend.prompts).toEqual([
			`${YOLO_RULES}\n\nfirst`,
			`${YOLO_RULES}\n\nsecond`,
			`${YOLO_RULES}\n\nthird`,
			"fourth",
		]);
	});

	it("counts the note as told once the model called a tool for its prompt, even when the turn then fails", async () => {
		const toolThenError: FakeStep[] = [
			{ toolCall: { tool: "read", input: { path: "a.ts" }, callId: "c1" } },
			{ throw: "second model request failed" },
		];
		const s = await start([toolThenError, DONE]);
		s.session.setPermissionMode("yolo");
		await s.send("first");
		s.session.setPermissionMode("normal");
		await s.send("second");
		await s.session.close();
		expect(s.backend.toolResults).toHaveLength(1);
		expect(s.backend.prompts).toEqual([`${YOLO_RULES}\n\nfirst`, `${LEFT_YOLO}\n\nsecond`]);
	});

	it("keeps the mode of a backend change pending until the new backend takes a prompt", async () => {
		const s = await start([DONE]);
		s.session.setPermissionMode("yolo");
		await s.send("first");
		const replacement = new FakeBackend([[{ throw: "API unavailable" }], DONE, DONE], "anthropic-api");
		await s.session.setBackend(replacement);
		await s.send("lost");
		await s.send("retry");
		await s.send("then");
		await s.session.close();
		expect(replacement.startOptions?.systemPromptAppend ?? "").not.toContain(YOLO_RULES);
		expect(replacement.prompts[0]).toContain(YOLO_RULES);
		expect(replacement.prompts[1]).toContain(YOLO_RULES);
		expect(replacement.prompts[2]).toBe("then");
	});

	it("says nothing when the model already has the mode right", async () => {
		const s = await start([DONE, DONE, DONE], { permissionMode: "yolo" });
		s.session.setPermissionMode("yolo");
		await s.send("first");
		// Out and back before a prompt: the model never ran outside yolo.
		s.session.setPermissionMode("normal");
		s.session.setPermissionMode("yolo");
		await s.send("second");
		s.session.setPermissionMode("auto");
		s.session.setPermissionMode("normal");
		await s.session.close();
		expect(s.backend.prompts).toEqual(["first", "second"]);
		const plain = await start([DONE], { permissionMode: "normal" });
		plain.session.setPermissionMode("auto");
		await plain.send("first");
		await plain.session.close();
		expect(plain.backend.prompts).toEqual(["first"]);
	});

	it("keeps what the model was told across a compaction, in the state the backend carries over", async () => {
		const s = await start([DONE, DONE]);
		const state = () => s.backend.startOptions?.compactionState?.() ?? "";
		s.session.setPermissionMode("yolo");
		// Not told yet: the next prompt carries the rules.
		expect(state()).not.toContain(YOLO_RULES);
		await s.send("first");
		expect(state()).toContain(YOLO_RULES);
		s.session.setPermissionMode("normal");
		await s.send("second");
		expect(state()).not.toContain("yolo");
		await s.session.close();

		const started = await start([DONE, DONE], { permissionMode: "yolo" });
		const startedState = () => started.backend.startOptions?.compactionState?.() ?? "";
		await started.send("first");
		// The system prompt already has the rules.
		expect(startedState()).not.toContain("yolo");
		started.session.setPermissionMode("normal");
		await started.send("second");
		expect(startedState()).toContain(LEFT_YOLO);
		await started.session.close();
	});
});
