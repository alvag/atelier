import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the tests of the sandbox's socket make their folders: a Unix socket path
 * fits in 104 bytes, so the folder must be short. `ATELIER_TEST_SOCKET_ROOT`
 * picks it (a verifier keeps its runs in its own scratch folder that way);
 * otherwise the system's temporary folder when it is short (`/tmp/claude` inside
 * a sandbox), and `/tmp` when it is not.
 */
export function shortBase(): string {
	const chosen = process.env.ATELIER_TEST_SOCKET_ROOT;
	if (chosen !== undefined && chosen !== "") return chosen;
	return tmpdir().length <= 20 ? tmpdir() : "/tmp";
}

const made = new Set<string>();

/** A new folder under `shortBase()`, removed by `removeShortRoots`. */
export async function shortRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(shortBase(), prefix));
	made.add(root);
	return root;
}

/** Removes every folder `shortRoot` made, and returns those still there: none, when all went well. */
export async function removeShortRoots(): Promise<string[]> {
	const roots = [...made];
	made.clear();
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	const left: string[] = [];
	for (const root of roots)
		if (
			await stat(root).then(
				() => true,
				() => false,
			)
		)
			left.push(root);
	return left;
}
