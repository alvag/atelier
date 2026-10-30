import { existsSync } from "node:fs";
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

/** A sandbox that is there and wraps nothing, recording what it was given. */
function passingSandbox(wrapped: string[] = []): Sandbox {
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
	return new Sandbox({ platform: "darwin", manager });
}

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
		expect(await checksPass(cwd, passingSandbox())).toBe(true);
		await writeFile(
			join(cwd, "test", "fails.test.ts"),
			'import { it } from "vitest";\nit("fails", () => { throw new Error("no"); });\n',
		);
		expect(await checksPass(cwd, passingSandbox())).toBe(false);
	}, 60_000);

	it("run only through the sandbox, with the agent's policy", async () => {
		const wrapped: string[] = [];
		expect(await checksPass(cwd, passingSandbox(wrapped))).toBe(true);
		expect(wrapped).toHaveLength(1);
		expect(wrapped[0]).toMatch(
			/^export HOME='[^']+' TMPDIR='[^']+'\nnode_modules\/\.bin\/tsc -p \. && node_modules\/\.bin\/vitest run$/,
		);
	}, 60_000);

	it("do not run when the sandbox is not available, and say why", async () => {
		const ran = join(cwd, "test", "ran.test.ts");
		await writeFile(
			ran,
			`import { it } from "vitest";\nimport { writeFileSync } from "node:fs";\nit("ran", () => writeFileSync(${JSON.stringify(join(cwd, "ran"))}, ""));\n`,
		);
		const reasons: string[] = [];
		const unavailable = new Sandbox({ disabled: "verification: unavailable" });
		expect(await checksPass(cwd, unavailable, (reason) => reasons.push(reason))).toBe(false);
		expect(reasons).toEqual(["the checks did not run: the sandbox is not available (verification: unavailable)"]);
		expect(existsSync(join(cwd, "ran"))).toBe(false);
	}, 60_000);
});
