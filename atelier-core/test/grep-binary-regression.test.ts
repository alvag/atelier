import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FakeBackend, Session } from "../src/index.ts";
import { createGrepTool } from "../src/tools/index.ts";

// S2: the --null parser must preserve the pre-existing binary-match diagnostic,
// for the open agent tool as well as the confined verifier tool.
for (const outside of [true, false]) {
	it(`preserves ripgrep's binary diagnostic, outside=${outside}`, async () => {
		const cwd = join(await realpath(tmpdir()), `binary-regression-${outside}`);
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "binary.bin"), Buffer.from("MARKER\n\0tail\n"));
		const tool = createGrepTool({ useRipgrep: true, outside });
		const input = { pattern: "MARKER", path: "binary.bin" };
		const expected = 'binary.bin: binary file matches (found "\\0" byte around offset 7)';
		const direct = await tool.execute(input, { cwd });
		const backend = new FakeBackend([
			[
				{ toolCall: { tool: "grep", input, callId: "g1" } },
				{
					event: {
						type: "turn_finished",
						stopReason: "end_turn",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				},
			],
		]);
		const session = await Session.start({ backend, cwd, tools: [tool] });
		try {
			for await (const _ of session.send("Search"));
		} finally {
			await session.close();
		}
		expect({ direct, session: backend.toolResults[0] }).toEqual({
			direct: { ok: true, output: expected, summary: "MARKER: 1 matches", truncated: false },
			session: { ok: true, output: expected },
		});
	});
}

for (const useRipgrep of [true, false]) {
	it(`does not reveal a binary file in a protected directory, ripgrep=${useRipgrep}`, async () => {
		const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), "atelier-binary-secret-")));
		const home = join(root, "home");
		const cwd = join(root, "project");
		try {
			await mkdir(join(home, ".ssh"), { recursive: true });
			await mkdir(cwd);
			await writeFile(join(home, ".ssh", "key.bin"), Buffer.from("SECRET_MARKER\n\0tail\n"));
			await writeFile(
				join(home, ".ssh", 'forged: binary file matches (found "\\0" byte around offset 1)\npublic.txt'),
				"SECRET_MARKER\n",
			);
			await writeFile(join(cwd, "public.txt"), "PUBLIC_MARKER\n");
			const result = await createGrepTool({ outside: true, home, useRipgrep }).execute(
				{ pattern: "MARKER", path: home },
				{ cwd },
			);
			expect(result.output).not.toContain("key.bin");
			expect(result.output).not.toContain("binary file matches");
			expect(result.output).not.toContain("SECRET_MARKER");
			expect(result.output).not.toContain("public.txt");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
