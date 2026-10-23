import { describe, expect, it } from "vitest";
import type { AgentBackend, BackendStartOptions } from "../src/backend.ts";
import type { AtelierEvent, AtelierEventBody } from "../src/events.ts";
import { Session } from "../src/session.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };

/** A backend whose sessions compact by playing `compaction` and record the instructions they got. */
function compactingBackend(compaction: AtelierEventBody[]) {
	const instructions: (string | undefined)[] = [];
	const backend: AgentBackend = {
		id: "fake",
		start: async (_options: BackendStartOptions) => ({
			async *send() {
				yield { type: "turn_finished", stopReason: "end_turn", usage };
			},
			async *compact(text?: string) {
				instructions.push(text);
				yield* compaction;
			},
			interrupt: async () => {},
			close: async () => {},
		}),
	};
	return { backend, instructions };
}

async function collect(events: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe("Session.compact", () => {
	it("forwards the backend's compaction as one stamped turn with the instructions", async () => {
		const { backend, instructions } = compactingBackend([
			{ type: "compaction_started", reason: "manual", tokens: 900 },
			{ type: "compaction_finished", ok: true, reason: "manual", tokensBefore: 900, tokensAfter: 100, kept: 2, usage },
			{ type: "turn_finished", stopReason: "end_turn", usage, context: { tokens: 100, window: 1000, compactAt: 800 } },
		]);
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		const events = await collect(session.compact("Keep it", "t1"));
		expect(instructions).toEqual(["Keep it"]);
		expect(events.map((e) => [e.type, e.seq, e.turnId])).toEqual([
			["compaction_started", 1, "t1"],
			["compaction_finished", 2, "t1"],
			["turn_finished", 3, "t1"],
		]);
		expect(events.at(-1)).toMatchObject({ context: { tokens: 100, window: 1000, compactAt: 800 } });
		await session.close();
	});

	it("ends with one turn_finished even when the backend stops without one", async () => {
		const { backend } = compactingBackend([{ type: "compaction_started", reason: "manual", tokens: 1 }]);
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		const events = await collect(session.compact());
		expect(events.filter((e) => e.type === "turn_finished")).toMatchObject([{ stopReason: "incomplete" }]);
		await session.close();
	});
});
