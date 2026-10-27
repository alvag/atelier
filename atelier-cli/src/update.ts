import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@atelier/core";
import { RELEASE_TAG } from "./subcommands.ts";

/** The repository this file belongs to: atelier-cli/src/update.ts sits two levels below it. */
const OWN_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface UpdateOptions {
	/** The release to move to; the newest one when absent. */
	version?: string;
	/** The copy to update; the repository this CLI runs from when absent. */
	root?: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

/** A command that failed, named as the user would type it. */
class CommandError extends Error {
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

/** Moves the installed copy to a release and reinstalls its dependencies; returns the exit code. */
export async function runUpdate(options: UpdateOptions): Promise<number> {
	const root = options.root ?? OWN_ROOT;
	const exec = (file: string, args: string[]) => execute(file, args, root, options.env);
	const fail = (message: string) => {
		options.stderr(`error: ${message}\n`);
		return 1;
	};
	try {
		const marker = await readMarker(root);
		if (marker === undefined)
			return fail(
				`atelier update only updates a copy installed with install.sh; ${root} is a development clone (use git there).`,
			);
		if ((await exec("git", ["status", "--porcelain"])) !== "")
			return fail(`${root} has local changes; commit or discard them before updating (git status shows them).`);

		await exec("git", ["fetch", "--tags", "--quiet"]);
		const releases = sortReleases((await exec("git", ["tag", "--list"])).split("\n"));
		const target = options.version ?? releases.at(-1);
		if (target === undefined) return fail("No vX.Y.Z release found in the repository.");
		if (!releases.includes(target)) return fail(`No release ${target}; available: ${releases.join(", ")}`);

		const current = await currentVersion(exec);
		if (current === target) {
			options.stdout(`atelier is already at ${target}\n`);
			return 0;
		}

		const previous = await exec("git", ["rev-parse", "HEAD"]);
		await exec("git", ["checkout", "--quiet", "--detach", target]);
		try {
			await installDependencies(exec, marker.desktop);
		} catch (error) {
			if (!(error instanceof CommandError)) throw error;
			// Back to where it was, so that asking for the same release again does the work again.
			await exec("git", ["checkout", "--quiet", "--detach", previous]);
			return fail(`${describeCommand(error)}\natelier stays at ${current}; retry with: atelier update ${target}`);
		}
		if (marker.desktop) await rebuildDesktop(root);
		options.stdout(`Updated atelier ${current} → ${target}\n`);
		return 0;
	} catch (error) {
		if (!(error instanceof CommandError)) throw error;
		return fail(describeCommand(error));
	}
}

type Exec = (file: string, args: string[]) => Promise<string>;

const describeCommand = (error: CommandError) =>
	`${error.command} failed${error.status === undefined ? "" : ` (exit ${error.status})`}: ${error.detail}`;

/** Full install when the desktop is there, because its build needs the dev dependencies; the CLI alone needs only production ones. */
function installDependencies(exec: Exec, desktop: boolean): Promise<string> {
	return exec("pnpm", desktop ? ["install", "--frozen-lockfile"] : ["install", "--frozen-lockfile", "--prod"]);
}

/** Hook for `atelier desktop`: rebuilds the desktop app after an update when it is installed. */
async function rebuildDesktop(_root: string): Promise<void> {}

/** The `vX.Y.Z` tag at HEAD, or the version the core was built with when HEAD has none. */
async function currentVersion(exec: Exec): Promise<string> {
	const tag = await exec("git", ["describe", "--tags", "--exact-match"]).catch(() => "");
	return RELEASE_TAG.test(tag) ? tag : `v${VERSION}`;
}

/** The release tags (strictly vX.Y.Z), oldest first by numeric order. */
function sortReleases(tags: readonly string[]): string[] {
	const numbers = (tag: string) => tag.slice(1).split(".").map(Number);
	return tags
		.filter((tag) => RELEASE_TAG.test(tag))
		.sort((a, b) => {
			const [x, y] = [numbers(a), numbers(b)];
			return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
		});
}

/** What install.sh wrote in `.git/atelier-install`; undefined when the file is not there. */
async function readMarker(root: string): Promise<{ desktop: boolean } | undefined> {
	const text = await readFile(join(root, ".git", "atelier-install"), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	return { desktop: text.split("\n").includes("desktop=1") };
}

function execute(file: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error === null) return resolve(stdout.trim());
			const status = typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined;
			const detail = (stderr || stdout || error.message).trim().split("\n")[0] ?? error.message;
			reject(new CommandError(`${file} ${args.join(" ")}`, status, detail));
		});
	});
}
