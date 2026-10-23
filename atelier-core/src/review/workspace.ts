import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeError } from "../events.ts";
import { gitEnv, gitText } from "./git.ts";

/** Directories visited while looking for node_modules; a bigger tree is searched no further and the verifier is told. */
const SEARCH_LIMIT = 3000;
const SEARCH_DEPTH = 4;

/** What the verifier's tools see: a throwaway directory with the project before and after the turn. */
export interface Workspace {
	/** The verifier's working directory; holds `candidate/` and `base/`. */
	dir: string;
	/** How the installed dependencies were made available, or what is missing; goes into the verifier's prompt. */
	dependencies: string;
	/** The feature document's copy, relative to `dir`. */
	feature?: string;
	/** Deletes the whole directory; safe to call twice. */
	remove(): Promise<void>;
}

export interface WorkspaceInput {
	/** The repository's worktree root: its objects hold both trees, and its node_modules are linked. */
	root: string;
	base: string;
	tree: string;
	/** The active feature document, copied in. */
	feature?: string;
}

/**
 * Writes the base tree and the candidate tree from git's objects into a new
 * temporary directory, never touching the user's worktree, index or refs, and
 * links the project's installed dependencies into both copies.
 */
export async function createWorkspace(input: WorkspaceInput): Promise<Workspace> {
	const dir = await mkdtemp(join(tmpdir(), "atelier-verify-"));
	const remove = () => rm(dir, { recursive: true, force: true });
	try {
		await Promise.all([
			materializeTree(input.root, input.tree, join(dir, "candidate")),
			materializeTree(input.root, input.base, join(dir, "base")),
		]);
		const dependencies = await linkDependencies(input.root, [join(dir, "candidate"), join(dir, "base")]);
		const feature = input.feature === undefined ? undefined : await copyFeature(input.feature, dir);
		return { dir, dependencies, ...(feature === undefined ? {} : { feature }), remove };
	} catch (error) {
		await remove();
		throw error;
	}
}

async function copyFeature(path: string, dir: string): Promise<string | undefined> {
	const name = join("feature", basename(path));
	try {
		await mkdir(join(dir, "feature"));
		await copyFile(path, join(dir, name));
		return name;
	} catch {
		return undefined;
	}
}

interface TreeEntry {
	mode: string;
	type: string;
	sha: string;
	path: string;
}

/** `<mode> <type> <sha>\t<path>\0`, repeated. */
async function listTree(root: string, tree: string): Promise<TreeEntry[]> {
	const text = await gitText(["ls-tree", "-r", "-z", "--full-tree", tree], { cwd: root });
	const entries: TreeEntry[] = [];
	for (const record of text.split("\0")) {
		const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(record);
		if (match)
			entries.push({
				mode: match[1] as string,
				type: match[2] as string,
				sha: match[3] as string,
				path: match[4] as string,
			});
	}
	return entries;
}

/**
 * Writes a tree's files from the git objects, so no attribute, filter or hook of
 * the repository runs and the bytes are the ones frozen. Symlinks stay
 * symlinks; submodules become empty directories.
 */
async function materializeTree(root: string, tree: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	const entries = (await listTree(root, tree)).filter((entry) => !entry.path.split("/").includes(".git"));
	const inside = (path: string) => {
		const target = resolve(dest, path);
		return target.startsWith(dest + sep) ? target : undefined;
	};
	for (const entry of entries.filter((e) => e.type === "commit")) {
		const target = inside(entry.path);
		if (target) await mkdir(target, { recursive: true });
	}
	const blobs = entries.filter((entry) => entry.type === "blob");
	if (blobs.length === 0) return;
	const child = spawn("git", ["cat-file", "--batch"], {
		cwd: root,
		env: gitEnv(undefined),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < 4096) stderr += chunk.toString("utf8");
	});
	const exited = new Promise<number>((done, fail) => {
		child.on("error", fail);
		child.on("close", (code) => done(code ?? 1));
	});
	child.stdin.on("error", () => {});
	child.stdin.end(`${blobs.map((entry) => entry.sha).join("\n")}\n`);

	let pending: Buffer = Buffer.alloc(0);
	let index = 0;
	let want: { size: number; header: number } | undefined;
	try {
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			while (index < blobs.length) {
				if (want === undefined) {
					const end = pending.indexOf(0x0a);
					if (end === -1) break;
					const header = pending.subarray(0, end).toString("utf8").split(" ");
					const size = Number(header[2]);
					if (header[1] !== "blob" || !Number.isInteger(size))
						throw new Error(`git cat-file answered "${header.join(" ")}"`);
					want = { size, header: end + 1 };
				}
				if (pending.length < want.header + want.size + 1) break;
				const content = pending.subarray(want.header, want.header + want.size);
				await writeEntry(blobs[index] as TreeEntry, content, inside);
				pending = pending.subarray(want.header + want.size + 1);
				want = undefined;
				index++;
			}
		}
	} catch (error) {
		child.kill();
		throw error;
	}
	const code = await exited;
	if (code !== 0 || index !== blobs.length)
		throw new Error(`Could not read the files of the tree: ${stderr.trim() || `git cat-file exited with ${code}`}`);
}

async function writeEntry(
	entry: TreeEntry,
	content: Buffer,
	inside: (path: string) => string | undefined,
): Promise<void> {
	const target = inside(entry.path);
	if (target === undefined) return;
	await mkdir(dirname(target), { recursive: true });
	if (entry.mode === "120000") await symlink(content.toString("utf8"), target);
	else {
		await writeFile(target, content);
		await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
	}
}

/**
 * Links every node_modules of the worktree (the root's and each workspace
 * package's) into the copies, entry by entry: a link that points at another
 * workspace package is pointed at that package's copy, so the verifier runs the
 * candidate's code and not the user's. Nothing is installed or downloaded.
 * Returns the sentence for the verifier's prompt.
 */
async function linkDependencies(root: string, copies: string[]): Promise<string> {
	const top = await realpath(root);
	const found: string[] = [];
	let visited = 0;
	let capped = false;
	const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		const names = await readdir(join(top, next.rel), { withFileTypes: true }).catch(() => []);
		if (++visited > SEARCH_LIMIT) {
			capped = true;
			break;
		}
		for (const entry of names) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules") found.push(next.rel);
			else if (entry.name !== ".git" && next.depth < SEARCH_DEPTH)
				queue.push({ rel: join(next.rel, entry.name), depth: next.depth + 1 });
		}
	}
	const linked = new Set<string>();
	const problems: string[] = [];
	for (const rel of found) {
		for (const copy of copies) {
			if (
				!(await lstat(join(copy, rel)).then(
					(s) => s.isDirectory(),
					() => false,
				))
			)
				continue;
			try {
				await linkEntries(join(top, rel, "node_modules"), join(copy, rel, "node_modules"), top, copy);
				linked.add(rel === "" ? "node_modules" : `${rel}/node_modules`);
			} catch (error) {
				problems.push(`${rel === "" ? "." : rel}: ${describeError(error)}`);
			}
		}
	}
	const parts: string[] = [];
	if (linked.size > 0)
		parts.push(
			`the project's installed dependencies are linked into both copies (${[...linked].sort().join(", ")}); installing is not possible, use what is there.`,
		);
	else
		parts.push(
			"no node_modules directory was found in the project, so nothing is installed in the copies: anything that needs installed dependencies cannot run here; mark those requirements unverified and say so.",
		);
	if (capped) parts.push(`The search stopped after ${SEARCH_LIMIT} directories, so some node_modules may be missing.`);
	if (problems.length > 0) parts.push(`Not linked: ${problems.join("; ")}.`);
	return parts.join(" ");
}

const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function linkEntries(source: string, dest: string, top: string, copy: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		const to = join(dest, entry.name);
		if (entry.isSymbolicLink()) {
			const real = await realpath(from).catch(() => undefined);
			if (real === undefined) continue;
			// A workspace package lives in the project, outside any node_modules: use the copy's version of it.
			const workspace = inside(top, real) && !relative(top, real).split(sep).includes("node_modules");
			await symlink(workspace ? join(copy, relative(top, real)) : real, to);
		} else if (entry.isDirectory() && entry.name.startsWith("@")) await linkEntries(from, to, top, copy);
		else await symlink(from, to);
	}
}
