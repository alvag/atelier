import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { VERSION } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/run.ts";

let root: string;
let origin: string;
let install: string;
let fakes: string;
let pnpmLog: string;

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();

/** Commits on the origin and tags the commit, as a release would. */
async function release(tag: string): Promise<void> {
	await writeFile(join(origin, "tag.txt"), tag);
	git(origin, "add", ".");
	git(origin, "commit", "--quiet", "-m", tag);
	git(origin, "tag", tag);
}

/** A pnpm that records where it ran and with what; it fails when `pnpm-fails` exists. */
async function fakePnpm(): Promise<void> {
	const file = join(fakes, "pnpm");
	await writeFile(
		file,
		`#!/bin/sh\necho "$PWD: $*" >> "${pnpmLog}"\nif [ -e "${join(root, "pnpm-fails")}" ]; then echo "boom" >&2; exit 7; fi\nif [ -e "${join(root, "pnpm-fails-on")}" ] && case " $* " in *" $(cat "${join(root, "pnpm-fails-on")}") "*) true ;; *) false ;; esac; then echo "boom" >&2; exit 7; fi\n`,
	);
	await chmod(file, 0o755);
}

async function pnpmCalls(): Promise<string[]> {
	return (await readFile(pnpmLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

function cli(argv: string[]) {
	let stdout = "";
	let stderr = "";
	const io = {
		stdin: new PassThrough(),
		isTTY: false,
		stdout: (text: string) => {
			stdout += text;
		},
		stderr: (text: string) => {
			stderr += text;
		},
		cwd: root,
		color: false,
		env: {
			PATH: `${fakes}:${process.env.PATH ?? ""}`,
			HOME: root,
			GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
		},
		appRoot: install,
	};
	return {
		code: () => run(argv, io, () => Promise.reject(new Error("no backend"))),
		out: () => stdout,
		err: () => stderr,
	};
}

const head = () => git(install, "rev-parse", "HEAD");
const marker = join(".git", "atelier-install");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-update-"));
	origin = join(root, "origin");
	install = join(root, "app");
	fakes = join(root, "fakes");
	pnpmLog = join(root, "pnpm.log");
	await mkdir(origin);
	await mkdir(fakes);
	await fakePnpm();
	git(origin, "init", "--quiet", "-b", "main");
	await release("v0.1.0");
	await release("v0.9.0");
	git(root, "clone", "--quiet", origin, install);
	git(install, "checkout", "--quiet", "--detach", "v0.1.0");
	await writeFile(join(install, marker), "desktop=0\n");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("atelier update", () => {
	it("moves to the newest vX.Y.Z tag by semantic order, after fetching new tags", async () => {
		await release("v0.10.0");
		await release("v0.11.0-rc1");
		await release("nightly");

		const c = cli(["update"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe("Updated atelier v0.1.0 → v0.10.0\n");
		expect(c.err()).toBe("");
		expect(git(install, "describe", "--tags", "--exact-match")).toBe("v0.10.0");
		expect(git(install, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
		expect(await pnpmCalls()).toEqual([`${await realRoot()}: install --frozen-lockfile --prod`]);
	});

	it("goes back to an older version when asked", async () => {
		git(install, "checkout", "--quiet", "--detach", "v0.9.0");

		const c = cli(["update", "v0.1.0"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe("Updated atelier v0.9.0 → v0.1.0\n");
		expect(git(install, "describe", "--tags", "--exact-match")).toBe("v0.1.0");
		expect(await pnpmCalls()).toHaveLength(1);
	});

	it("says it is already there and touches nothing", async () => {
		git(install, "checkout", "--quiet", "--detach", "v0.9.0");
		const before = head();

		const c = cli(["update"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe("atelier is already at v0.9.0\n");
		expect(head()).toBe(before);
		expect(await pnpmCalls()).toEqual([]);
	});

	it("says it is already at the requested version", async () => {
		const c = cli(["update", "v0.1.0"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe("atelier is already at v0.1.0\n");
		expect(await pnpmCalls()).toEqual([]);
	});

	it("falls back to the core's version when HEAD has no release tag", async () => {
		await writeFile(join(install, "local.txt"), "x");
		git(install, "add", ".");
		git(install, "commit", "--quiet", "-m", "local");

		const c = cli(["update", "v0.9.0"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe(`Updated atelier v${VERSION} → v0.9.0\n`);
	});

	it("refuses an unknown version, listing the releases", async () => {
		const before = head();

		const c = cli(["update", "v7.0.0"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe("error: No release v7.0.0; available: v0.1.0, v0.9.0\n");
		expect(c.out()).toBe("");
		expect(head()).toBe(before);
		expect(await pnpmCalls()).toEqual([]);
	});

	it("refuses a development clone without touching it", async () => {
		await rm(join(install, marker));
		await release("v0.10.0");
		const before = head();

		const c = cli(["update"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe(
			`error: atelier update only updates a copy installed with install.sh; ${install} is a development clone (use git there).\n`,
		);
		expect(c.out()).toBe("");
		expect(head()).toBe(before);
		expect(git(install, "tag", "--list", "v0.10.0")).toBe("");
		expect(await pnpmCalls()).toEqual([]);
	});

	it("refuses a worktree with local changes", async () => {
		await release("v0.10.0");
		await writeFile(join(install, "tag.txt"), "edited");
		const before = head();

		const c = cli(["update"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe(
			`error: ${install} has local changes; commit or discard them before updating (git status shows them).\n`,
		);
		expect(head()).toBe(before);
		expect(await readFile(join(install, "tag.txt"), "utf8")).toBe("edited");
		expect(await pnpmCalls()).toEqual([]);
	});

	it("installs the full dependencies and rebuilds the desktop when it is installed", async () => {
		await writeFile(join(install, marker), "desktop=1\n");

		const c = cli(["update", "v0.9.0"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe("Updated atelier v0.1.0 → v0.9.0\n");
		expect(await pnpmCalls()).toEqual([
			`${await realRoot()}: install --frozen-lockfile`,
			`${await realRoot()}: -C atelier-desktop build`,
		]);
	});

	it("does not build the desktop when it is not installed", async () => {
		const c = cli(["update", "v0.9.0"]);
		expect(await c.code()).toBe(0);

		expect(await pnpmCalls()).toEqual([`${await realRoot()}: install --frozen-lockfile --prod`]);
	});

	it("reports a failed rebuild: the CLI is updated, the desktop is not, and how to retry", async () => {
		await writeFile(join(install, marker), "desktop=1\n");
		await writeFile(join(root, "pnpm-fails-on"), "build");

		const c = cli(["update", "v0.9.0"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe(
			`error: pnpm -C atelier-desktop build failed (exit 7): boom\natelier is updated to v0.9.0 but the desktop is not built; retry with: atelier desktop (it builds when the output is missing)\n`,
		);
		expect(c.out()).toBe("");
		expect(git(install, "describe", "--tags", "--exact-match")).toBe("v0.9.0");
	});

	it("goes back to the previous version when pnpm fails, and says how to retry", async () => {
		await writeFile(join(root, "pnpm-fails"), "");
		const before = head();

		const c = cli(["update", "v0.9.0"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe(
			"error: pnpm install --frozen-lockfile --prod failed (exit 7): boom\natelier stays at v0.1.0; retry with: atelier update v0.9.0\n",
		);
		expect(c.out()).toBe("");
		expect(head()).toBe(before);
	});

	it("names the git command that failed", async () => {
		git(install, "remote", "set-url", "origin", join(root, "missing"));

		const c = cli(["update"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toMatch(/^error: git fetch --tags --quiet failed \(exit 128\): /);
		expect(await pnpmCalls()).toEqual([]);
	});
});

describe("atelier update usage", () => {
	it("rejects extra words and hints to quote a prompt", async () => {
		const c = cli(["update", "the", "deps"]);
		expect(await c.code()).toBe(2);

		expect(c.err()).toBe(
			'error: Usage: atelier update [vX.Y.Z]. To give a prompt that starts with "update", quote it: atelier "update the deps"\nRun atelier --help for usage.\n',
		);
		expect(await pnpmCalls()).toEqual([]);
	});

	it("rejects a version that is not vX.Y.Z", async () => {
		const c = cli(["update", "0.2.0"]);
		expect(await c.code()).toBe(2);

		expect(c.err()).toContain("Usage: atelier update [vX.Y.Z]");
	});

	it("rejects a version with a leading zero", async () => {
		const c = cli(["update", "v01.2.3"]);
		expect(await c.code()).toBe(2);

		expect(c.err()).toContain("Usage: atelier update [vX.Y.Z]");
	});

	it("rejects session options", async () => {
		const c = cli(["update", "--model", "sonnet"]);
		expect(await c.code()).toBe(2);

		expect(c.err()).toBe("error: atelier update takes no session options (--model).\nRun atelier --help for usage.\n");
		expect(await pnpmCalls()).toEqual([]);
	});
});

/** The directory pnpm reports as its cwd: the platform's real path of the install. */
async function realRoot(): Promise<string> {
	const { realpath } = await import("node:fs/promises");
	return realpath(install);
}

// S2/S4: installer and updater both select stable semantic releases.
it("ignores a leading-zero release tag", async () => {
	await release("v01.2.3");
	const c = cli(["update"]);
	expect(await c.code()).toBe(0);
	expect(c.out()).toBe("Updated atelier v0.1.0 → v0.9.0\n");
});

// S5: a failed rebuild cannot later open the old bundle as the new desktop.
it("retries a failed desktop rebuild before opening", async () => {
	await writeFile(join(install, marker), "desktop=1\n");
	await writeFile(join(install, ".git", "info", "exclude"), "atelier-desktop/\n");
	await mkdir(join(install, "atelier-desktop", "out", "main"), { recursive: true });
	await writeFile(join(install, "atelier-desktop", "out", "main", "index.js"), "// old bundle\n");
	await writeFile(join(root, "pnpm-fails-on"), "build");
	expect(await cli(["update", "v0.9.0"]).code()).toBe(1);
	const opened: string[] = [];
	let stdout = "";
	let stderr = "";
	const code = await run(["desktop"], {
		stdin: new PassThrough(),
		isTTY: false,
		cwd: root,
		color: false,
		appRoot: install,
		env: { ...process.env, HOME: root, PATH: `${fakes}:${process.env.PATH ?? ""}` },
		stdout: (s) => {
			stdout += s;
		},
		stderr: (s) => {
			stderr += s;
		},
		openDesktop: (binary) => {
			opened.push(binary);
		},
	});
	expect(code).toBe(1);
	expect(stderr).toBe("error: pnpm -C atelier-desktop build failed (exit 7): boom\n");
	expect(stdout).not.toContain("Opened");
	expect(opened).toEqual([]);
});

// S5: a build that wrote part of its output before failing leaves nothing to open.
it("rebuilds after a failed rebuild that left partial output", async () => {
	await writeFile(join(install, marker), "desktop=1\n");
	await writeFile(join(install, ".git", "info", "exclude"), "atelier-desktop/\n");
	await writeFile(
		join(fakes, "pnpm"),
		`#!/bin/sh\necho "$PWD: $*" >> "${pnpmLog}"\ncase "$*" in *build*) mkdir -p atelier-desktop/out/main; echo '// main only' > atelier-desktop/out/main/index.js; echo "renderer build failed" >&2; exit 7 ;; esac\n`,
	);
	expect(await cli(["update", "v0.9.0"]).code()).toBe(1);
	expect(existsSync(join(install, "atelier-desktop", "out"))).toBe(false);
	const opened: string[] = [];
	let stderr = "";
	const code = await run(["desktop"], {
		stdin: new PassThrough(),
		isTTY: false,
		cwd: root,
		color: false,
		appRoot: install,
		env: { ...process.env, HOME: root, PATH: `${fakes}:${process.env.PATH ?? ""}` },
		stdout: () => {},
		stderr: (s) => {
			stderr += s;
		},
		openDesktop: (binary) => {
			opened.push(binary);
		},
	});
	expect(code).toBe(1);
	expect(stderr).toBe("error: pnpm -C atelier-desktop build failed (exit 7): renderer build failed\n");
	expect(opened).toEqual([]);
	expect((await pnpmCalls()).filter((line) => line.endsWith("-C atelier-desktop build"))).toHaveLength(2);
	expect(existsSync(join(install, "atelier-desktop", "out"))).toBe(false);
});
