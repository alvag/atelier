import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const SHORT_COMMIT = 7;
const runGit = promisify(execFile);
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_MAX_BYTES = 1024 * 1024;

/**
 * The folders the search must not walk up into, from `GIT_CEILING_DIRECTORIES` as git reads it: split on the platform's
 * path list separator, absolute paths only, with their symlinks resolved; one that does not exist is ignored.
 */
async function ceilingDirectories(): Promise<string[]> {
	const listed = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter((path) => isAbsolute(path));
	const real = await Promise.all(listed.map((path) => realpath(path).catch(() => undefined)));
	return real.filter((path) => path !== undefined);
}

/** The repository containing `cwd`, including a linked worktree's separate git directory. */
async function repositoryOf(cwd: string): Promise<{ directory: string; worktree: string } | undefined> {
	const ceilings = await ceilingDirectories();
	// Its symlinks resolved too, as the ceilings' are, for the two to compare.
	const start = await realpath(cwd).catch(() => resolve(cwd));
	for (let dir = start; ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		const found = await stat(dotGit).catch(() => undefined);
		if (found?.isDirectory()) return { directory: dotGit, worktree: dir };
		if (found?.isFile()) {
			const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, "utf8"));
			return pointer?.[1] === undefined ? undefined : { directory: resolve(dir, pointer[1].trim()), worktree: dir };
		}
		if (dirname(dir) === dir || ceilings.includes(dirname(dir))) return undefined;
	}
}

/**
 * The branch of the repository `cwd` is in, read from its `HEAD` without running git: the short commit when `HEAD` is
 * detached, nothing outside a repository or when `HEAD` cannot be read. Like git, it stops below `GIT_CEILING_DIRECTORIES`.
 */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
	try {
		const repository = await repositoryOf(cwd);
		if (repository === undefined) return undefined;
		const head = (await readFile(join(repository.directory, "HEAD"), "utf8")).trim();
		const ref = /^ref: (.+)$/.exec(head)?.[1];
		if (ref !== undefined) return ref.replace(/^refs\/heads\//, "");
		return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, SHORT_COMMIT) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A bounded, read-only status query. No pager, fsmonitor, filters, submodule commands, or lazy object fetches.
 * Its subprocesses share one deadline, `timeoutMs` after the call (two seconds by default).
 */
export async function readGitChanges(
	cwd: string,
	signal?: AbortSignal,
	options: { timeoutMs?: number } = {},
): Promise<number | undefined> {
	const deadline = Date.now() + (options.timeoutMs ?? STATUS_TIMEOUT_MS);
	let view: string | undefined;
	try {
		const repository = await repositoryOf(cwd);
		if (repository === undefined) return undefined;
		// Ignore inherited repository/index/config redirects; use the same canonical ceilings as the branch reader.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		Object.assign(env, {
			GIT_CEILING_DIRECTORIES: (await ceilingDirectories()).join(delimiter),
			GIT_NO_LAZY_FETCH: "1",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_ATTR_NOSYSTEM: "1",
		});
		const safety = [
			"--no-pager",
			"--no-optional-locks",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
		];
		const query = async (args: string[], input?: string) => {
			const timeout = deadline - Date.now();
			if (timeout <= 0 || signal?.aborted) throw new Error("Git status expired");
			const pending = runGit("git", [...safety, ...args], {
				cwd,
				env,
				timeout,
				maxBuffer: STATUS_MAX_BYTES,
				killSignal: "SIGKILL",
				encoding: "utf8",
				...(signal === undefined ? {} : { signal }),
			});
			let inputError: Error | undefined;
			if (input !== undefined) {
				pending.child.stdin
					?.on("error", (error: Error) => {
						inputError = error;
					})
					.end(input);
			}
			const { stdout } = await pending;
			if (inputError !== undefined) throw inputError;
			return stdout;
		};
		// Retain only non-executable settings that affect file comparisons and ignore/attribute rules.
		const settings = await query(["config", "--null", "--list"]);
		for (const entry of settings.split("\0")) {
			const split = entry.indexOf("\n");
			const key = split < 0 ? entry : entry.slice(0, split);
			if (/^core\.(autocrlf|eol|filemode|ignorecase|symlinks|precomposeunicode|excludesfile|attributesfile)$/.test(key))
				safety.push("-c", `${key}=${split < 0 ? "true" : entry.slice(split + 1)}`);
		}
		// rev-parse reads metadata, not worktree contents: unlike status it cannot invoke clean filters.
		const [objectFormat, refFormat] = (await query(["rev-parse", "--show-object-format", "--show-ref-format"]))
			.trim()
			.split("\n");
		if (objectFormat !== "sha1" && objectFormat !== "sha256") return undefined;
		if (refFormat !== "files" && refFormat !== "reftable" && refFormat !== "--show-ref-format") return undefined;
		const { directory, worktree } = repository;
		const commonPointer = await readFile(join(directory, "commondir"), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return ".";
		});
		const common = resolve(directory, commonPointer.trim());
		const scratch = await realpath(tmpdir());
		const prefix = worktree.endsWith(sep) ? worktree : `${worktree}${sep}`;
		if (scratch === worktree || scratch.startsWith(prefix)) return undefined;
		view = await mkdtemp(join(scratch, "atelier-status-"));
		await mkdir(join(view, "info"));
		// Git validates HEAD symlinks as ref names, so a link to the original file is not a valid HEAD.
		await copyFile(join(directory, "HEAD"), join(view, "HEAD"));
		// Never copy or link config: a second process could otherwise add a filter after we disabled known drivers.
		await writeFile(
			join(view, "config"),
			`[core]\n repositoryformatversion = 1\n bare = false\n[extensions]\n objectFormat = ${objectFormat}\n${refFormat === "reftable" ? " refStorage = reftable\n" : ""}`,
		);
		const links: [string, string][] = [
			["index", join(directory, "index")],
			...["objects", "refs", "packed-refs", "reftable"].map((name): [string, string] => [name, join(common, name)]),
			["info/exclude", join(common, "info", "exclude")],
			["info/attributes", join(common, "info", "attributes")],
			...(await readdir(directory))
				.filter((name) => /^sharedindex\.[0-9a-f]+$/.test(name))
				.map((name): [string, string] => [name, join(directory, name)]),
		];
		for (const [name, target] of links) await symlink(target, join(view, name));
		Object.assign(env, {
			GIT_DIR: view,
			GIT_WORK_TREE: worktree,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: devNull,
		});
		const output = await query([
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--ignore-submodules=all",
			"--renames",
		]);
		if (output === "") return 0;
		if (!output.endsWith("\0")) return undefined;
		const records = output.slice(0, -1).split("\0");
		let count = 0;
		const paths = new Set<string>();
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (record === undefined || !/^[ MADRCUT?!]{2} .+/s.test(record)) return undefined;
			paths.add(record.slice(3));
			if (/^[RC]|^.[RC]/.test(record)) {
				const source = records[++i];
				if (!source) return undefined;
				paths.add(source);
			}
			count++;
		}
		// Filters are never run, so their raw worktree contents cannot give a trustworthy count.
		// --all also distinguishes a literal filter=unspecified from an absent attribute.
		const attributes = await query(["check-attr", "-z", "--all", "--stdin"], `${[...paths].join("\0")}\0`);
		if (attributes === "") return count;
		if (!attributes.endsWith("\0")) return undefined;
		const fields = attributes.slice(0, -1).split("\0");
		if (fields.length % 3 !== 0) return undefined;
		for (let i = 0; i < fields.length; i += 3) {
			if (!paths.has(fields[i] ?? "") || !fields[i + 1]) return undefined;
			if (fields[i + 1] === "filter") return undefined;
		}
		return count;
	} catch {
		return undefined;
	} finally {
		if (view !== undefined) await rm(view, { recursive: true, force: true }).catch(() => {});
	}
}
