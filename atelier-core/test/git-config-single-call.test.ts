import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { isInsideSandbox, Sandbox } from "../src/tools/sandbox.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { gitConfigCases, gitConfigFixture } from "./support/git-config-cases.ts";

const contents = (path: string) => readFile(path, "utf8").catch(() => undefined);
const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

it.each(gitConfigCases)(
	"preserves public git protection: %s",
	async (kind) => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "git-config-cases-")));
		const sandbox = new Sandbox({ home: join(base, "home"), tempDir: base });
		try {
			const { cwd, home, protectedPaths, allowedPaths } = await gitConfigFixture(base, kind);
			for (const path of protectedPaths) {
				const before = await contents(path);
				const message = `${path} is git state that runs code: the agent does not write it.`;
				for (const tool of [createEditTool({ home }), createWriteTool({ home })]) {
					const input =
						tool.name === "edit"
							? { path, edits: [{ oldText: before ?? "original", newText: "changed" }] }
							: { path, content: "changed\n" };
					expect(await tool.gate?.(input, { cwd })).toEqual({ refusal: { output: message, summary: message } });
					expect(await tool.execute(input, { cwd })).toMatchObject({ ok: false, output: message });
					expect(await contents(path)).toBe(before);
				}
			}
			for (const path of allowedPaths) {
				const before = await contents(path);
				expect(
					await createEditTool({ home }).execute({ path, edits: [{ oldText: before, newText: "edited\n" }] }, { cwd }),
				).toMatchObject({ ok: true });
				expect(await createWriteTool({ home }).execute({ path, content: "written\n" }, { cwd })).toMatchObject({
					ok: true,
				});
				expect(await contents(path)).toBe("written\n");
			}
			if (process.platform === "darwin" && !isInsideSandbox()) {
				const before = await Promise.all(protectedPaths.map(contents));
				const result = await createBashTool({ sandbox }).execute(
					{
						command: protectedPaths.map((path) => `printf changed > ${quote(path)}`).join("; "),
					},
					{ cwd },
				);
				expect(result.ok).toBe(false);
				expect(result.output.match(/Operation not permitted/g)).toHaveLength(protectedPaths.length);
				expect(await Promise.all(protectedPaths.map(contents))).toEqual(before);
			}
		} finally {
			await sandbox.reset();
			await rm(base, { recursive: true, force: true });
		}
	},
	// The buffer-limit fixtures make git follow tens of thousands of includes, without any artificial wait.
	90_000,
);
