import { readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSandboxAdditions, protectedWritePaths } from "./sandbox-config.ts";
import { secretDirectories } from "./sandbox-paths.ts";

export class PathOutsideError extends Error {
	override name = "PathOutsideError";
	constructor(path: string) {
		super(`Path is outside the working directory: ${path}`);
	}
}

export class PathProtectedError extends Error {
	override name = "PathProtectedError";
	constructor(path: string) {
		super(`Path is a protected secret location: ${path}`);
	}
}

export function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const MAX_LINKS = 40;

/**
 * Real path of `path`, following symlinks through its nearest existing
 * ancestor. A symlink whose target does not exist is followed too, to where
 * the target would be, so a write through it lands on that path and not on
 * the link.
 */
export async function realpathAllowMissing(path: string, links = 0): Promise<string> {
	const missing: string[] = [];
	let current = path;
	while (true) {
		try {
			return join(await realpath(current), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const target = await readlink(current).catch(() => undefined);
			if (target !== undefined) {
				if (links >= MAX_LINKS) throw Object.assign(new Error(`Too many symbolic links: ${path}`), { code: "ELOOP" });
				return join(await realpathAllowMissing(resolve(dirname(current), target), links + 1), ...missing);
			}
			const parent = dirname(current);
			if (parent === current) throw error;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

/** Like resolveInside, but also accepts paths inside the session scratch directory. */
export async function resolveReadable(cwd: string, path: string, scratchDir: string | undefined): Promise<string> {
	try {
		return await resolveInside(cwd, path);
	} catch (error) {
		if (!(error instanceof PathOutsideError) || scratchDir === undefined || !isAbsolute(path)) throw error;
		return await resolveInside(scratchDir, path).catch(() => {
			throw error;
		});
	}
}

/**
 * Resolves `path` against `cwd` and rejects it when it leaves `cwd`, either
 * lexically or through a symlink. Returns the real path, so callers do not
 * follow the same links again.
 *
 * This guards against model mistakes, not against a concurrent local process:
 * a symlink swapped between this check and the file access can still escape
 * (Node has no openat-style API to close that window).
 */
export async function resolveInside(cwd: string, path: string): Promise<string> {
	const absolute = resolve(cwd, path);
	if (!isInside(cwd, absolute)) throw new PathOutsideError(path);
	const [root, real] = await Promise.all([realpath(cwd), realpathAllowMissing(absolute)]);
	if (!isInside(root, real)) throw new PathOutsideError(path);
	return real;
}

/**
 * The places `read` and `grep` never open when they may leave the working
 * directory: the same secret directories the sandbox hides from `bash`, plus
 * the `denyRead` entries of the configuration. Real paths, read at each call
 * like the sandbox does. Throws `SandboxConfigError` for an invalid file.
 */
export async function protectedReadPaths(cwd: string, home: string = homedir()): Promise<string[]> {
	const entries = [...secretDirectories(home), ...loadSandboxAdditions({ cwd, home }).denyRead];
	return Promise.all(entries.map((entry) => realpathAllowMissing(entry)));
}

/** Whether `path` (absolute) is one of `protectedPaths` or inside one. */
export function isProtected(path: string, protectedPaths: readonly string[]): boolean {
	return protectedPaths.some((protectedPath) => isInside(protectedPath, path));
}

/**
 * Resolves `path` against `cwd` with no confinement and returns its real path,
 * unless it, or the file a symlink in it leads to, is a protected location.
 */
export async function resolveOutside(cwd: string, path: string, protectedPaths: readonly string[]): Promise<string> {
	const absolute = resolve(cwd, path);
	const real = await realpathAllowMissing(absolute);
	if (isProtected(absolute, protectedPaths) || isProtected(real, protectedPaths)) throw new PathProtectedError(path);
	return real;
}

/** Whether the file is named like the secret files the sandbox never lets `bash` write (`.env`, `.env.*`, `*.pem`, `*.key`). */
export function isSecretFile(path: string): boolean {
	const name = basename(path);
	return name === ".env" || name.startsWith(".env.") || name.endsWith(".pem") || name.endsWith(".key");
}

/** The places `edit` never writes, approved or not: the home's secret directories and the user's `.atelier`. Real paths. */
export function protectedWriteDirectories(home: string = homedir()): string[] {
	return protectedWritePaths(home).inside;
}
