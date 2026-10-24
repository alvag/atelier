import { describe, expect, it } from "vitest";
import { checkRoot } from "../src/index.ts";

describe("checkRoot", () => {
	it("lets a normal user, or a system without uids, start without a word", () => {
		expect(checkRoot(501, {})).toEqual({ allowed: true });
		expect(checkRoot(501, { ATELIER_ALLOW_ROOT: "I accept the risk" })).toEqual({ allowed: true });
		expect(checkRoot(undefined, {})).toEqual({ allowed: true });
	});

	it("refuses root, and says how to consent", () => {
		expect(checkRoot(0, {})).toEqual({
			allowed: false,
			message:
				'Atelier will not run as root (uid 0): a mistaken command could damage the whole system. To run as root anyway, set ATELIER_ALLOW_ROOT="I accept the risk" (exactly that text).',
		});
	});

	it.each(["", "y", "yes", "1", "true", "i accept the risk", "I accept the risk ", " I accept the risk"])(
		"refuses root for ATELIER_ALLOW_ROOT=%j and names what it saw",
		(given) => {
			const check = checkRoot(0, { ATELIER_ALLOW_ROOT: given });
			expect(check.allowed).toBe(false);
			expect((check as { message: string }).message).toContain(
				`ATELIER_ALLOW_ROOT is set to ${JSON.stringify(given)}, which is not that exact text.`,
			);
		},
	);

	it("lets root start with the exact text, with the warning to show on every start", () => {
		expect(checkRoot(0, { ATELIER_ALLOW_ROOT: "I accept the risk" })).toEqual({
			allowed: true,
			warning:
				"warning: running as root (uid 0) because ATELIER_ALLOW_ROOT is set: every command has full control of this system.",
		});
	});
});
