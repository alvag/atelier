import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Attention } from "../src/tui/attention.ts";
import { DEFAULT_NOTIFICATIONS } from "../src/tui/settings.ts";

/** What a turn that stopped for `stopReason` is told as, through OSC 9. */
function toldAs(stopReason: string, waiting?: Parameters<Attention["waiting"]>[0]): string[] {
	let written = "";
	const terminal = {
		write: (data: string) => {
			written += data;
		},
	} as unknown as Terminal;
	const attention = new Attention(
		{ ...DEFAULT_NOTIFICATIONS, via: "terminal", minSeconds: 0 },
		{ terminal, cwd: "/work/proj", env: { TERM_PROGRAM: "ghostty" }, platform: "linux" },
	);
	if (waiting) attention.waiting(waiting);
	else {
		attention.turnStarted();
		attention.turnFinished(stopReason);
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the notification's sequence is what is read
	return [...written.matchAll(/\x1b\]9;Atelier · proj: ([^\x07]*)\x07/g)].map((match) => match[1] ?? "");
}

describe("Attention", () => {
	it("distinguishes agent questions from approvals and review consent", () => {
		expect(toldAs("", "user_question")).toEqual(["Waiting for your answer"]);
		expect(toldAs("", "question")).toEqual(["Waiting for review consent"]);
		expect(toldAs("", "permission")).toEqual(["Waiting for approval"]);
	});

	it("tells a turn that failed as failed, whatever the backend calls its failure", () => {
		for (const stopReason of [
			"error",
			"error_during_execution",
			"error_max_turns",
			"error_max_budget_usd",
			"turn_limit",
			"incomplete",
		])
			expect([stopReason, toldAs(stopReason)]).toEqual([stopReason, ["Turn failed"]]);
	});

	it("tells a turn that the model stopped as finished, and nothing of an interrupted one", () => {
		for (const stopReason of ["end_turn", "max_tokens", "stop_sequence", "refusal", "pause_turn"])
			expect([stopReason, toldAs(stopReason)]).toEqual([stopReason, ["Turn finished"]]);
		expect(toldAs("interrupted")).toEqual([]);
	});
});
