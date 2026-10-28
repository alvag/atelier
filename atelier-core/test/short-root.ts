import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the tests of the sandbox's socket may make their folders, in order: a
 * Unix socket path fits in 104 bytes, so the folder must be short, whatever
 * TMPDIR the run has. `ATELIER_TEST_SOCKET_ROOT` picks it (a verifier keeps its
 * runs in its own scratch folder that way); otherwise the system's temporary
 * folder when it is short, then `/tmp`, then `/tmp/claude`, the folder the
 * sandbox library gives its commands (the only short one writable inside
 * Atelier's own sandbox).
 */
function shortBases(): string[] {
	const chosen = process.env.ATELIER_TEST_SOCKET_ROOT;
	if (chosen !== undefined && chosen !== "") return [chosen];
	return [...(tmpdir().length <= 20 ? [tmpdir()] : []), "/tmp", "/tmp/claude"];
}

const made = new Set<string>();

/** A new folder in the first short base that takes one, removed by `removeShortRoots`. */
export async function shortRoot(prefix: string): Promise<string> {
	let failure: unknown;
	for (const base of shortBases()) {
		try {
			const root = await mkdtemp(join(base, prefix));
			made.add(root);
			return root;
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
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
