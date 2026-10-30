import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool, gateCommand } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { confinedPolicy, isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";
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
const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

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

describe("the confined policy", () => {
	it("writes only the folder and the scratch directory, and denies what the library would add by itself", () => {
		const { filesystem } = confinedPolicy({ cwd, scratchDir: scratch, home });
		expect(filesystem.allowWrite).toEqual([cwd, scratch]);
		expect(filesystem.denyWrite).toEqual(expect.arrayContaining(["/tmp/claude", "/private/tmp/claude"]));
		expect(filesystem.denyRead).toEqual(
			expect.arrayContaining([join(home, ".npm", "_logs"), join(home, ".claude", "debug")]),
		);
	});

	it("keeps the reads the configuration denies, and none of the writes it adds", () => {
		const additions = { allowWrite: [parent], denyRead: [join(home, "private")] };
		const { filesystem } = confinedPolicy({ cwd, scratchDir: scratch, home, additions });
		expect(filesystem.denyRead).toContain(join(home, "private"));
		expect(filesystem.allowWrite).toEqual([cwd, scratch]);
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
		// Nor what the library makes writable by itself: its own TMPDIR and the home's log folders.
		await mkdir(join(home, ".npm", "_logs"), { recursive: true });
		const probe = `atelier-confined-${process.pid}`;
		const library = await run(`echo x > /tmp/claude/${probe}; echo y > ${home}/.npm/_logs/${probe}`, confined());
		expect(library.ok).toBe(false);
		expect(await exists(`/tmp/claude/${probe}`)).toBe(false);
		expect(await exists(join(home, ".npm", "_logs", probe))).toBe(false);
		// What the user's configuration denies reading stays denied.
		await mkdir(join(home, ".atelier"), { recursive: true });
		await writeFile(join(home, "notes.txt"), "private notes\n");
		await writeFile(join(home, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: ["notes.txt"] }));
		const denied = await run(`cat ${home}/notes.txt`, confined());
		expect(denied.output).not.toContain("private notes");
		expect(denied.output).toMatch(/Operation not permitted/);
		// The same command of an agent that is not confined takes the configuration's allowWrite.
		expect((await run("echo child > deps/pkg/index.js", { cwd, scratchDir: scratch })).ok).toBe(true);
	});
});
