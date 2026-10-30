import { describe, expect, it } from "vitest";
import { checksLine, deliveryText, NOTICE_BUDGET } from "../src/background-notices.ts";

describe("one delivery of background notices", () => {
	it("gives every notice whole when the delivery, separators included, is exactly the budget", () => {
		const first = "a".repeat(10_000);
		const second = "b".repeat(NOTICE_BUDGET - first.length - 2);
		const text = deliveryText([
			{ text: first, short: "short a" },
			{ text: second, short: "short b" },
		]);
		expect(text).toBe(`${first}\n\n${second}`);
		expect(text.length).toBe(NOTICE_BUDGET);
	});

	it("gives the short form of the notice one character past the budget", () => {
		const first = "a".repeat(10_000);
		const second = "b".repeat(NOTICE_BUDGET - first.length - 1);
		expect(deliveryText([{ text: first }, { text: second, short: "short b" }])).toBe(`${first}\n\nshort b`);
	});

	it("never passes the budget, saying how many notices did not fit at all", () => {
		const notices = Array.from({ length: 30 }, (_, n) => ({
			text: `${n}`.padEnd(5_000, "x"),
			short: `${n}`.padEnd(1_500, "s"),
		}));
		const text = deliveryText(notices);
		expect(text.length).toBeLessThanOrEqual(NOTICE_BUDGET);
		expect(text).toMatch(/\n\n\d+ more notices did not fit: job_list lists the jobs and tasks that ended\.$/);
		const given = text.split("\n\n").length - 1;
		expect(text).toContain(`${30 - given} more notices did not fit`);
	});

	it("ends with the trailer it is given, whose room it keeps within the budget", () => {
		const trailer = checksLine(0);
		expect(trailer).toBe("Then run the checks once.");
		expect(checksLine(2)).toBe(
			"2 other background tasks still run: apply each patch as it comes, and run the full checks once, after the last.",
		);
		const long = { text: "a".repeat(NOTICE_BUDGET), short: "worker done" };
		expect(deliveryText([long], trailer)).toBe(`worker done\n\n${trailer}`);
		const fits = { text: "b".repeat(NOTICE_BUDGET - 2 - trailer.length) };
		expect(deliveryText([fits], trailer).length).toBe(NOTICE_BUDGET);
		expect(deliveryText([{ text: "explorer done" }])).toBe("explorer done");
	});
});
