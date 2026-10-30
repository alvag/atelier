import { describe, expect, it } from "vitest";
import { runWokenTurns } from "../scripts/background-turns.ts";
import type { AtelierEvent } from "../src/index.ts";

const event = { type: "text_delta", text: "noticed", seq: 0, turnId: "t2" } as AtelierEvent;

/** A session whose background work and woken turns the test sets. */
function session(jobs: { running: number; waiting: number }, turns: (() => void)[] = []) {
	return {
		jobs,
		nextQueued() {
			// A turn starts only once a notice waits.
			const turn = jobs.waiting > 0 ? turns.shift() : undefined;
			if (turn === undefined) return undefined;
			return (async function* () {
				turn();
				yield event;
			})();
		},
	};
}

describe("the turns background notices wake in a measured session", () => {
	it("runs them until no background work runs or waits", async () => {
		const jobs = { running: 1, waiting: 0 };
		const taken: AtelierEvent[] = [];
		let waits = 0;
		const turns = [
			() => {
				jobs.running = 0;
				jobs.waiting = 0;
			},
		];
		const stopped = await runWokenTurns(session(jobs, turns), (e) => taken.push(e), {
			limitMs: 60_000,
			wait: async () => {
				waits++;
				jobs.waiting = 1;
			},
		});
		expect(stopped).toBeUndefined();
		expect(taken).toEqual([event]);
		expect(waits).toBe(1);
	});

	it("stops at once, saying why, when notices wait that no turn will take and nothing runs", async () => {
		let waits = 0;
		const stopped = await runWokenTurns(session({ running: 0, waiting: 2 }), () => {}, {
			limitMs: 60_000,
			wait: async () => {
				waits++;
			},
		});
		expect(stopped).toBe(
			"2 background notices waited that no turn took (a turn failed or was interrupted), with no background work running",
		);
		expect(waits).toBe(0);
	});

	it("stops at its limit while background work still runs", async () => {
		const stopped = await runWokenTurns(session({ running: 1, waiting: 0 }), () => {}, {
			limitMs: 0,
			wait: async () => {},
		});
		expect(stopped).toBe("background work still ran after 0 minutes");
	});
});
