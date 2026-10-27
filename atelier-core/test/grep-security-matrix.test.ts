import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { createEditTool, createGrepTool, createReadTool } from "../src/tools/index.ts";

// S2, plus S3's refusal to edit protected files even after approval.
for (const useRipgrep of [true, false]) {
	it(`protects odd filenames and counts only public matches, ripgrep=${useRipgrep}`, async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "atelier-grep-matrix-")));
		const cwd = join(root, "project"),
			home = join(root, "home"),
			outside = join(root, "outside");
		try {
			for (const dir of [join(cwd, ".atelier"), join(home, ".ssh"), outside]) await mkdir(dir, { recursive: true });
			const names = [
				"x:1:y.txt",
				"line\nbreak.txt",
				"cr\rname.txt",
				"tab\tname.txt",
				"-A.txt",
				"control\u0001.txt",
				"é.txt",
				"e\u0301.txt",
				`${"a".repeat(230)}.txt`,
			];
			const hash = async (path: string) =>
				createHash("sha256")
					.update(await readFile(path))
					.digest("hex");
			const grep = createGrepTool({ outside: true, home, useRipgrep });
			const read = createReadTool({ outside: true, home });
			const edit = createEditTool({ home });
			for (const name of names) {
				const secret = join(home, ".ssh", name);
				await writeFile(secret, "SECRET_MARKER\n");
				await writeFile(join(outside, name), "PUBLIC_MARKER\n");
				const before = await hash(secret);
				const expected = `Path is a protected secret location: ${secret}`;
				expect((await read.execute({ path: secret }, { cwd })).output).toBe(expected);
				expect(
					(
						await edit.execute(
							{ path: secret, edits: [{ oldText: "SECRET", newText: "BAD" }] },
							{ cwd, approvedPaths: new Set([secret]) },
						)
					).output,
				).toBe(expected);
				expect(await hash(secret)).toBe(before);
			}
			const first = names[0];
			if (first === undefined) throw new Error("no secret file names to test");
			await symlink(join(home, ".ssh", first), join(outside, "file-link.txt"));
			await symlink(join(home, ".ssh"), join(outside, "dir-link"));
			for (const glob of ["*", "**", "**/*.txt", "{*.txt,*.md}", "!*.md", "!dir-link/**"]) {
				const result = await grep.execute({ pattern: "MARKER", path: root, glob }, { cwd });
				expect(result.ok).toBe(true);
				expect(result.output).not.toContain("SECRET_MARKER");
			}
			const denied = join(outside, first);
			await writeFile(denied, "DENIED_MARKER\n".repeat(400));
			await writeFile(join(outside, "public.txt"), "PUBLIC_MARKER\n".repeat(101));
			const before = await hash(denied);
			for (const entry of [denied, relative(cwd, denied), `${denied}/`]) {
				await writeFile(join(cwd, ".atelier", "sandbox.json"), JSON.stringify({ denyRead: [entry] }));
				const result = await grep.execute({ pattern: "MARKER", path: outside, glob: "*.txt" }, { cwd });
				expect(result.output).not.toContain("DENIED_MARKER");
				expect(result.summary).toBe("MARKER: 100+ matches");
				expect(result.output).toContain("[Showing the first 100 matches. Narrow the pattern, path or glob.]");
				expect(await hash(denied)).toBe(before);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
