import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SweepingChild {
	process: ChildProcess;
	stdout: string;
	stderr: string;
	/** The exit code once it ended; undefined while it runs. */
	exited: number | null | undefined;
}

/** The directories of a live owner the sweep finds: each asks `ps`, which answers only after its 5 s timeout. */
const SLOW_DIRECTORIES = 4;

/**
 * A process that makes a scratch directory in `root/tmp` and ends once its sweep is waiting on a `ps` that answers
 * only after its timeout: a sweep that held the process would keep it alive for 20 s. It runs from a file, not with
 * `-e`, since a worker takes the process's flags and rejects `--input-type`. `runtime` runs it with `env` added: Node,
 * or Electron as the desktop runs the core. It prints `sweeping` once the sweep asked `ps`, `no sweep` if it never did.
 */
export async function sweepingChild(
	root: string,
	runtime: string,
	env: Record<string, string> = {},
): Promise<SweepingChild> {
	const bin = join(root, "bin");
	const folder = join(root, "tmp");
	const asked = join(root, "ps-asked");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "ps"), `#!/bin/sh\ntouch '${asked}'\nsleep 30\n`);
	await chmod(join(bin, "ps"), 0o755);
	for (let n = 0; n < SLOW_DIRECTORIES; n++) {
		const dir = join(folder, `atelier-session-slow0${n}`);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, ".atelier-owner"),
			JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3_600_000 }),
		);
	}
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
	const { ATELIER_SCRATCH_SWEEP: _off, ...inherited } = process.env;
	const child = spawn(runtime, [script, source, folder, asked], {
		env: { ...inherited, ...env, PATH: `${bin}:${inherited.PATH ?? ""}` },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const result: SweepingChild = { process: child, stdout: "", stderr: "", exited: undefined };
	child.stdout?.on("data", (chunk) => {
		result.stdout += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		result.stderr += String(chunk);
	});
	child.once("exit", (code) => {
		result.exited = code;
	});
	return result;
}
