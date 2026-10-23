import { describe, expect, it } from "vitest";
import { addCost, sumCosts, usd } from "../scripts/cost.ts";

describe("measurement script costs", () => {
	it("adds known costs", () => {
		expect(sumCosts([0.01, 0.02, 0])).toBeCloseTo(0.03);
		expect(addCost(0.01, 0.02)).toBeCloseTo(0.03);
		expect(sumCosts([])).toBe(0);
	});

	it("never turns an unreported cost into 0: one unknown makes the total unknown", () => {
		expect(sumCosts([0.01, undefined, 0.02])).toBeUndefined();
		expect(addCost(0.01, undefined)).toBeUndefined();
		expect(addCost(undefined, 0.01)).toBeUndefined();
	});

	it("shows an unknown cost as a dash, not as $0", () => {
		expect(usd(0.012345)).toBe("$0.0123");
		expect(usd(0)).toBe("$0.0000");
		expect(usd(undefined)).toBe("—");
	});
});
