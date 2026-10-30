import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksPass, makeBackgroundRepo } from "../scripts/background-repo.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const core = new URL("..", import.meta.url).pathname;
let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-repo-test-"));
	await cp(join(core, "src"), join(cwd, "src"), { recursive: true });
	await makeBackgroundRepo(cwd, join(core, "../tsconfig.base.json"), [
		join(core, "node_modules"),
		join(core, "../node_modules"),
	]);
});
afterEach(async () => {
	delete process.env.ATELIER_MEASURE_PROBE;
	await rm(cwd, { recursive: true, force: true });
});

/** A test the agent could have written: it passes only when the checks run with nothing of the script's. */
const envTest = (realHome: string) =>
	[
		'import { expect, it } from "vitest";',
		'it("sees nothing of the script that runs it", () => {',
		"\texpect(process.env.ATELIER_MEASURE_PROBE).toBeUndefined();",
		`\texpect(process.env.HOME).not.toBe(${JSON.stringify(realHome)});`,
		"});",
		"",
	].join("\n");

describe("the checks of the measured repository", () => {
	it("run with an environment of their own: no variable of the script's, no real home", async () => {
		process.env.ATELIER_MEASURE_PROBE = "a key";
		await writeFile(join(cwd, "test", "env.test.ts"), envTest(homedir()));
		expect(await checksPass(cwd)).toBe(true);
		await writeFile(
			join(cwd, "test", "fails.test.ts"),
			'import { it } from "vitest";\nit("fails", () => { throw new Error("no"); });\n',
		);
		expect(await checksPass(cwd)).toBe(false);
	}, 60_000);

	it("run through the sandbox, with the agent's policy, when it is available", async () => {
		const wrapped: string[] = [];
		const manager: SandboxManagerLike = {
			isSupportedPlatform: () => true,
			checkDependencies: () => ({ errors: [], warnings: [] }),
			initialize: async () => {},
			wrapWithSandbox: async (command) => {
				wrapped.push(command);
				return command;
			},
			cleanupAfterCommand: () => {},
			reset: async () => {},
		};
		expect(await checksPass(cwd, new Sandbox({ platform: "darwin", manager }))).toBe(true);
		expect(wrapped).toHaveLength(1);
		expect(wrapped[0]).toMatch(
			/^export HOME='[^']+' TMPDIR='[^']+'\nnode_modules\/\.bin\/tsc -p \. && node_modules\/\.bin\/vitest run$/,
		);
	}, 60_000);
});
