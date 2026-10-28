import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { defineTool, FakeBackend, Session } from "../src/index.ts";
import type { ToolGate } from "../src/tools/types.ts";

it("preserves the previous behavior of an explicitly false sandboxFailed marker", async () => {
	const asked: unknown[] = [];
	const tool = defineTool({
		name: "probe",
		description: "public custom tool",
		inputShape: {},
		gate: async () => ({ approval: { command: "probe", sandboxFailed: false } }) as unknown as ToolGate,
		execute: async () => ({ ok: true, output: "ran", summary: "ran", truncated: false }),
	});
	const backend = new FakeBackend([
		[
			{ toolCall: { tool: "probe", input: {}, callId: "c1" } },
			{
				event: {
					type: "turn_finished",
					stopReason: "end_turn",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				},
			},
		],
	]);
	const session = await Session.start({
		backend,
		cwd: tmpdir(),
		tools: [tool],
		permissionMode: "yolo",
		approve: async (request) => {
			asked.push(request);
			return false;
		},
	});
	try {
		for await (const _event of session.send("go")) {
		}
	} finally {
		await session.close();
	}
	console.log("false marker", { asked, results: backend.toolResults });
	expect(asked).toEqual([]);
	expect(backend.toolResults).toEqual([{ ok: true, output: "ran" }]);
});
