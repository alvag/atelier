import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { VERSION } from "@atelier/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/run.ts";

let root: string;
let app: string;
let fakes: string;
let pnpmLog: string;
let opened: { binary: string; args: string[] }[];

/**
 * A pnpm that records where it ran and with what, and does what the real one would leave behind:
 * the electron binary after an install, the build output after a build. It fails when `fail-on`
 * holds a word of its arguments.
 */
async function fakePnpm(): Promise<void> {
	const file = join(fakes, "pnpm");
	await writeFile(
		file,
		`#!/bin/sh
echo "$PWD: $*" >> "${pnpmLog}"
if [ -e "${join(root, "fail-on")}" ] && case " $* " in *" $(cat "${join(root, "fail-on")}") "*) true ;; *) false ;; esac; then echo "boom" >&2; exit 7; fi
case "$1" in
	install) mkdir -p atelier-desktop/node_modules/.bin && echo '#!/bin/sh' > atelier-desktop/node_modules/.bin/electron ;;
	-C) mkdir -p "$2/out/main" && echo '// built' > "$2/out/main/index.js" ;;
esac
`,
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
		env: { PATH: `${fakes}:${process.env.PATH ?? ""}`, HOME: root },
		appRoot: app,
		openDesktop: (binary: string, args: string[]) => {
			opened.push({ binary, args });
		},
	};
	return {
		code: () => run(argv, io, () => Promise.reject(new Error("no backend"))),
		out: () => stdout,
		err: () => stderr,
	};
}

const marker = () => readFile(join(app, ".git", "atelier-install"), "utf8");
const electron = () => join(app, "atelier-desktop", "node_modules", ".bin", "electron");
const desktopDir = () => join(app, "atelier-desktop");

async function addElectron(): Promise<void> {
	await mkdir(join(app, "atelier-desktop", "node_modules", ".bin"), { recursive: true });
	await writeFile(electron(), "#!/bin/sh\n");
}

async function addBuild(): Promise<void> {
	await mkdir(join(app, "atelier-desktop", "out", "main"), { recursive: true });
	await writeFile(join(app, "atelier-desktop", "out", "main", "index.js"), "// built\n");
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "atelier-desktop-")));
	app = join(root, "app");
	fakes = join(root, "fakes");
	pnpmLog = join(root, "pnpm.log");
	opened = [];
	await mkdir(join(app, ".git"), { recursive: true });
	await mkdir(join(app, "atelier-desktop"));
	await mkdir(fakes);
	await fakePnpm();
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("atelier desktop in an installed copy", () => {
	it("installs, builds, marks and opens the desktop the first time", async () => {
		await writeFile(join(app, ".git", "atelier-install"), "other=keep\ndesktop=0\n");

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe(
			`Installing the desktop (Electron, about 200 MB), once...\nOpened Atelier desktop ${VERSION}\n`,
		);
		expect(c.err()).toBe("");
		expect(await pnpmCalls()).toEqual([`${app}: install --frozen-lockfile`, `${app}: -C atelier-desktop build`]);
		expect(await marker()).toBe("other=keep\ndesktop=1\n");
		expect(opened).toEqual([{ binary: electron(), args: [desktopDir()] }]);
	});

	it("only opens it when it is installed and built", async () => {
		await writeFile(join(app, ".git", "atelier-install"), "desktop=1\n");
		await addElectron();
		await addBuild();

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe(`Opened Atelier desktop ${VERSION}\n`);
		expect(await pnpmCalls()).toEqual([]);
		expect(opened).toEqual([{ binary: electron(), args: [desktopDir()] }]);
	});

	it("builds first when the build output is missing", async () => {
		await writeFile(join(app, ".git", "atelier-install"), "desktop=1\n");
		await addElectron();

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(0);

		expect(c.out()).toBe(`Opened Atelier desktop ${VERSION}\n`);
		expect(await pnpmCalls()).toEqual([`${app}: -C atelier-desktop build`]);
		expect(opened).toHaveLength(1);
	});

	it("names the install that failed, leaves the marker alone and opens nothing", async () => {
		await writeFile(join(app, ".git", "atelier-install"), "desktop=0\n");
		await writeFile(join(root, "fail-on"), "install");

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe("error: pnpm install --frozen-lockfile failed (exit 7): boom\n");
		expect(await marker()).toBe("desktop=0\n");
		expect(opened).toEqual([]);
	});

	it("names the build that failed, leaves the marker alone and opens nothing", async () => {
		await writeFile(join(app, ".git", "atelier-install"), "desktop=0\n");
		await writeFile(join(root, "fail-on"), "build");

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe("error: pnpm -C atelier-desktop build failed (exit 7): boom\n");
		expect(await marker()).toBe("desktop=0\n");
		expect(opened).toEqual([]);
	});
});

describe("atelier desktop in a development clone", () => {
	it("tells to run pnpm install when electron is missing, and installs nothing", async () => {
		const c = cli(["desktop"]);
		expect(await c.code()).toBe(1);

		expect(c.err()).toBe("error: Electron is not installed in a development clone; run: pnpm install\n");
		expect(await pnpmCalls()).toEqual([]);
		expect(opened).toEqual([]);
	});

	it("builds with the dependencies it has when the output is missing, then opens", async () => {
		await addElectron();

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(0);

		expect(await pnpmCalls()).toEqual([`${app}: -C atelier-desktop build`]);
		expect(opened).toEqual([{ binary: electron(), args: [desktopDir()] }]);
		await expect(readFile(join(app, ".git", "atelier-install"), "utf8")).rejects.toThrow();
	});

	it("opens a built desktop without running pnpm", async () => {
		await addElectron();
		await addBuild();

		const c = cli(["desktop"]);
		expect(await c.code()).toBe(0);

		expect(await pnpmCalls()).toEqual([]);
		expect(opened).toHaveLength(1);
	});
});

describe("atelier desktop usage", () => {
	it("rejects extra words and hints to quote a prompt", async () => {
		const c = cli(["desktop", "now"]);
		expect(await c.code()).toBe(2);

		expect(c.err()).toBe(
			'error: Usage: atelier desktop. To give a prompt that starts with "desktop", quote it: atelier "desktop now"\nRun atelier --help for usage.\n',
		);
		expect(await pnpmCalls()).toEqual([]);
		expect(opened).toEqual([]);
	});

	it("rejects session options", async () => {
		const c = cli(["desktop", "--model", "sonnet"]);
		expect(await c.code()).toBe(2);

		expect(c.err()).toBe("error: atelier desktop takes no session options (--model).\nRun atelier --help for usage.\n");
		expect(opened).toEqual([]);
	});
});
