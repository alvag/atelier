import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const main = join(import.meta.dirname, "../src/main.ts");
const runModule = pathToFileURL(join(import.meta.dirname, "../src/run.ts")).href;
const childGuard = pathToFileURL(join(import.meta.dirname, "../../atelier-core/test/support/child-guard.ts")).href;
const deletedMessage =
	"atelier: The working directory no longer exists. Change to an existing directory and run atelier again.\n";

let root: string;
let deleted: string;
let target: string;
beforeEach(async () => {
	root = await mkdtemp(join(import.meta.dirname, ".main-test-"));
	deleted = join(root, "deleted");
	target = join(root, "project");
	await mkdir(deleted);
	await mkdir(target);
	await mkdir(join(root, "home"));
	await writeFile(join(target, "AGENTS.md"), "Work only in this test project.\n");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function start(args: string[], removeCwd = true) {
	// Load dependencies before deleting cwd, so Node's module loader can start from a valid directory.
	const script = `
		import { rmdirSync } from "node:fs";
		await import(${JSON.stringify(runModule)});
		globalThis.fetch = async () => { throw new Error("Unexpected network request in startup test"); };
		process.argv = [process.execPath, ${JSON.stringify(main)}, ...${JSON.stringify(args)}];
		process.chdir(${JSON.stringify(removeCwd ? deleted : target)});
		${removeCwd ? `rmdirSync(${JSON.stringify(deleted)});` : ""}
		await import(${JSON.stringify(pathToFileURL(main).href)});
	`;
	return spawnSync(process.execPath, ["--import", childGuard, "--input-type=module", "--eval", script], {
		cwd: root,
		env: {
			...process.env,
			HOME: join(root, "home"),
			ATELIER_LOGIN_CHECK: "off",
			ATELIER_MEMORY: "off",
			ATELIER_MCP: "off",
			ATELIER_MODEL_REFRESH: "off",
			ATELIER_OFFLINE: "1",
			ATELIER_TUI: "off",
			ATELIER_ALLOW_ROOT: "I accept the risk",
			ANTHROPIC_API_KEY: "inert-test-key",
			ATELIER_COMPACT_AT: undefined,
			ATELIER_RECORD_SDK: undefined,
		},
		input: "/mode\n",
		encoding: "utf8",
		timeout: 15000,
	});
}

const sessionArgs = ["--backend", "anthropic-api", "--no-session", "--no-review", "--no-sandbox"];

describe.skipIf(process.platform === "win32")("CLI startup working directory", () => {
	it.each([{ args: [] }, { args: ["--cwd", "."] }, { args: ["--cwd=../project"] }])(
		"reports a deleted directory with arguments $args",
		({ args }) => {
			const result = start(args);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(deletedMessage);
		},
	);

	it.each(["separate", "equals"])("starts in an absolute --cwd (%s) with a deleted current directory", (form) => {
		const cwdArgs = form === "equals" ? [`--cwd=${target}`] : ["--cwd", target];
		const result = start([...sessionArgs, ...cwdArgs]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("mode: normal\n");
		expect(result.stderr).not.toContain("uv_cwd");
	});

	it("still starts in an existing current directory", () => {
		const result = start(sessionArgs, false);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("mode: normal\n");
	});
});
