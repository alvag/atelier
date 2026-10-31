import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGitChanges } from "../src/tui/git-branch.ts";

let base: string;
/**
 * Far beyond the fake Git's start-up time, so the product's two-second deadline does not decide a result on a loaded
 * machine; each test's Vitest timeout is still the real bound.
 */
const loadTolerant = { timeoutMs: 30_000 };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
const commit = (cwd: string, ...options: string[]) =>
	git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base", ...options);
const lines = (added: number, removed: number) => ({ added, removed });

/** The lines git itself counts once the untracked files are added with intent, or nothing when git refuses to. */
function gitAddedLines(cwd: string) {
	git(cwd, "add", "-N", ".");
	let numstat: string;
	try {
		numstat = execFileSync("git", ["diff", "--numstat", "HEAD"], { cwd, stdio: "pipe" }).toString();
	} catch {
		return undefined;
	}
	const added = numstat
		.split("\n")
		.filter(Boolean)
		.reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0), 0);
	return lines(added, 0);
}
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "atelier-git-status-"));
	git(base, "init", "-q", "-b", "main");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

/** A Git that runs the real one, after `override`: a script body that sees `args` and may answer and `return` first. */
async function wrappedGit(override: string) {
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const bin = join(base, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "git"),
		`#!${process.execPath}
const args = process.argv.slice(2);
${override}
const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
`,
		{ mode: 0o755 },
	);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
}

/** A deliberately broken Git executable, not code from a repository's configuration. */
async function fakeGit(body: string, attributes = "") {
	const bin = join(base, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "git"),
		`#!${process.execPath}\nif (process.argv.includes('rev-parse')) process.stdout.write('sha1\\nfiles\\n'); else if (process.argv.includes('check-attr')) { ${attributes} } else if (process.argv.includes('status')) { ${body} }\n`,
		{ mode: 0o755 },
	);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
}

describe("read-only git changes", () => {
	it("counts lines against HEAD, staged and unstaged together, through a staged rename and newline-named untracked files", async () => {
		await writeFile(join(base, "tracked"), "original\n");
		await writeFile(join(base, "old"), "renamed content\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(0, 0) });
		await writeFile(join(base, ".git", "info", "global-ignore"), "ignored\n");
		git(base, "config", "core.excludesFile", join(base, ".git", "info", "global-ignore"));
		await writeFile(join(base, "ignored"), "not counted");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(0, 0) });
		git(base, "mv", "old", "new");
		await writeFile(join(base, "tracked"), "staged\n");
		git(base, "add", "tracked");
		await writeFile(join(base, "tracked"), "unstaged changes\n");
		await mkdir(join(base, "dir"));
		await writeFile(join(base, "dir", "a\nb"), "one");
		await writeFile(join(base, "dir", "two"), "two");
		git(base, "update-index", "--split-index");
		const index = await readFile(join(base, ".git", "index"));
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(3, 1) });
		await rm(join(base, "tracked"));
		await symlink("new", join(base, "tracked"));
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(3, 1) });
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
		expect((await readGitChanges(base)).lines).toBeUndefined();
		expect(await readFile(join(base, ".git", "index"))).toEqual(index);
	});

	it("counts a real unfiltered change alongside an unchanged filtered file", async () => {
		await writeFile(join(base, ".gitattributes"), "filtered filter=lfs\n");
		await writeFile(join(base, "filtered"), "unchanged\n");
		await writeFile(join(base, "tracked"), "original\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		await writeFile(join(base, "tracked"), "real change\n");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toEqual(lines(1, 1));
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
		expect((await readGitChanges(base)).lines).toBeUndefined();
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
		expect((await readGitChanges(nested)).lines).toBeUndefined();
	});

	it.each(["deleted", "renamed", "untracked newline"])("checks filter attributes for a %s path", async (change) => {
		await writeFile(join(base, ".gitattributes"), "filtered* filter=unspecified\n");
		await writeFile(join(base, "filtered"), "original\n");
		git(base, "add", ".");
		git(base, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		if (change === "deleted") await rm(join(base, "filtered"));
		else if (change === "renamed") git(base, "mv", "filtered", "unfiltered");
		else await writeFile(join(base, "filtered\nname"), "new\n");
		expect((await readGitChanges(base)).lines).toBeUndefined();
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
		expect((await readGitChanges(base)).lines).toBeUndefined();
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
		expect((await readGitChanges(worktree, undefined, loadTolerant)).lines).toEqual(lines(1, 1));
	});

	it("omits the count rather than creating temporary metadata inside the worktree", async () => {
		vi.stubEnv("TMPDIR", base);
		expect(await readGitChanges(base)).toEqual({});
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
		expect(await readGitChanges(child)).toEqual({});
		await expect(readFile(join(base, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("bounds a stuck command without blocking the event loop", async () => {
		await fakeGit("setInterval(() => {}, 1000);");
		let responsive = false;
		const started = Date.now();
		const pending = readGitChanges(base);
		setImmediate(() => {
			responsive = true;
		});
		expect(await pending).toEqual({});
		// The default deadline: two seconds after the call, never earlier.
		expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
		expect(responsive).toBe(true);
	});

	it("waits for a slow command up to the given timeout", { timeout: 15_000 }, async () => {
		await writeFile(join(base, "x"), "one\n");
		await fakeGit("setTimeout(() => process.stdout.write('?? x\\0'), 2500);");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toEqual(lines(1, 0));
	});

	it("keeps the count when changed paths have only non-filter attributes", async () => {
		await writeFile(join(base, "x"), "one\n");
		await fakeGit("process.stdout.write('?? x\\0');", "process.stdout.write('x\\0text\\0set\\0');");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toEqual(lines(1, 0));
	});

	it("cancels an attribute query and kills its child", async () => {
		const pidFile = join(base, "pid");
		await fakeGit(
			"process.stdout.write('?? x\\0');",
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
		);
		const controller = new AbortController();
		const pending = readGitChanges(base, controller.signal, loadTolerant);
		// A loaded machine starts the fake Git slowly: wait past the default second, but fail at once if the query gives up first.
		const ended = pending.then(() => {
			throw new Error("the status query ended before its attribute query started");
		});
		ended.catch(() => undefined);
		await Promise.race([
			vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/^\d+$/), { timeout: 5000 }),
			ended,
		]);
		const pid = Number(await readFile(pidFile, "utf8"));
		controller.abort();
		expect(await pending).toEqual({});
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
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
		expect((await readGitChanges(base)).lines).toBeUndefined();
	});

	it.each([
		["overflow", "process.stdout.write('?? x\\0'.repeat(500_000));"],
		["nonzero exit", "process.stdout.write('?? x\\0'); process.exitCode = 1;"],
		["truncated rename", "process.stdout.write('R  new\\0');"],
		["unterminated output", "process.stdout.write('?? x');"],
	])("discards partial results on %s", async (_name, body) => {
		await fakeGit(body);
		expect((await readGitChanges(base)).lines).toBeUndefined();
	});

	it("counts untracked lines as added, a missing last newline included, and binary files as nothing", async () => {
		await writeFile(join(base, "text"), "a\nb\nc\n");
		await writeFile(join(base, "image"), Buffer.from([1, 0, 2, 10]));
		git(base, "add", ".");
		commit(base);
		await writeFile(join(base, "text"), "a\nB\nc\n");
		git(base, "add", "text");
		await writeFile(join(base, "text"), "a\nB\nc\nd\n");
		await writeFile(join(base, "image"), Buffer.from([1, 0, 3, 10, 10]));
		await writeFile(join(base, "new"), "x\ny");
		await writeFile(join(base, "empty"), "");
		await writeFile(join(base, "blob"), Buffer.from([0, 10, 10]));
		await symlink("text", join(base, "link"));
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(5, 1) });
	});

	it("tells untracked binary and text files by their diff attribute, as once they are added", async () => {
		await writeFile(join(base, ".gitattributes"), "*.bin binary\n*.txt diff\n");
		git(base, "add", ".");
		commit(base);
		await writeFile(join(base, "payload.bin"), "a\nb\nc\n");
		await writeFile(join(base, "forced.txt"), "a\0\nb\n");
		await writeFile(join(base, "plain"), "x\0y\n");
		const untracked = await readGitChanges(base, undefined, loadTolerant);
		expect(untracked).toEqual({ lines: lines(2, 0) });
		git(base, "add", "-N", ".");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual(untracked);
	});

	it("tells binary and text files by their diff driver's binary setting, as git diff does", async () => {
		git(base, "config", "diff.bin.binary", "true");
		git(base, "config", "diff.texty.binary", "false");
		await writeFile(join(base, ".gitattributes"), "*.dat diff=bin\n*.tx diff=texty\n");
		git(base, "add", ".");
		commit(base);
		await writeFile(join(base, "a.dat"), "a\nb\n");
		await writeFile(join(base, "b.tx"), "a\0\nb\nc\n");
		const untracked = await readGitChanges(base, undefined, loadTolerant);
		expect(untracked).toEqual({ lines: lines(3, 0) });
		git(base, "add", "-N", ".");
		expect(git(base, "diff", "--numstat", "HEAD").toString()).toBe("-\t-\ta.dat\n3\t0\tb.tx\n");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual(untracked);
	});

	it("counts an untracked symlink as one line even when marked binary, as once it is added", async () => {
		await writeFile(join(base, ".gitattributes"), "link binary\n");
		git(base, "add", ".");
		commit(base);
		await symlink("target", join(base, "link"));
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(1, 0) });
		git(base, "add", "-N", "link");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(1, 0) });
	});

	it("omits the lines when a changed path has a working-tree encoding, which git would convert", async () => {
		await writeFile(join(base, ".gitattributes"), "*.u16 working-tree-encoding=UTF-16\n");
		git(base, "add", ".");
		commit(base);
		await writeFile(join(base, "a.u16"), Buffer.from("\ufeffone\ntwo\n", "utf16le"));
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toBeUndefined();
	});

	it("keeps counting when the working-tree encoding is disabled or UTF-8, which git does not convert", async () => {
		await writeFile(join(base, ".gitattributes"), "* -working-tree-encoding\n*.u8 working-tree-encoding=UTF-8\n");
		await writeFile(join(base, "tracked"), "old\n");
		await writeFile(join(base, "a.u8"), "x\n");
		git(base, "add", ".");
		commit(base);
		await writeFile(join(base, "tracked"), "one\ntwo\n");
		await writeFile(join(base, "a.u8"), "x\ny\n");
		expect(git(base, "diff", "--numstat", "HEAD").toString()).toBe("1\t0\ta.u8\n2\t1\ttracked\n");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(3, 1) });
	});

	it("reads a driver's binary setting as git reads a boolean, numbers included", async () => {
		git(base, "config", "diff.bin.binary", "2");
		git(base, "config", "diff.nobin.binary", "0k");
		await writeFile(join(base, ".gitattributes"), "*.dat diff=bin\n*.zero diff=nobin\n");
		git(base, "add", ".");
		commit(base);
		await writeFile(join(base, "a.dat"), "a\nb\n");
		await writeFile(join(base, "b.zero"), "a\0\nb\nc\n");
		const untracked = await readGitChanges(base, undefined, loadTolerant);
		expect(untracked).toEqual({ lines: lines(3, 0) });
		git(base, "add", "-N", ".");
		expect(git(base, "diff", "--numstat", "HEAD").toString()).toBe("-\t-\ta.dat\n3\t0\tb.zero\n");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual(untracked);
	});

	it.each([
		"auto",
		"AUTO",
		"true",
		"off",
		"",
		"2",
		"0x1",
		"0X10",
		"0x0",
		"010",
		"00",
		"08",
		"0x",
		"1k",
		"0K",
		"1g",
		"1t",
		"-1",
		"+1",
		" 1",
		"\t1",
		"1 ",
		"1.5",
		"2097151k",
		"2097152k",
		"2147483647",
		"2147483648",
		"-2147483648",
		"-2147483649",
		"-0x80000000",
		"-0x80000001",
		"-2g",
		"-3g",
		"-2097152k",
		"-2097153k",
		"true\t",
	])("reads diff.<driver>.binary=%j exactly as git does, or omits the lines where git refuses it", async (value) => {
		await writeFile(join(base, ".gitattributes"), "*.dat diff=x\n");
		git(base, "add", ".");
		commit(base);
		git(base, "config", "diff.x.binary", value);
		await writeFile(join(base, "f.dat"), "a\nb\n");
		await writeFile(join(base, "g.dat"), "a\0\nb\nc\n");
		const counted = (await readGitChanges(base, undefined, loadTolerant)).lines;
		expect(counted).toEqual(gitAddedLines(base));
	});

	it.each([
		["false", "auto"],
		["true", "auto"],
		["auto", "true"],
		["true", "false"],
		["bogus", "true"],
		["true", "bogus"],
	])("takes the last diff.<driver>.binary of %j then %j, as git does", async (first, last) => {
		await writeFile(join(base, ".gitattributes"), "*.dat diff=x\n");
		git(base, "add", ".");
		commit(base);
		git(base, "config", "--add", "diff.x.binary", first);
		git(base, "config", "--add", "diff.x.binary", last);
		await writeFile(join(base, "f.dat"), "a\nb\n");
		await writeFile(join(base, "g.dat"), "a\0\nb\nc\n");
		const counted = (await readGitChanges(base, undefined, loadTolerant)).lines;
		expect(counted).toEqual(gitAddedLines(base));
	});

	it("omits the lines rather than counting an untracked file it cannot read as zero", async () => {
		await writeFile(join(base, "readable"), "one\n");
		await writeFile(join(base, "locked"), "two\n", { mode: 0o000 });
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toBeUndefined();
	});

	it.each(["sha1", "sha256"])("counts against the empty %s tree before the first commit", async (format) => {
		const repository = join(base, format);
		await mkdir(repository);
		git(repository, "init", "-q", `--object-format=${format}`);
		await writeFile(join(repository, "staged"), "a\nb\n");
		git(repository, "add", "staged");
		await writeFile(join(repository, "untracked"), "c\n");
		expect(await readGitChanges(repository, undefined, loadTolerant)).toEqual({ lines: lines(3, 0) });
	});

	it("counts lines on a detached HEAD", async () => {
		await writeFile(join(base, "tracked"), "one\n");
		git(base, "add", ".");
		commit(base);
		git(base, "checkout", "-q", "--detach");
		await writeFile(join(base, "tracked"), "one\ntwo\n");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(1, 0) });
	});

	it("omits the lines rather than reading more than 1000 untracked files or 8 MiB of them", async () => {
		await mkdir(join(base, "many"));
		for (let i = 0; i < 1000; i++) await writeFile(join(base, "many", String(i)), "x\n");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toEqual(lines(1000, 0));
		await writeFile(join(base, "many", "extra"), "x\n");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toBeUndefined();
		await rm(join(base, "many"), { recursive: true });
		await writeFile(join(base, "big"), Buffer.alloc(8 * 1024 * 1024, "\n"));
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toEqual(lines(8 * 1024 * 1024, 0));
		await writeFile(join(base, "more"), "x");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toBeUndefined();
	});

	it("never opens an untracked FIFO", async () => {
		execFileSync("mkfifo", [join(base, "pipe")]);
		await writeFile(join(base, "file"), "x\n");
		expect((await readGitChanges(base, undefined, loadTolerant)).lines).toEqual(lines(1, 0));
	});
});

describe("read-only commits against the upstream", () => {
	/** `main` two commits ahead of `origin/main` and one behind it, all local: no remote is ever contacted. */
	async function diverged() {
		await writeFile(join(base, "tracked"), "one\n");
		git(base, "add", ".");
		commit(base);
		git(base, "checkout", "-q", "-b", "theirs");
		commit(base, "--allow-empty", "-m", "theirs");
		const theirs = git(base, "rev-parse", "HEAD").toString().trim();
		git(base, "checkout", "-q", "main");
		commit(base, "--allow-empty", "-m", "first");
		commit(base, "--allow-empty", "-m", "second");
		git(base, "config", "remote.origin.url", join(base, "unreachable"));
		git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
		git(base, "config", "branch.main.remote", "origin");
		git(base, "config", "branch.main.merge", "refs/heads/main");
		git(base, "update-ref", "refs/remotes/origin/main", theirs);
	}

	it("counts commits ahead of and behind the local remote-tracking ref", async () => {
		await diverged();
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({
			lines: lines(0, 0),
			commits: { ahead: 2, behind: 1 },
		});
	});

	it("counts against a local branch, and says zero when even", async () => {
		await diverged();
		git(base, "config", "branch.main.remote", ".");
		git(base, "config", "branch.main.merge", "refs/heads/theirs");
		expect((await readGitChanges(base, undefined, loadTolerant)).commits).toEqual({ ahead: 2, behind: 1 });
		git(base, "config", "branch.main.merge", "refs/heads/main");
		expect((await readGitChanges(base, undefined, loadTolerant)).commits).toEqual({ ahead: 0, behind: 0 });
	});

	it("has no commits without an upstream, with a deleted one or on a detached HEAD", async () => {
		await diverged();
		git(base, "config", "--unset", "branch.main.merge");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(0, 0) });
		git(base, "config", "branch.main.merge", "refs/heads/main");
		git(base, "update-ref", "-d", "refs/remotes/origin/main");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(0, 0) });
		git(base, "update-ref", "refs/remotes/origin/main", "HEAD");
		git(base, "checkout", "-q", "--detach");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ lines: lines(0, 0) });
	});

	it.each(["refs/tags/v1", "HEAD", "refs/remotes/origin/ma\x1bin", "refs/remotes/origin/main\nrefs/heads/main"])(
		"has no commits for an upstream named %j",
		async (name) => {
			await diverged();
			await wrappedGit(
				`if (args.includes('@{upstream}')) { process.stdout.write(${JSON.stringify(JSON.stringify(`${name}\n`))}); return; }`,
			);
			const changes = await readGitChanges(base, undefined, loadTolerant);
			expect(changes.lines).toBeDefined();
			expect(changes.commits).toBeUndefined();
		},
	);

	it("asks for the upstream with the same sanitized environment and safety flags", async () => {
		await diverged();
		const record = join(base, "upstream-call");
		await wrappedGit(
			`if (args.includes('@{upstream}')) require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'))) }));`,
		);
		vi.stubEnv("GIT_DIR", join(base, "elsewhere"));
		vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.pager'='false'");
		expect((await readGitChanges(base, undefined, loadTolerant)).commits).toEqual({ ahead: 2, behind: 1 });
		const call = JSON.parse(await readFile(record, "utf8"));
		expect(call.args).toEqual(expect.arrayContaining(["--no-pager", "--no-optional-locks"]));
		expect(Object.keys(call.env).sort()).toEqual([
			"GIT_ATTR_NOSYSTEM",
			"GIT_CEILING_DIRECTORIES",
			"GIT_NO_LAZY_FETCH",
			"GIT_OPTIONAL_LOCKS",
		]);
		expect(call.env).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
	});

	it("cancels a stuck upstream query and kills its child", async () => {
		await diverged();
		const pidFile = join(base, "pid");
		await wrappedGit(
			`if (args.includes('@{upstream}')) { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); return; }`,
		);
		const controller = new AbortController();
		const pending = readGitChanges(base, controller.signal, loadTolerant);
		await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/^\d+$/), { timeout: 5000 });
		const pid = Number(await readFile(pidFile, "utf8"));
		controller.abort();
		expect(await pending).toEqual({});
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
	});

	it("bounds a stuck upstream query by the shared deadline", { timeout: 15_000 }, async () => {
		await diverged();
		await wrappedGit("if (args.includes('@{upstream}')) { setInterval(() => {}, 1000); return; }");
		const started = Date.now();
		expect(await readGitChanges(base, undefined, { timeoutMs: 3000 })).toEqual({});
		expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
	});

	it("keeps the commits when the line count fails", async () => {
		await diverged();
		await wrappedGit("if (args.includes('status')) { process.exitCode = 1; return; }");
		expect(await readGitChanges(base, undefined, loadTolerant)).toEqual({ commits: { ahead: 2, behind: 1 } });
	});
});
