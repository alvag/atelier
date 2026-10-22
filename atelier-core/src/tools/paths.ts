import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathOutsideError extends Error {
	override name = "PathOutsideError";
	constructor(path: string) {
		super(`Path is outside the working directory: ${path}`);
	}
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Real path of `path`, following symlinks through its nearest existing ancestor. */
async function realpathAllowMissing(path: string): Promise<string> {
	const missing: string[] = [];
	let current = path;
	while (true) {
		try {
			return join(await realpath(current), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			missing.unshift(basename(current));
			current = parent;
		}
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
