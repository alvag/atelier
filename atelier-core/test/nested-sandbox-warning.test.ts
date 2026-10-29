import { expect, it } from "vitest";
import { NESTED_SANDBOX_WARNING, warnIfNested } from "./support/nested-sandbox.ts";

it("warns at the end of a run inside a sandbox that the Seatbelt and PTY tests did not run", () => {
	const written: string[] = [];
	const teardown = warnIfNested(
		() => true,
		(text) => written.push(text),
	);
	expect(written).toEqual([]);
	teardown();
	expect(written).toEqual([NESTED_SANDBOX_WARNING]);
	expect(NESTED_SANDBOX_WARNING).toContain("inside a sandbox");
	expect(NESTED_SANDBOX_WARNING).toContain("did not run");
	expect(NESTED_SANDBOX_WARNING).toContain("HOME=$H TMPDIR=$H/tmp");
});

it("says nothing outside a sandbox, as on Linux", () => {
	const written: string[] = [];
	warnIfNested(
		() => false,
		(text) => written.push(text),
	)();
	expect(written).toEqual([]);
});
