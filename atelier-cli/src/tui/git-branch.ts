import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const SHORT_COMMIT = 7;
const runGit = promisify(execFile);
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_MAX_BYTES = 1024 * 1024;
/** Beyond these, untracked files are not read and the line count is omitted. */
const UNTRACKED_MAX_FILES = 1000;
const UNTRACKED_MAX_BYTES = 8 * 1024 * 1024;
/** Git takes a file with a NUL in its first 8000 bytes for binary. */
const BINARY_PROBE_BYTES = 8000;
/** What a repository without commits is compared with. */
const EMPTY_TREE = {
	sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

/** What the worktree has changed, each part absent while it is not known: lines against `HEAD`, commits against the upstream. */
export interface GitChanges {
	lines?: { added: number; removed: number };
	commits?: { ahead: number; behind: number };
}

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
 * Its subprocesses share one deadline, `timeoutMs` after the call (two seconds by default); what it has not counted by
 * then, or could not count, is left out.
 */
export async function readGitChanges(
	cwd: string,
	signal?: AbortSignal,
	options: { timeoutMs?: number } = {},
): Promise<GitChanges> {
	const deadline = Date.now() + (options.timeoutMs ?? STATUS_TIMEOUT_MS);
	const expired = () => Date.now() >= deadline || signal?.aborted === true;
	/** `work`, unless the deadline or an abort comes first: then the call goes on without it. */
	const bounded = <T>(work: Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const stop = () => reject(new Error("Git status expired"));
			if (expired()) {
				// Given up on before it starts: its own failure, if any, is no one's to handle.
				work.catch(() => {});
				return stop();
			}
			const timer = setTimeout(stop, deadline - Date.now());
			signal?.addEventListener("abort", stop, { once: true });
			work.then(resolve, reject).finally(() => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
			});
		});
	const changes: GitChanges = {};
	let view: string | undefined;
	try {
		const repository = await repositoryOf(cwd);
		if (repository === undefined) return changes;
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
			if (timeout <= 0 || expired()) throw new Error("Git status expired");
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
		/** Each diff driver's `binary` setting, which tells its files binary or text without running anything. */
		const drivers = new Map<string, boolean>();
		for (const entry of settings.split("\0")) {
			const split = entry.indexOf("\n");
			const key = split < 0 ? entry : entry.slice(0, split);
			const value = split < 0 ? "true" : entry.slice(split + 1);
			if (/^core\.(autocrlf|eol|filemode|ignorecase|symlinks|precomposeunicode|excludesfile|attributesfile)$/.test(key))
				safety.push("-c", `${key}=${value}`);
			const driver = /^diff\.([^=\p{Cc}]+)\.binary$/u.exec(key)?.[1];
			// As written, so that git in the view reads it as the user's git does, even a value it refuses.
			if (driver !== undefined && !/\p{Cc}/u.test(value)) {
				safety.push("-c", `${key}=${value}`);
				const binary = gitBoolean(value);
				if (binary !== undefined) drivers.set(driver, binary);
			}
		}
		// rev-parse reads metadata, not worktree contents: unlike status it cannot invoke clean filters.
		const [objectFormat, refFormat] = (await query(["rev-parse", "--show-object-format", "--show-ref-format"]))
			.trim()
			.split("\n");
		if (objectFormat !== "sha1" && objectFormat !== "sha256") return changes;
		if (refFormat !== "files" && refFormat !== "reftable" && refFormat !== "--show-ref-format") return changes;
		// Like rev-parse above, resolving the upstream reads only configuration and refs. A branch without one fails.
		const upstream = await query(["rev-parse", "--symbolic-full-name", "@{upstream}"]).then(
			trackingRef,
			() => undefined,
		);
		const { directory, worktree } = repository;
		const commonPointer = await readFile(join(directory, "commondir"), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return ".";
		});
		const common = resolve(directory, commonPointer.trim());
		const scratch = await realpath(tmpdir());
		const prefix = worktree.endsWith(sep) ? worktree : `${worktree}${sep}`;
		if (scratch === worktree || scratch.startsWith(prefix)) return changes;
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
		if (upstream !== undefined) {
			const counts = /^(\d+)\t(\d+)\n$/.exec(
				await query(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]).catch(() => ""),
			);
			if (counts !== null && !expired()) changes.commits = { ahead: Number(counts[1]), behind: Number(counts[2]) };
		}
		const output = await query([
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--ignore-submodules=all",
			"--renames",
		]);
		if (output === "") {
			changes.lines = { added: 0, removed: 0 };
			return changes;
		}
		if (!output.endsWith("\0")) return changes;
		const records = output.slice(0, -1).split("\0");
		const paths = new Set<string>();
		const untracked: string[] = [];
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (record === undefined || !/^[ MADRCUT?!]{2} .+/s.test(record)) return changes;
			paths.add(record.slice(3));
			if (record.startsWith("??")) untracked.push(record.slice(3));
			if (/^[RC]|^.[RC]/.test(record)) {
				const source = records[++i];
				if (!source) return changes;
				paths.add(source);
			}
		}
		// Filters are never run, so their raw worktree contents cannot give a trustworthy count.
		// --all also distinguishes a literal filter=unspecified from an absent attribute.
		const attributes = await query(["check-attr", "-z", "--all", "--stdin"], `${[...paths].join("\0")}\0`);
		const diffs = new Map<string, string>();
		if (attributes !== "") {
			if (!attributes.endsWith("\0")) return changes;
			const fields = attributes.slice(0, -1).split("\0");
			if (fields.length % 3 !== 0) return changes;
			for (let i = 0; i < fields.length; i += 3) {
				const [path = "", name, value = ""] = fields.slice(i, i + 3);
				if (!paths.has(path) || !name) return changes;
				// Git converts these files before it compares them, which their raw contents cannot show.
				if (name === "filter" || (name === "working-tree-encoding" && converts(value))) return changes;
				if (name === "diff") diffs.set(path, value);
			}
		}
		// The tracked files' lines, staged and unstaged together; without filters, textconv or external diff programs.
		const base = (await hasCommit(query)) ? "HEAD" : EMPTY_TREE[objectFormat];
		const tracked = numstatLines(
			await query([
				"diff",
				"--numstat",
				"-z",
				"-M",
				"--no-ext-diff",
				"--no-textconv",
				"--ignore-submodules=all",
				base,
				"--",
			]),
		);
		if (tracked === undefined) return changes;
		const added = await untrackedLines(worktree, untracked, (path) => kindOf(diffs.get(path), drivers), bounded);
		if (added !== undefined && !expired()) changes.lines = { added: tracked.added + added, removed: tracked.removed };
		return changes;
	} catch {
		return changes;
	} finally {
		if (view !== undefined) await rm(view, { recursive: true, force: true }).catch(() => {});
	}
}

/** The upstream's full ref name, only when it is a branch or a remote-tracking branch named without control characters. */
function trackingRef(output: string): string | undefined {
	const ref = output.endsWith("\n") ? output.slice(0, -1) : output;
	return /^refs\/(?:heads|remotes)\/[^\p{Cc}\p{Cf}\s]+$/u.test(ref) ? ref : undefined;
}

/** Whether `HEAD` names a commit: `rev-parse --verify --quiet` exits 1 without output when it has none yet. */
async function hasCommit(query: (args: string[]) => Promise<string>): Promise<boolean> {
	try {
		return (await query(["rev-parse", "--verify", "--quiet", "HEAD"])) !== "";
	} catch (error) {
		const failed = error as { code?: unknown; stdout?: unknown };
		if (failed.code === 1 && failed.stdout === "") return false;
		throw error;
	}
}

/** `git diff --numstat -z`: `added\tremoved\tpath\0`, or `added\tremoved\t\0source\0destination\0`; `-` for a binary file. */
function numstatLines(output: string): { added: number; removed: number } | undefined {
	const total = { added: 0, removed: 0 };
	if (output === "") return total;
	if (!output.endsWith("\0")) return undefined;
	const fields = output.slice(0, -1).split("\0");
	for (let i = 0; i < fields.length; i++) {
		const stat = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i] ?? "");
		if (stat === null) return undefined;
		if (stat[3] === "") {
			if (!fields[i + 1] || !fields[i + 2]) return undefined;
			i += 2;
		}
		total.added += stat[1] === "-" ? 0 : Number(stat[1]);
		total.removed += stat[2] === "-" ? 0 : Number(stat[2]);
	}
	return total;
}

/**
 * The lines of the untracked files, all of them added, read without git: a symlink is one line (its target), a binary
 * file none (by its attributes and diff driver, else by its bytes, see `kindOf`), and anything else (a FIFO, a socket, a nested repository) is
 * never opened. Over 1000 files or 8 MiB, none. Each wait goes through `bounded`, so a slow read cannot outlive the call.
 */
async function untrackedLines(
	worktree: string,
	paths: string[],
	kind: (path: string) => FileKind,
	bounded: <T>(work: Promise<T>) => Promise<T>,
): Promise<number | undefined> {
	if (paths.length > UNTRACKED_MAX_FILES) return undefined;
	let lines = 0;
	let budget = UNTRACKED_MAX_BYTES;
	for (const path of paths) {
		const name = join(worktree, path);
		const info = await bounded(lstat(name)).catch((error: NodeJS.ErrnoException) => {
			// Removed since git listed it: it adds nothing.
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		// Git counts a symlink's target as its one line, whatever its attributes say.
		if (info?.isSymbolicLink()) lines++;
		if (!info?.isFile() || kind(path) === "binary") continue;
		// Never follow a link or wait on a FIFO that replaced the file since.
		const opening = open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const file = await bounded(opening).catch((error: NodeJS.ErrnoException) => {
			// Given up on: whenever it opens, it is closed.
			opening.then((late) => late.close()).catch(() => {});
			// Removed since its check: it adds nothing. Any other failure leaves the count unknown.
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (file === undefined) continue;
		try {
			const opened = await bounded(file.stat());
			if (!opened.isFile()) continue;
			budget -= opened.size;
			if (budget < 0) return undefined;
			const content = Buffer.alloc(opened.size);
			let read = 0;
			while (read < content.length) {
				const { bytesRead } = await bounded(file.read(content, read, content.length - read, read));
				if (bytesRead === 0) break;
				read += bytesRead;
			}
			lines += lineCount(content.subarray(0, read), kind(path) === "text");
		} finally {
			// Not awaited: a read given up on would hold the close, and with it the call.
			file.close().catch(() => {});
		}
	}
	return lines;
}

/** A config value as git reads a boolean: `true`/`yes`/`on`, `false`/`no`/`off`/empty, or a number, `0` false. */
function gitBoolean(value: string): boolean | undefined {
	if (/^(true|yes|on)$/i.test(value)) return true;
	if (/^(false|no|off|)$/i.test(value)) return false;
	const number = /^[-+]?(\d+)[kmg]?$/i.exec(value)?.[1];
	return number === undefined ? undefined : !/^0+$/.test(number);
}

/** Whether a `working-tree-encoding` value makes git convert the file: not when unset or the default UTF-8. */
const converts = (value: string) =>
	value !== "unset" && value !== "unspecified" && value !== "set" && !/^utf-?8$/i.test(value);

/** What a file is to `git diff`: by its attributes, or by its contents (`unknown`). */
type FileKind = "binary" | "text" | "unknown";

/**
 * As git diff tells binary files: `-diff` (or `binary`) makes one binary and `diff` makes one text, whatever its bytes;
 * a driver's `binary` setting does the same for its files, and anything else leaves it to the contents.
 */
function kindOf(diff: string | undefined, drivers: ReadonlyMap<string, boolean>): FileKind {
	if (diff === "unset") return "binary";
	if (diff === "set") return "text";
	const binary = diff === undefined ? undefined : drivers.get(diff);
	return binary === undefined ? "unknown" : binary ? "binary" : "text";
}

/** Like `git diff --numstat`: the last line counts without its newline, and a binary file has none unless `text`. */
function lineCount(content: Buffer, text: boolean): number {
	if (content.length === 0 || (!text && content.subarray(0, BINARY_PROBE_BYTES).includes(0))) return 0;
	let lines = 0;
	for (let at = content.indexOf(10); at >= 0; at = content.indexOf(10, at + 1)) lines++;
	return content[content.length - 1] === 10 ? lines : lines + 1;
}
