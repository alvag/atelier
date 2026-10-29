import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitChanges } from "../src/tui/git-branch.ts";

let base: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-git-status-"));
	git(base, "init", "-q", "-b", "main");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

/** A deliberately broken Git executable, not code from a repository's configuration. */
async function fakeGit(body: string, attributes = "") {
	const bin = join(base, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "git"),
		`#!${process.execPath}\nif (process.argv.includes('rev-parse')) process.stdout.write('sha1\\nfiles\\n'); else if (process.argv.includes('check-attr')) { ${attributes} } else if (!process.argv.includes('config')) { ${body} }\n`,
		{ mode: 0o755 },
	);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
}

describe("read-only git changes", () => {
	it("counts each changed path once, including a staged rename and newline-named untracked files", async () => {
		await writeFile(join(base, "tracked"), "original\n");
		await writeFile(join(base, "old"), "renamed content\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		expect(await readGitChanges(base)).toBe(0);
		await writeFile(join(base, ".git", "info", "global-ignore"), "ignored\n");
		git(base, "config", "core.excludesFile", join(base, ".git", "info", "global-ignore"));
		await writeFile(join(base, "ignored"), "not counted");
		expect(await readGitChanges(base)).toBe(0);
		git(base, "mv", "old", "new");
		await writeFile(join(base, "tracked"), "staged\n");
		git(base, "add", "tracked");
		await writeFile(join(base, "tracked"), "unstaged changes\n");
		await mkdir(join(base, "dir"));
		await writeFile(join(base, "dir", "a\nb"), "one");
		await writeFile(join(base, "dir", "two"), "two");
		git(base, "update-index", "--split-index");
		const index = await readFile(join(base, ".git", "index"));
		expect(await readGitChanges(base)).toBe(4);
		await rm(join(base, "tracked"));
		await symlink("new", join(base, "tracked"));
		expect(await readGitChanges(base)).toBe(4);
		expect(await readFile(join(base, ".git", "index"))).toEqual(index);
	});

	it("omits a clean filtered repository's false changes without writing its index", async () => {
		await writeFile(join(base, ".gitattributes"), "tracked filter=upper\n");
		git(base, "config", "filter.upper.clean", "tr a-z A-Z");
		await writeFile(join(base, "tracked"), "lowercase\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		// Force a content comparison without letting the control query refresh the index's stat cache.
		await utimes(join(base, "tracked"), 0, 0);
		expect(git(base, "--no-optional-locks", "status", "--porcelain").toString()).toBe("");
		const index = await readFile(join(base, ".git", "index"));
		expect(await readGitChanges(base)).toBeUndefined();
		expect(await readFile(join(base, ".git", "index"))).toEqual(index);
	});

	it("counts a real unfiltered change alongside an unchanged filtered file", async () => {
		await writeFile(join(base, ".gitattributes"), "filtered filter=lfs\n");
		await writeFile(join(base, "filtered"), "unchanged\n");
		await writeFile(join(base, "tracked"), "original\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		await writeFile(join(base, "tracked"), "real change\n");
		expect(await readGitChanges(base)).toBe(1);
	});

	it.each(["worktree", "info", "configured"])("omits changes with filter=lfs from %s attributes", async (source) => {
		await writeFile(join(base, "tracked"), "original\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		const attributes = source === "worktree" ? join(base, ".gitattributes") : join(base, ".git", "info", "attributes");
		await writeFile(attributes, "tracked filter=lfs\n");
		if (source === "configured") {
			await rm(attributes);
			const configured = join(base, ".git", "custom-attributes");
			await writeFile(configured, "tracked filter=lfs\n");
			git(base, "config", "core.attributesFile", configured);
		}
		await writeFile(join(base, "tracked"), "changed\n");
		const index = await readFile(join(base, ".git", "index"));
		expect(await readGitChanges(base)).toBeUndefined();
		expect(await readFile(join(base, ".git", "index"))).toEqual(index);
	});

	it("checks root-relative changed paths when started from a repository subdirectory", async () => {
		await writeFile(join(base, ".gitattributes"), "tracked filter=lfs\n");
		await writeFile(join(base, "tracked"), "original\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		await writeFile(join(base, "tracked"), "changed\n");
		const nested = join(base, "nested");
		await mkdir(nested);
		expect(await readGitChanges(nested)).toBeUndefined();
	});

	it.each(["deleted", "renamed", "untracked newline"])("checks filter attributes for a %s path", async (change) => {
		await writeFile(join(base, ".gitattributes"), "filtered* filter=unspecified\n");
		await writeFile(join(base, "filtered"), "original\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		if (change === "deleted") await rm(join(base, "filtered"));
		else if (change === "renamed") git(base, "mv", "filtered", "unfiltered");
		else await writeFile(join(base, "filtered\nname"), "new\n");
		expect(await readGitChanges(base)).toBeUndefined();
	});

	it("cannot run a filter added after the metadata query", async () => {
		await writeFile(join(base, "tracked"), "original\n");
		await writeFile(join(base, ".gitattributes"), "tracked filter=late\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		await writeFile(join(base, "tracked"), "modified\n");
		const marker = join(base, "executed");
		const probe = join(base, "probe.sh");
		await writeFile(probe, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const bin = join(base, "bin");
		await mkdir(bin);
		const config = `\n[filter "late"]\n clean = ${probe}\n required = true\n`;
		await writeFile(
			join(bin, "git"),
			`#!${process.execPath}
const args = process.argv.slice(2);
const output = require('node:child_process').execFileSync(${JSON.stringify(realGit)}, args, { input: args.includes('check-attr') ? require('node:fs').readFileSync(0) : undefined });
if (!args.includes('status')) require('node:fs').appendFileSync(${JSON.stringify(join(base, ".git", "config"))}, ${JSON.stringify(config)});
process.stdout.write(output);
`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
		expect(await readGitChanges(base)).toBeUndefined();
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("handles linked worktrees and ignores ambient repository and index redirects", async () => {
		await writeFile(join(base, "tracked"), "one");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		const worktree = join(base, "wt");
		git(base, "worktree", "add", "-q", "-b", "other", worktree);
		await writeFile(join(worktree, "tracked"), "changed");
		vi.stubEnv("GIT_DIR", join(base, ".git"));
		vi.stubEnv("GIT_WORK_TREE", base);
		vi.stubEnv("GIT_INDEX_FILE", join(base, "does-not-exist"));
		expect(await readGitChanges(worktree)).toBe(1);
	});

	it("omits the count rather than creating temporary metadata inside the worktree", async () => {
		vi.stubEnv("TMPDIR", base);
		expect(await readGitChanges(base)).toBeUndefined();
		expect(await readdir(base)).toEqual([".git"]);
	});

	it("stops below a ceiling named through a symlink, before invoking git", async () => {
		const ceiling = join(base, "ceiling");
		const child = join(ceiling, "child");
		await mkdir(child, { recursive: true });
		const link = join(base, "link");
		await symlink(ceiling, link);
		vi.stubEnv("GIT_CEILING_DIRECTORIES", link);
		await fakeGit(`require('node:fs').writeFileSync(${JSON.stringify(join(base, "executed"))}, 'yes');`);
		expect(await readGitChanges(child)).toBeUndefined();
		await expect(readFile(join(base, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("bounds a stuck command without blocking the event loop", async () => {
		await fakeGit("setInterval(() => {}, 1000);");
		let responsive = false;
		const pending = readGitChanges(base);
		setImmediate(() => {
			responsive = true;
		});
		expect(await pending).toBeUndefined();
		expect(responsive).toBe(true);
	});

	it("keeps the count when changed paths have only non-filter attributes", async () => {
		await fakeGit("process.stdout.write('?? x\\0');", "process.stdout.write('x\\0text\\0set\\0');");
		expect(await readGitChanges(base)).toBe(1);
	});

	it("cancels an attribute query and kills its child", async () => {
		const pidFile = join(base, "pid");
		await fakeGit(
			"process.stdout.write('?? x\\0');",
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
		);
		const controller = new AbortController();
		const pending = readGitChanges(base, controller.signal);
		await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/^\d+$/));
		const pid = Number(await readFile(pidFile, "utf8"));
		controller.abort();
		expect(await pending).toBeUndefined();
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
	});

	it.each([
		["overflow", "process.stdout.write('x\\0text\\0set\\0'.repeat(100_000));"],
		["nonzero exit", "process.exitCode = 1;"],
		["truncated record", "process.stdout.write('x\\0text\\0');"],
		["unterminated output", "process.stdout.write('x\\0text\\0set');"],
		["unexpected path", "process.stdout.write('other\\0text\\0set\\0');"],
		["timeout", "setInterval(() => {}, 1000);"],
	])("discards the count on attribute query %s", async (_name, body) => {
		await fakeGit("process.stdout.write('?? x\\0');", body);
		expect(await readGitChanges(base)).toBeUndefined();
	});

	it.each([
		["overflow", "process.stdout.write('?? x\\0'.repeat(500_000));"],
		["nonzero exit", "process.stdout.write('?? x\\0'); process.exitCode = 1;"],
		["truncated rename", "process.stdout.write('R  new\\0');"],
		["unterminated output", "process.stdout.write('?? x');"],
	])("discards partial results on %s", async (_name, body) => {
		await fakeGit(body);
		expect(await readGitChanges(base)).toBeUndefined();
	});
});
