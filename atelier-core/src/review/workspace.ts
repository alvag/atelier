import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeError } from "../events.ts";
import { createScratchDir } from "../scratch.ts";
import { gitEnv, gitText } from "./git.ts";

/** Directories visited while looking for node_modules; a bigger tree is searched no further and the verifier is told. */
const SEARCH_LIMIT = 3000;
const SEARCH_DEPTH = 4;
/** More installed dependencies than this are not copied: the verifier gets none and is told. */
export const DEPENDENCY_LIMIT_BYTES = 4 * 1024 ** 3;
/** Time for copying all the dependencies of both copies. */
export const DEPENDENCY_LIMIT_MS = 120_000;

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
	/** The repository's worktree root: its objects hold both trees, and its node_modules are copied. */
	root: string;
	base: string;
	tree: string;
	/** The active feature document, copied in. */
	feature?: string;
}

/**
 * Writes the base tree and the candidate tree from git's objects into a new
 * temporary directory, never touching the user's worktree, index or refs, and
 * copies the project's installed dependencies into both copies: the verifier
 * writes in its own files and never in the user's.
 */
export async function createWorkspace(input: WorkspaceInput): Promise<Workspace> {
	const { path: dir, remove } = await createScratchDir("verify");
	try {
		await Promise.all([
			materializeTree(input.root, input.tree, join(dir, "candidate")),
			materializeTree(input.root, input.base, join(dir, "base")),
		]);
		const copies = [join(dir, "candidate"), join(dir, "base")];
		let dependencies = await copyDependencies(input.root, copies);
		// Last, so that nothing that arrived with the trees or the dependencies leads out of the directory.
		const left = Math.max(...(await Promise.all(copies.map((copy) => confineLinks(copy, dir, input.root)))));
		if (left > 0)
			dependencies += ` ${left} symbolic ${left === 1 ? "link" : "links"} that pointed outside the project ${left === 1 ? "was" : "were"} left out.`;
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

/** Every directory of the worktree that holds a node_modules, as paths relative to the root ("" for the root). */
async function findNodeModules(top: string): Promise<{ found: string[]; capped: boolean }> {
	const found: string[] = [];
	let visited = 0;
	const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		const names = await readdir(join(top, next.rel), { withFileTypes: true }).catch(() => []);
		if (++visited > SEARCH_LIMIT) return { found, capped: true };
		for (const entry of names) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules") found.push(next.rel);
			else if (entry.name !== ".git" && next.depth < SEARCH_DEPTH)
				queue.push({ rel: join(next.rel, entry.name), depth: next.depth + 1 });
		}
	}
	return { found, capped: false };
}

function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
	return new Promise((done, fail) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (out.length < 4096) out += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (err.length < 4096) err += chunk.toString("utf8");
		});
		child.on("error", fail);
		child.on("close", (code) =>
			code === 0 ? done(out) : fail(new Error(err.trim() || `${command} exited with ${code}`)),
		);
	});
}

/** Disk use of a directory in bytes, links not followed; hard links count once. */
async function sizeOf(path: string, signal: AbortSignal): Promise<number> {
	const kilobytes = Number.parseInt((await run("du", ["-sk", path], signal)).split(/\s/)[0] ?? "", 10);
	if (!Number.isFinite(kilobytes)) throw new Error(`could not measure ${path}`);
	return kilobytes * 1024;
}

/**
 * Copies `source` into `dest` keeping links as links: a clone on APFS, a
 * reflink where the file system has them, a plain copy otherwise. Every file is
 * a new one, so a hard link to a shared store is broken, which is the point.
 */
async function copyDirectory(source: string, dest: string, signal: AbortSignal): Promise<void> {
	const attempts =
		process.platform === "darwin" ? [["-c"], []] : process.platform === "linux" ? [["--reflink=auto"], []] : [[]];
	let last: unknown;
	for (const flags of attempts) {
		await rm(dest, { recursive: true, force: true });
		await mkdir(dest, { recursive: true });
		try {
			await run("cp", ["-P", "-R", ...flags, `${source}/.`, `${dest}/`], signal);
			return;
		} catch (error) {
			last = error;
			if (signal.aborted) break;
		}
	}
	throw last;
}

/**
 * Copies every node_modules of the worktree (the root's and each workspace
 * package's) into the same place of both copies. Nothing is installed or
 * downloaded, and nothing the verifier writes reaches the user's files. Links
 * that lead to another workspace package end up at that package's copy (see
 * `confineLinks`). Over the size or time limit, or on a failed copy, no
 * dependencies are left in the copies. Returns the sentence for the verifier's prompt.
 */
async function copyDependencies(root: string, copies: string[]): Promise<string> {
	const top = await realpath(root);
	const { found, capped } = await findNodeModules(top);
	const none = (why: string) =>
		`${why}, so no installed dependencies are available in the copies: anything that needs them cannot run here; mark those requirements unverified and say so.`;
	const searched = capped
		? ` The search stopped after ${SEARCH_LIMIT} directories, so some node_modules may be missing.`
		: "";
	if (found.length === 0) return `${none("no node_modules directory was found in the project")}${searched}`;
	const signal = AbortSignal.timeout(DEPENDENCY_LIMIT_MS);
	const copied: string[] = [];
	const names = (rels: string[]) => [...new Set(rels)].sort().join(", ");
	try {
		let bytes = 0;
		for (const rel of found) bytes += await sizeOf(join(top, rel, "node_modules"), signal);
		const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`;
		if (bytes > DEPENDENCY_LIMIT_BYTES)
			return `${none(`the installed dependencies take ${mb(bytes)}, over the limit of ${mb(DEPENDENCY_LIMIT_BYTES)}`)}${searched}`;
		for (const rel of found) {
			for (const copy of copies) {
				const isDirectory = await lstat(join(copy, rel)).then(
					(s) => s.isDirectory(),
					() => false,
				);
				if (!isDirectory) continue;
				const dest = join(copy, rel, "node_modules");
				copied.push(dest);
				await copyDirectory(join(top, rel, "node_modules"), dest, signal);
			}
		}
	} catch (error) {
		await Promise.all(copied.map((path) => rm(path, { recursive: true, force: true })));
		return `${none(`the installed dependencies could not be copied (${signal.aborted ? `over ${DEPENDENCY_LIMIT_MS / 1000} seconds` : describeError(error)})`)}${searched}`;
	}
	const places = found.map((rel) => (rel === "" ? "node_modules" : `${rel}/node_modules`));
	return `the project's installed dependencies are copied into both copies (${names(places)}); what you change in them stays in the copies. Installing is not possible, use what is there.${searched}`;
}

/** `realpath` of the deepest part of `path` that exists, with the rest appended. */
async function realish(path: string): Promise<string> {
	const rest: string[] = [];
	for (let current = resolve(path); ; current = dirname(current)) {
		try {
			return join(await realpath(current), ...rest);
		} catch {
			if (dirname(current) === current) return resolve(path);
			rest.unshift(basename(current));
		}
	}
}

const within = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Makes sure no symbolic link under `copy` leads outside `boundary`, where the
 * verifier could write through it into the user's files. A link into the
 * project is pointed at the same place of the copy (which makes a link to
 * another workspace package use the candidate's code); a link anywhere else is
 * removed. Returns how many it removed.
 */
async function confineLinks(copy: string, boundary: string, root: string): Promise<number> {
	const project = await realpath(root);
	const realBoundary = await realpath(boundary);
	const realCopy = await realpath(copy);
	let removed = 0;
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isSymbolicLink()) continue;
			const target = await readlink(path);
			// Where the link leads, with the links on the way followed, even if the last part does not exist.
			const resolved = await realish(isAbsolute(target) ? target : resolve(dir, target));
			if (within(realBoundary, resolved)) continue;
			await rm(path);
			if (within(project, resolved)) await symlink(join(realCopy, relative(project, resolved)), path);
			else removed++;
		}
	};
	await visit(copy);
	return removed;
}
