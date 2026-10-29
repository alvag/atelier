import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AtelierEventBody, FakeBackend, Session } from "../src/index.ts";
import { defineTool } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };

/** A tool that asks the user before it runs in `normal`. */
const asking = defineTool({
	name: "bash",
	description: "bash",
	inputShape: { command: z.string() },
	approvalCommand: ({ command }) => command,
	execute: async () => ({ ok: true, output: "ran", summary: "ran", truncated: false }),
});

describe("an unattended session", () => {
	it("denies a call that would ask the user, without asking", async () => {
		const backend = new FakeBackend([
			[{ toolCall: { tool: "bash", input: { command: "rm -rf build" }, callId: "k1" } }, { event: finished }],
		]);
		const approve = vi.fn(async () => true);
		const session = await Session.start({ backend, cwd: process.cwd(), tools: [asking], approve, unattended: true });
		const types: string[] = [];
		for await (const event of session.send("go")) types.push(event.type);
		await session.close();
		expect(approve).not.toHaveBeenCalled();
		expect(types).not.toContain("approval_requested");
		expect(backend.toolResults[0]).toEqual({
			ok: false,
			output:
				"Denied without asking: a background subagent cannot ask the user. Leave this out and say in your report what needs approval.",
		});
	});
});
