import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository this CLI runs from: src/ sits two levels below it. */
export const OWN_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A command that failed, named as the user would type it. */
export class CommandError extends Error {
	override name = "CommandError";
	readonly command: string;
	readonly status: number | string | undefined;
	readonly detail: string;
	constructor(command: string, status: number | string | undefined, detail: string) {
		super(`${command} failed`);
		this.command = command;
		this.status = status;
		this.detail = detail;
	}
}

export type Exec = (file: string, args: string[]) => Promise<string>;

export const describeCommand = (error: CommandError) =>
	`${error.command} failed${error.status === undefined ? "" : ` (exit ${error.status})`}: ${error.detail}`;

const markerPath = (root: string) => join(root, ".git", "atelier-install");

/** What install.sh wrote in `.git/atelier-install`; undefined when the file is not there. */
export async function readMarker(root: string): Promise<{ desktop: boolean } | undefined> {
	const text = await readFile(markerPath(root), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	return { desktop: text.split("\n").includes("desktop=1") };
}

/** Records whether the desktop is installed, keeping the other lines of the marker. */
export async function writeDesktopMarker(root: string, desktop: boolean): Promise<void> {
	const text = await readFile(markerPath(root), "utf8");
	const lines = text.split("\n").filter((line) => line !== "" && !line.startsWith("desktop="));
	await writeFile(markerPath(root), `${[...lines, `desktop=${desktop ? 1 : 0}`].join("\n")}\n`);
}

export function execute(
	file: string,
	args: string[],
	cwd: string,
	env: Record<string, string | undefined>,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error === null) return resolve(stdout.trim());
			const status = typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined;
			const detail = (stderr || stdout || error.message).trim().split("\n")[0] ?? error.message;
			reject(new CommandError(`${file} ${args.join(" ")}`, status, detail));
		});
	});
}
