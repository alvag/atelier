import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@atelier/core";

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

export interface InstallMarker {
	desktop: boolean;
	/** `main` when the copy follows the main branch instead of the releases. */
	channel?: "main";
}

/** What install.sh wrote in `.git/atelier-install`; undefined when the file is not there. */
export async function readMarker(root: string): Promise<InstallMarker | undefined> {
	const text = await readFile(markerPath(root), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	const lines = text.split("\n");
	return {
		desktop: lines.includes("desktop=1"),
		...(lines.includes("channel=main") ? { channel: "main" as const } : {}),
	};
}

/** Records that the copy follows main, or (undefined) the releases again, keeping the other lines of the marker. */
export async function writeChannelMarker(root: string, channel: "main" | undefined): Promise<void> {
	const text = await readFile(markerPath(root), "utf8");
	const lines = text.split("\n").filter((line) => line !== "" && !line.startsWith("channel="));
	await writeFile(
		markerPath(root),
		`${[...lines, ...(channel === undefined ? [] : [`channel=${channel}`])].join("\n")}\n`,
	);
}

/** The commit HEAD points at, read from `.git/HEAD` without git; undefined unless HEAD is detached. */
export async function readHeadCommit(root: string): Promise<string | undefined> {
	const text = (await readFile(join(root, ".git", "HEAD"), "utf8").catch(() => "")).trim();
	return /^[0-9a-f]{40}$/.test(text) ? text : undefined;
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

/** The version `atelier --version` prints: with `(main <sha>)` in a copy that follows main. */
export async function versionLabel(root: string): Promise<string> {
	if ((await readMarker(root))?.channel !== "main") return VERSION;
	const commit = await readHeadCommit(root);
	return commit === undefined ? VERSION : `${VERSION} (main ${commit.slice(0, 7)})`;
}
