import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool, gateCommand } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { createWriteTool } from "../src/tools/write.ts";

const onMac = process.platform === "darwin" && !isInsideSandbox();

let base: string;
let cwd: string;
let scratch: string;
let parent: string;
let home: string;
beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-confined-")));
	cwd = join(base, "worktree");
	scratch = join(base, "scratch");
	parent = join(base, "parent");
	home = join(base, "home");
	for (const dir of [cwd, scratch, join(parent, "pkg"), home, join(cwd, ".atelier")])
		await mkdir(dir, { recursive: true });
	await writeFile(join(parent, "pkg", "index.js"), "parent\n");
	// The worktree's dependencies are a link to the parent's, and the project's configuration lets commands write there.
	await symlink(parent, join(cwd, "deps"));
	await writeFile(join(cwd, ".atelier", "sandbox.json"), JSON.stringify({ allowWrite: [parent] }));
	vi.stubEnv("HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

const confined = (): ToolContext => ({ cwd, scratchDir: scratch, confined: true });
const parentFile = () => readFile(join(parent, "pkg", "index.js"), "utf8");

describe("a confined call", () => {
	it("writes and edits nothing through a link out of its folder, whatever the configuration allows", async () => {
		const written = await createWriteTool().execute({ path: "deps/pkg/index.js", content: "child\n" }, confined());
		expect(written.ok).toBe(false);
		const edited = await createEditTool().execute(
			{ path: "deps/pkg/index.js", edits: [{ oldText: "parent", newText: "child" }] },
			confined(),
		);
		expect(edited.ok).toBe(false);
		expect(await parentFile()).toBe("parent\n");
		// Its own folder and its scratch directory it writes.
		expect((await createWriteTool().execute({ path: "own.txt", content: "x" }, confined())).ok).toBe(true);
		expect((await createWriteTool().execute({ path: join(scratch, "s.txt"), content: "x" }, confined())).ok).toBe(true);
	});

	it("is refused a command outside the sandbox, and any command without one", async () => {
		const sandbox = new Sandbox({ platform: "linux" });
		const settings = { withoutApproval: false, env: {}, policy: "agent" as const, sandbox };
		const outside = await gateCommand({ command: "ls", unsandboxed: true, reason: "why" }, confined(), settings);
		expect(outside.refusal?.output).toMatch(/^Refused: a background worker's commands run only in its sandbox/);
		const without = await gateCommand({ command: "ls" }, confined(), settings);
		expect(without.refusal?.output).toMatch(/^Refused: a background worker's commands run only in its sandbox/);
	});
});

describe.skipIf(!onMac)("a confined command in the sandbox", () => {
	let sandbox: Sandbox;
	beforeEach(() => {
		sandbox = new Sandbox({ home, tempDir: join(base, "temp") });
	});
	afterEach(async () => {
		await sandbox.reset();
	});
	const run = (command: string, context: ToolContext) => createBashTool({ sandbox }).execute({ command }, context);

	it("writes only its folder, its scratch directory and its own TMPDIR there, and reads through the link", async () => {
		const through = await run("echo child > deps/pkg/index.js", confined());
		expect(through.ok).toBe(false);
		expect(await parentFile()).toBe("parent\n");
		const read = await run("cat deps/pkg/index.js", confined());
		expect(read.output).toContain("parent");
		const own = await run(
			`echo a > own.txt && echo b > ${scratch}/s.txt && echo c > "$TMPDIR/t" && echo "$TMPDIR"`,
			confined(),
		);
		expect(own.ok).toBe(true);
		expect(own.output).toContain(scratch);
		// The same command of an agent that is not confined takes the configuration's allowWrite.
		expect((await run("echo child > deps/pkg/index.js", { cwd, scratchDir: scratch })).ok).toBe(true);
	});
});
