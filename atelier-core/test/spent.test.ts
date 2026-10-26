import { describe, expect, it } from "vitest";
import type { PhaseAgent, PhaseSpent } from "../src/events.ts";
import { addPhaseSpent, addPhases, withEffectiveEffort } from "../src/spent.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const orchestrator: PhaseAgent = { role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5" };
const ran = (...agents: PhaseAgent[]): PhaseSpent => ({ usage: { ...usage }, agents });

describe("withEffectiveEffort", () => {
	it("adds the applied effort to an agent that asked for no level", () => {
		expect(withEffectiveEffort(orchestrator, "high")).toEqual({ ...orchestrator, effectiveEffort: "high" });
		expect(orchestrator).not.toHaveProperty("effectiveEffort");
	});

	it("keeps the asked level alone: the applied effort only says what the backend chose by itself", () => {
		const asked: PhaseAgent = { ...orchestrator, effort: "low" };
		expect(withEffectiveEffort(asked, "high")).toBe(asked);
	});

	it("leaves the agent as it is when the backend says no effort, and has no agent without one", () => {
		expect(withEffectiveEffort(orchestrator, undefined)).toBe(orchestrator);
		expect(withEffectiveEffort(undefined, "high")).toBeUndefined();
	});
});

describe("the agents of a phase, added up", () => {
	it("lists an agent that ran twice with the same applied effort once", () => {
		const high = { ...orchestrator, effectiveEffort: "high" } as const;
		expect(addPhaseSpent(ran(high), ran({ ...high })).agents).toEqual([high]);
	});

	it("lists the same role, backend and model separately when only the applied effort differs, in the order they ran", () => {
		const high = { ...orchestrator, effectiveEffort: "high" } as const;
		const max = { ...orchestrator, effectiveEffort: "max" } as const;
		expect(addPhaseSpent(ran(high), ran(max, high)).agents).toEqual([high, max]);
		expect(addPhaseSpent(ran(orchestrator), ran(high)).agents).toEqual([orchestrator, high]);
	});

	it("lists them separately too when the asked level differs", () => {
		const low = { ...orchestrator, effort: "low" } as const;
		expect(addPhaseSpent(ran(orchestrator), ran(low)).agents).toEqual([orchestrator, low]);
	});

	it("merges the agents phase by phase when two breakdowns join", () => {
		const high = { ...orchestrator, effectiveEffort: "high" } as const;
		const max = { ...orchestrator, effectiveEffort: "max" } as const;
		const phases = addPhases({ main: ran(high), verify: ran(high) }, { verify: ran(max), correction: ran(max) });
		expect(phases?.main?.agents).toEqual([high]);
		expect(phases?.verify?.agents).toEqual([high, max]);
		expect(phases?.correction?.agents).toEqual([max]);
	});
});
