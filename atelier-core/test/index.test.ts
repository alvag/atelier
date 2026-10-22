import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.ts";

describe("@atelier/core", () => {
	it("exposes its version", () => {
		expect(VERSION).toBe("0.0.0");
	});
});
