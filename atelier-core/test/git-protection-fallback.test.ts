import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FakeBackend, type FakeStep, Session } from "../src/index.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool, createWriteTool } from "../src/tools/index.ts";
import { isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";

const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};
async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "git-fallback-")));
	const cwd = join(base, "repo");
	const home = join(base, "home");
	await mkdir(cwd);
	await mkdir(home);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q");
	git("config", "core.hooksPath", ".hooks");
	git("config", "include.path", join(cwd, "included"));
	await writeFile(join(cwd, "included"), "# ok\n");
	await mkdir(join(cwd, ".hooks"));
	const hook = join(cwd, ".hooks", "pre-commit");
	await writeFile(hook, "old\n");
	return { cwd, home, base, hook };
}

// S1(a), S2: an agent-writable include must not disable the effective-hooks denial.
it.each(["edit", "write"] as const)("%s stays fail-closed when git cannot parse an included config", async (tool) => {
	const { cwd, home, hook } = await fixture();
	const backend = new FakeBackend([
		[
			{ toolCall: { tool: "write", callId: "corrupt", input: { path: "included", content: "[invalid\n" } } },
			{
				toolCall: {
					tool,
					callId: "hook",
					input:
						tool === "write"
							? { path: ".hooks/pre-commit", content: "new\n" }
							: { path: ".hooks/pre-commit", edits: [{ oldText: "old", newText: "new" }] },
				},
			},
			{ toolCall: { tool: "write", callId: "restore", input: { path: "included", content: "# ok\n" } } },
			finished,
		],
	]);
	const questions: unknown[] = [];
	const session = await Session.start({
		cwd,
		backend,
		tools: [createEditTool({ home }), createWriteTool({ home })],
		approve: async (request) => {
			questions.push(request);
			return true;
		},
	});
	try {
		for await (const _ of session.send("go"));
	} finally {
		await session.close();
	}
	expect(questions).toEqual([]);
	expect(backend.toolResults[1]?.ok).toBe(false);
	expect(await readFile(hook, "utf8")).toBe("old\n");
});

// S1(a), S2, S4: exercise the real sandbox, not a fake manager.
it.skipIf(process.platform !== "darwin" || isInsideSandbox())(
	"bash stays fail-closed after an include is corrupted",
	async () => {
		const { cwd, home, base, hook } = await fixture();
		const sandbox = new Sandbox({ home, tempDir: base });
		const run = (command: string) => createBashTool({ sandbox }).execute({ command }, { cwd });
		try {
			// The included file is itself protected, so the corruption never lands; the hook stays protected either way.
			const corrupt = await run("printf '[invalid\\n' > included");
			expect(corrupt.ok).toBe(false);
			expect(await readFile(join(cwd, "included"), "utf8")).toBe("# ok\n");
			const result = await run("printf 'new\\n' > .hooks/pre-commit");
			expect(result.ok).toBe(false);
			expect(await readFile(hook, "utf8")).toBe("old\n");
		} finally {
			await sandbox.reset();
		}
	},
);
