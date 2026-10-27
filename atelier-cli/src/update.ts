import { join } from "node:path";
import { VERSION } from "@atelier/core";
import { buildDesktop, installFull } from "./desktop.ts";
import { CommandError, describeCommand, type Exec, execute, OWN_ROOT, readMarker } from "./install-marker.ts";
import { RELEASE_TAG } from "./subcommands.ts";

export interface UpdateOptions {
	/** The release to move to; the newest one when absent. */
	version?: string;
	/** The copy to update; the repository this CLI runs from when absent. */
	root?: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
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
		if (marker.desktop) {
			try {
				await buildDesktop(exec);
			} catch (error) {
				if (!(error instanceof CommandError)) throw error;
				return fail(
					`${describeCommand(error)}\natelier is updated to ${target} but the desktop is not rebuilt; retry with: pnpm -C ${join(root, "atelier-desktop")} build`,
				);
			}
		}
		options.stdout(`Updated atelier ${current} → ${target}\n`);
		return 0;
	} catch (error) {
		if (!(error instanceof CommandError)) throw error;
		return fail(describeCommand(error));
	}
}

/** Full install when the desktop is there, because its build needs the dev dependencies; the CLI alone needs only production ones. */
function installDependencies(exec: Exec, desktop: boolean): Promise<string> {
	return desktop ? installFull(exec) : exec("pnpm", ["install", "--frozen-lockfile", "--prod"]);
}

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
