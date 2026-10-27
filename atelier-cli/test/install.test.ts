import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "install.sh");
/** The system tools install.sh may use; everything else is hidden from its PATH. */
const systemTools = [
	"sh",
	"git",
	"mkdir",
	"rm",
	"chmod",
	"cat",
	"sed",
	"head",
	"grep",
	"sort",
	"dirname",
	"tr",
	"uname",
];

let root: string;
let home: string;
let origin: string;
let tools: string;
let fakes: string;
let installDir: string;
let binDir: string;

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();

async function fake(name: string, body: string): Promise<void> {
	const file = join(fakes, name);
	await writeFile(file, `#!/bin/sh\n${body}\n`);
	await chmod(file, 0o755);
}

function which(name: string): string {
	return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

interface Outcome {
	status: number | null;
	stdout: string;
	stderr: string;
}

function installEnv(extraPath = ""): Record<string, string> {
	return {
		PATH: [fakes, tools, extraPath].filter(Boolean).join(":"),
		HOME: home,
		ATELIER_REPO: origin,
		ATELIER_INSTALL_DIR: installDir,
		ATELIER_BIN_DIR: binDir,
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function install(args: string[] = [], extraPath = ""): Outcome {
	const result = spawnSync("sh", [script, ...args], { encoding: "utf8", env: installEnv(extraPath) });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Waits for what the test needs, never a fixed delay: a loaded machine runs the installer slower. */
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-install-"));
	home = join(root, "home");
	origin = join(root, "origin");
	tools = join(root, "tools");
	fakes = join(root, "fakes");
	installDir = join(home, ".atelier", "app");
	binDir = join(home, ".local", "bin");
	await mkdir(home);
	await mkdir(origin);
	await mkdir(tools);
	await mkdir(fakes);
	for (const name of systemTools) await symlink(which(name), join(tools, name));
	await fake("node", 'echo "v22.19.0"');
	await fake("pnpm", `echo "$PWD: $*" >> "${join(root, "pnpm.log")}"`);

	git(origin, "init", "--quiet", "-b", "main");
	await mkdir(join(origin, "atelier-cli", "src"), { recursive: true });
	await writeFile(join(origin, "atelier-cli", "src", "main.ts"), "// entry\n");
	git(origin, "add", ".");
	git(origin, "commit", "--quiet", "-m", "one");
	for (const tag of ["v0.9.0", "v0.10.0", "v0.2.0", "v0.11.0-rc1", "nightly"]) {
		await writeFile(join(origin, "tag.txt"), tag);
		git(origin, "add", ".");
		git(origin, "commit", "--quiet", "-m", tag);
		git(origin, "tag", tag);
	}
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("install.sh", () => {
	it("installs the newest vX.Y.Z tag by semantic order", async () => {
		const out = install();

		expect(out.status).toBe(0);
		expect(out.stderr).toContain(`Add ${binDir} to your PATH`);
		expect(out.stdout.trim().split("\n").at(-1)).toBe(`Installed atelier v0.10.0 in ${installDir}. Run: atelier`);
		expect(git(installDir, "describe", "--tags")).toBe("v0.10.0");
		expect(git(installDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
		expect(git(installDir, "status", "--porcelain")).toBe("");
		expect(await readFile(join(installDir, ".git", "atelier-install"), "utf8")).toBe("desktop=0\n");
	});

	it("installs only the CLI dependencies, frozen, inside the clone", async () => {
		install();

		const log = await readFile(join(root, "pnpm.log"), "utf8");
		expect(log).toBe(`${installDir}: install --frozen-lockfile --prod\n`);
	});

	it("with --desktop installs the full dependencies, builds the desktop and marks it", async () => {
		const out = install(["--desktop"]);

		expect(out.status).toBe(0);
		const log = await readFile(join(root, "pnpm.log"), "utf8");
		expect(log).toBe(`${installDir}: install --frozen-lockfile\n${installDir}: -C atelier-desktop build\n`);
		expect(await readFile(join(installDir, ".git", "atelier-install"), "utf8")).toBe("desktop=1\n");
		expect(existsSync(join(binDir, "atelier"))).toBe(true);
	});

	it("with --desktop, a failed build fails the install and removes the clone", async () => {
		await fake("pnpm", `echo "$PWD: $*" >> "${join(root, "pnpm.log")}"\ncase "$*" in *build*) exit 3 ;; esac`);

		const out = install(["--desktop"]);

		expect(out.status).not.toBe(0);
		expect(existsSync(installDir)).toBe(false);
		expect(existsSync(join(binDir, "atelier"))).toBe(false);
	});

	it("creates an executable launcher script that runs the CLI from the install", async () => {
		install();

		const launcher = join(binDir, "atelier");
		expect(await readFile(launcher, "utf8")).toBe(
			`#!/bin/sh\nexec node '${installDir}/atelier-cli/src/main.ts' "$@"\n`,
		);
		expect((await stat(launcher)).mode & 0o777).toBe(0o755);
	});

	it("does not warn when the bin dir is on PATH", () => {
		const out = install([], binDir);

		expect(out.status).toBe(0);
		expect(out.stderr).toBe("");
	});

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const)("removes the clone and exits %s's code when interrupted after cloning", async (signal, code) => {
		const started = join(root, "pnpm-started");
		const release = join(root, "pnpm-release");
		// pnpm blocks until the test lets it go, so the signal arrives in the middle of the install.
		await fake("pnpm", `: > "${started}"\nwhile [ ! -e "${release}" ]; do ${which("sleep")} 0.05; done`);
		const child = spawn("sh", [script], { env: installEnv(), stdio: "ignore" });
		const exited = new Promise<number | null>((resolve) => child.once("exit", (status) => resolve(status)));

		await until(() => existsSync(started));
		child.kill(signal);
		await writeFile(release, "");

		expect(await exited).toBe(code);
		expect(existsSync(installDir)).toBe(false);
		expect(existsSync(join(binDir, "atelier"))).toBe(false);
	});

	it("refuses to touch an existing install", async () => {
		await mkdir(installDir, { recursive: true });
		await writeFile(join(installDir, "keep.txt"), "mine");

		const out = install();

		expect(out.status).not.toBe(0);
		expect(out.stderr).toBe(`error: Atelier is already installed in ${installDir}. Run: atelier update\n`);
		expect(await readFile(join(installDir, "keep.txt"), "utf8")).toBe("mine");
		expect(existsSync(join(binDir, "atelier"))).toBe(false);
		expect(existsSync(join(root, "pnpm.log"))).toBe(false);
	});

	it("fails and leaves nothing behind when there is no vX.Y.Z tag", () => {
		git(origin, "tag", "-d", "v0.9.0", "v0.10.0", "v0.2.0");

		const out = install();

		expect(out.status).not.toBe(0);
		expect(out.stderr).toBe("error: No vX.Y.Z release found in the repository.\n");
		expect(existsSync(installDir)).toBe(false);
		expect(existsSync(binDir)).toBe(false);
		expect(existsSync(join(root, "pnpm.log"))).toBe(false);
	});

	it("names git when it is missing, before writing anything", async () => {
		await rm(join(tools, "git"));

		const out = install();

		expect(out.status).not.toBe(0);
		expect(out.stderr).toBe("error: Atelier needs git; it was not found.\n");
		expectNothingWritten();
	});

	it("names pnpm when it is missing, before writing anything", async () => {
		await rm(join(fakes, "pnpm"));

		const out = install();

		expect(out.status).not.toBe(0);
		expect(out.stderr).toBe("error: Atelier needs pnpm; it was not found.\n");
		expectNothingWritten();
	});

	it("names Node when it is missing", async () => {
		await rm(join(fakes, "node"));

		const out = install();

		expect(out.status).not.toBe(0);
		expect(out.stderr).toBe("error: Atelier needs Node 22.19 or newer; it was not found.\n");
		expectNothingWritten();
	});

	it.each(["v20.1.0", "v22.18.9"])("rejects Node %s as too old", async (version) => {
		await fake("node", `echo "${version}"`);

		const out = install();

		expect(out.status).not.toBe(0);
		expect(out.stderr).toBe(`error: Atelier needs Node 22.19 or newer; found ${version}.\n`);
		expectNothingWritten();
	});

	it.each(["v22.19.0", "v22.20.1", "v24.0.0"])("accepts Node %s", async (version) => {
		await fake("node", `echo "${version}"`);

		expect(install().status).toBe(0);
	});

	it("rejects an unknown option as a usage error", () => {
		const out = install(["--bogus"]);

		expect(out.status).toBe(2);
		expect(out.stderr).toBe("error: Unknown option: --bogus\nUsage: install.sh [--desktop]\n");
		expectNothingWritten();
	});
});

function expectNothingWritten(): void {
	expect(existsSync(installDir)).toBe(false);
	expect(existsSync(binDir)).toBe(false);
	expect(existsSync(join(root, "pnpm.log"))).toBe(false);
}

// S2: the launcher treats the install path as data, not shell syntax.
it.each(['app"quoted', "app$(printf injected)"])("launches from %s literally", async (name) => {
	installDir = join(root, name);
	expect(install().status).toBe(0);
	await fake("node", 'printf "%s\\n" "$@"');
	const result = spawnSync(join(binDir, "atelier"), ["two words"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, PATH: `${fakes}:${tools}` },
	});
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toBe(`${installDir}/atelier-cli/src/main.ts\ntwo words\n`);
});

// S2/S4: the installer ignores prereleases and leading-zero tags, as `atelier update` does.
it("installs the newest strict release, ignoring prereleases and leading zeros", async () => {
	for (const tag of ["v1.0.0-rc1", "v01.2.3"]) {
		await writeFile(join(origin, "tag.txt"), tag);
		git(origin, "add", ".");
		git(origin, "commit", "--quiet", "-m", tag);
		git(origin, "tag", tag);
	}
	const out = install();
	expect(out.status).toBe(0);
	expect(out.stdout.trim().split("\n").at(-1)).toBe(`Installed atelier v0.10.0 in ${installDir}. Run: atelier`);
});
