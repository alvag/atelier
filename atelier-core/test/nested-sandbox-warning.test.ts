import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { NESTED_SANDBOX_WARNING, warnIfNested } from "./support/nested-sandbox.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("warns at the end of a run inside a sandbox that the Seatbelt tests did not run", () => {
	const written: string[] = [];
	const teardown = warnIfNested(
		() => true,
		(text) => written.push(text),
	);
	expect(written).toEqual([]);
	teardown();
	expect(written).toEqual([NESTED_SANDBOX_WARNING]);
	expect(NESTED_SANDBOX_WARNING).toContain("inside a sandbox");
	expect(NESTED_SANDBOX_WARNING).toContain("Seatbelt tests did not run");
	expect(NESTED_SANDBOX_WARNING).toContain("HOME=$H TMPDIR=$H/tmp");
	// The PTY tests skip when there is no pseudo-terminal, not because of the sandbox: the warning does not name them.
	expect(NESTED_SANDBOX_WARNING).not.toContain("PTY");
});

it("says nothing outside a sandbox, as on Linux", () => {
	const written: string[] = [];
	warnIfNested(
		() => false,
		(text) => written.push(text),
	)();
	expect(written).toEqual([]);
});

it("never turns a failing run green: it still exits non-zero, with the warning", async () => {
	const root = await mkdtemp(join(tmpdir(), "atelier-nested-run-"));
	dirs.push(root);
	const support = new URL("./support/nested-sandbox.ts", import.meta.url).href;
	await writeFile(
		join(root, "nested.ts"),
		`import { warnIfNested } from ${JSON.stringify(support)};\nexport default () => warnIfNested(() => true, (text) => process.stderr.write(text));\n`,
	);
	await writeFile(
		join(root, "red.test.ts"),
		`import { it } from "vitest";\nit("fails", () => { throw new Error("red"); });\n`,
	);
	await writeFile(
		join(root, "vitest.config.ts"),
		`export default { test: { include: ["red.test.ts"], globalSetup: ["nested.ts"] } };\n`,
	);
	const vitest = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
	const run = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
		execFile(process.execPath, [vitest, "run", "--root", root], { cwd: root }, (error, _stdout, stderr) =>
			resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stderr }),
		);
	});
	expect(run.code).not.toBe(0);
	expect(run.code).not.toBeNull();
	expect(run.stderr).toContain(NESTED_SANDBOX_WARNING.trim());
}, 30_000);
