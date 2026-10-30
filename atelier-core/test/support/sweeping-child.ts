import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The sweep asks `ps` only off Windows, and the fake one is a shell script. */
export const canFakePs = process.platform !== "win32" && existsSync("/bin/sh");

/** The directories of a live owner the sweep finds: each asks `ps`, which answers only after its 5 s timeout. */
const SLOW_DIRECTORIES = 4;
/** The fake `ps` outlives the sweep's timeout by a second: `exec` makes it the process the timeout kills. */
const FAKE_PS = '#!/bin/sh\n: > "$ATELIER_TEST_PS_ASKED"\nexec sleep 6\n';

/**
 * A temporary folder, `root/tmp`, whose sweep takes 20 s: directories of a live owner, and a `ps` on the PATH that
 * answers only after its timeout and creates `asked` when the sweep runs it. `env` carries both to a child process.
 */
export async function slowSweep(root: string): Promise<{ folder: string; asked: string; env: Record<string, string> }> {
	const bin = join(root, "bin");
	const folder = join(root, "tmp");
	const asked = join(root, "ps-asked");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "ps"), FAKE_PS);
	await chmod(join(bin, "ps"), 0o755);
	for (let n = 0; n < SLOW_DIRECTORIES; n++) {
		const dir = join(folder, `atelier-session-slow0${n}`);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, ".atelier-owner"),
			JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3_600_000 }),
		);
	}
	return { folder, asked, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ATELIER_TEST_PS_ASKED: asked } };
}

export interface TrackedChild {
	stdout: string;
	stderr: string;
	/** The exit code once it ended; undefined while it runs. */
	exited: number | null | undefined;
	/** Kills it and whatever it left running, such as a fake `ps`: they share its process group. */
	stop(): void;
}

/** Runs `args` with `runtime` in a process group of its own, with the sweep on and `env` added. */
export function spawnTracked(runtime: string, args: string[], env: Record<string, string>): TrackedChild {
	const { ATELIER_SCRATCH_SWEEP: _off, ...inherited } = process.env;
	const child = spawn(runtime, args, {
		env: { ...inherited, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const tracked: TrackedChild = {
		stdout: "",
		stderr: "",
		exited: undefined,
		stop: () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group is gone already.
			}
		},
	};
	child.stdout?.on("data", (chunk) => {
		tracked.stdout += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		tracked.stderr += String(chunk);
	});
	child.once("exit", (code) => {
		tracked.exited = code;
	});
	return tracked;
}

/**
 * A process that makes a scratch directory in a `slowSweep` folder and ends once its sweep is waiting on `ps`: a sweep
 * that held the process would keep it alive for 20 s. It runs from a file, not with `-e`, since a worker takes the
 * process's flags and rejects `--input-type`. `runtime` runs it with `env` added: Node, or Electron as the desktop runs
 * the core. It prints `sweeping` once the sweep asked `ps`, `no sweep` if it never did.
 */
export async function sweepingChild(
	root: string,
	runtime: string,
	env: Record<string, string> = {},
): Promise<TrackedChild> {
	const sweep = await slowSweep(root);
	const script = join(root, "child.mjs");
	await writeFile(
		script,
		[
			'import { existsSync } from "node:fs";',
			"const [source, folder, asked] = process.argv.slice(2);",
			"const { createScratchDir } = await import(source);",
			'await createScratchDir("session", { tmpRoot: folder });',
			"const deadline = Date.now() + 8000;",
			"while (!existsSync(asked) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));",
			'console.log(existsSync(asked) ? "sweeping" : "no sweep");',
		].join("\n"),
	);
	const source = new URL("../../src/scratch.ts", import.meta.url).href;
	return spawnTracked(runtime, [script, source, sweep.folder, sweep.asked], { ...sweep.env, ...env });
}
