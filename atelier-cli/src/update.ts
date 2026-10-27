import { VERSION } from "@atelier/core";
import { buildDesktop, installFull } from "./desktop.ts";
import {
	CommandError,
	describeCommand,
	type Exec,
	execute,
	OWN_ROOT,
	readMarker,
	writeChannelMarker,
} from "./install-marker.ts";
import { RELEASE_TAG } from "./subcommands.ts";

export interface UpdateOptions {
	/** The release to move to; the newest one when absent. */
	version?: string;
	/** Move to the latest main instead of a release. */
	main?: boolean;
	/** The copy to update; the repository this CLI runs from when absent. */
	root?: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

/** Moves the installed copy to a release (or to main) and reinstalls its dependencies; returns the exit code. */
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
		const wanted = options.main ? await resolveMain(exec) : await resolveRelease(exec, options.version);
		if (typeof wanted === "string") return fail(wanted);
		const { ref, label, channel } = wanted;

		// Compared by commit: a local commit on top of a release is not that release, whatever version it says.
		const previous = await exec("git", ["rev-parse", "HEAD"]);
		if (previous === wanted.commit) {
			await writeChannelMarker(root, channel);
			options.stdout(`atelier is already at ${label}\n`);
			return 0;
		}
		const current = await currentVersion(exec, previous, marker.channel);

		await exec("git", ["checkout", "--quiet", "--detach", ref]);
		try {
			await installDependencies(exec, marker.desktop);
		} catch (error) {
			if (!(error instanceof CommandError)) throw error;
			// Back to where it was, so that asking for the same release again does the work again.
			await exec("git", ["checkout", "--quiet", "--detach", previous]);
			const retry = `${describeCommand(error)}\natelier stays at ${current}; retry with: ${wanted.retry}`;
			// The failed install may have left node_modules half way between both versions.
			const repair = await reinstallDependencies(exec, marker.desktop, root, current);
			return fail(repair === undefined ? retry : `${retry}\n${repair}`);
		}
		await writeChannelMarker(root, channel);
		if (marker.desktop) {
			try {
				await buildDesktop(exec, root);
			} catch (error) {
				if (!(error instanceof CommandError)) throw error;
				return fail(
					`${describeCommand(error)}\natelier is updated to ${label} but the desktop is not built; retry with: atelier desktop (it builds when the output is missing)`,
				);
			}
		}
		options.stdout(`Updated atelier ${current} → ${label}\n`);
		return 0;
	} catch (error) {
		if (!(error instanceof CommandError)) throw error;
		return fail(describeCommand(error));
	}
}

interface Wanted {
	/** What git checks out. */
	ref: string;
	commit: string;
	/** How messages name it. */
	label: string;
	channel: "main" | undefined;
	/** The command that asks for it again. */
	retry: string;
}

/** The release asked for, or the newest; a message when there is none. */
async function resolveRelease(exec: Exec, version: string | undefined): Promise<Wanted | string> {
	const releases = sortReleases((await exec("git", ["tag", "--list"])).split("\n"));
	const target = version ?? releases.at(-1);
	if (target === undefined) return "No vX.Y.Z release found in the repository.";
	if (!releases.includes(target)) return `No release ${target}; available: ${releases.join(", ")}`;
	return {
		ref: target,
		commit: await exec("git", ["rev-parse", `${target}^{commit}`]),
		label: target,
		channel: undefined,
		retry: `atelier update ${target}`,
	};
}

/** The latest commit of origin's main. */
async function resolveMain(exec: Exec): Promise<Wanted> {
	await exec("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
	const commit = await exec("git", ["rev-parse", "refs/remotes/origin/main^{commit}"]);
	return {
		ref: commit,
		commit,
		label: mainLabel(await shortCommit(exec, commit)),
		channel: "main",
		retry: "atelier update --main",
	};
}

const mainLabel = (short: string) => `main (${short})`;
const shortCommit = (exec: Exec, commit: string) => exec("git", ["rev-parse", "--short=7", commit]);

/** Full install when the desktop is there, because its build needs the dev dependencies; the CLI alone needs only production ones. */
function installDependencies(exec: Exec, desktop: boolean): Promise<string> {
	return desktop ? installFull(exec) : exec("pnpm", ["install", "--frozen-lockfile", "--prod"]);
}

/** Installs the dependencies again; undefined when it worked, else what failed and the command to repair it by hand. */
async function reinstallDependencies(
	exec: Exec,
	desktop: boolean,
	root: string,
	current: string,
): Promise<string | undefined> {
	try {
		await installDependencies(exec, desktop);
		return undefined;
	} catch (error) {
		if (!(error instanceof CommandError)) throw error;
		return `Reinstalling the dependencies of ${current} failed too: ${describeCommand(error)}\nRepair them with: cd ${shellQuote(root)} && ${error.command}`;
	}
}

/** Single-quoted for a POSIX shell; a ' inside becomes '\''. */
function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The `vX.Y.Z` tag at HEAD, else main's label in a copy that follows main, else the core's version and HEAD's short id. */
async function currentVersion(exec: Exec, head: string, channel: "main" | undefined): Promise<string> {
	const tag = await exec("git", ["describe", "--tags", "--exact-match"]).catch(() => "");
	if (RELEASE_TAG.test(tag)) return tag;
	const short = await shortCommit(exec, head);
	return channel === "main" ? mainLabel(short) : `v${VERSION} (local ${short})`;
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
