import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramStatusReporter } from "../src/tui/program-status.ts";

const INTERVAL_MS = 500;

/** A terminal that keeps the OSC 7501 reports it is given. */
function reported() {
	const statuses: ProgramStatus[] = [];
	const terminal = { setProgramStatus: (status: ProgramStatus) => statuses.push(status) } as unknown as Terminal;
	return { statuses, reporter: new ProgramStatusReporter(terminal, INTERVAL_MS) };
}

const atelier = (state: ProgramStatus["state"], message?: string) => ({
	state,
	app: "atelier",
	...(message === undefined ? {} : { message }),
});

describe("ProgramStatusReporter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends only the newest held working line once the interval has passed", () => {
		const { statuses, reporter } = reported();
		reporter.report("working", { message: "bash echo 1" });
		reporter.report("working", { message: "bash echo 2" });
		reporter.report("working", { message: "bash echo 3" });
		expect(statuses).toEqual([atelier("working", "bash echo 1")]);
		vi.advanceTimersByTime(INTERVAL_MS);
		expect(statuses).toEqual([atelier("working", "bash echo 1"), atelier("working", "bash echo 3")]);
		vi.advanceTimersByTime(INTERVAL_MS * 10);
		expect(statuses).toHaveLength(2);
	});

	it("never sends a held working line after a change of state, even past its time", () => {
		const { statuses, reporter } = reported();
		reporter.report("working", { message: "bash echo 1" });
		reporter.report("working", { message: "bash echo 2" });
		reporter.report("done", { message: "All done." });
		vi.advanceTimersByTime(INTERVAL_MS * 10);
		expect(statuses).toEqual([atelier("working", "bash echo 1"), atelier("done", "All done.")]);
	});

	it("never sends a held working line after clear, even past its time", () => {
		const { statuses, reporter } = reported();
		reporter.report("working", { message: "bash echo 1" });
		reporter.report("working", { message: "bash echo 2" });
		reporter.clear();
		vi.advanceTimersByTime(INTERVAL_MS * 10);
		expect(statuses).toEqual([atelier("working", "bash echo 1"), atelier("clear")]);
	});
});
