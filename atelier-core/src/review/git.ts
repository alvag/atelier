import { spawn } from "node:child_process";

export interface GitOptions {
	cwd: string;
	/** Extra environment for this call, such as a temporary GIT_INDEX_FILE. */
	env?: Readonly<Record<string, string>>;
	/** Stops reading stdout past this many bytes and kills git; the result says it was cut. */
	limitBytes?: number;
	timeoutMs?: number;
}

export interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
	/** stdout stopped at `limitBytes`. */
	truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_LIMIT = 16 * 1024;

/**
 * The environment git runs with: the caller's, minus every GIT_* variable, so a
 * GIT_DIR or GIT_INDEX_FILE inherited from a hook or a shell can never point
 * Atelier at the user's index or another repository.
 */
function gitEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extra };
}

/** Runs git without a shell. Never rejects for a non-zero exit: the code is in the result. */
export function runGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd: options.cwd,
			env: gitEnv(options.env),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let truncated = false;
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (truncated) return;
			const limit = options.limitBytes;
			if (limit !== undefined && bytes + chunk.length > limit) {
				chunks.push(chunk.subarray(0, limit - bytes));
				bytes = limit;
				truncated = true;
				child.kill();
				return;
			}
			chunks.push(chunk);
			bytes += chunk.length;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: truncated ? 0 : (code ?? 1), stdout: Buffer.concat(chunks), stderr, truncated });
		});
	});
}

/**
 * Runs git and hands each stdout line (split on `\n` only, so a `\r` stays in
 * the line) to `onLine` as it arrives, never holding the whole output.
 */
export function streamGitLines(
	args: readonly string[],
	options: Omit<GitOptions, "limitBytes">,
	onLine: (line: Buffer) => void,
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd: options.cwd,
			env: gitEnv(options.env),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		let pending: Buffer[] = [];
		let stderr = "";
		let failed: unknown;
		const emit = (line: Buffer) => {
			if (failed !== undefined) return;
			try {
				onLine(line);
			} catch (error) {
				failed = error;
				child.kill();
			}
		};
		child.stdout.on("data", (chunk: Buffer) => {
			let start = 0;
			for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
				pending.push(chunk.subarray(start, end));
				emit(Buffer.concat(pending));
				pending = [];
				start = end + 1;
			}
			if (start < chunk.length) pending.push(chunk.subarray(start));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (pending.length > 0) emit(Buffer.concat(pending));
			if (failed !== undefined) reject(failed);
			else resolve({ code: code ?? 1, stderr });
		});
	});
}

/** Runs git and returns its stdout as text, or throws with git's own message. */
export async function gitText(args: readonly string[], options: GitOptions): Promise<string> {
	const result = await runGit(args, options);
	if (result.code !== 0) throw new GitError(args, result.stderr.trim() || `git exited with ${result.code}`);
	return result.stdout.toString("utf8");
}

export class GitError extends Error {
	override name = "GitError";
	constructor(args: readonly string[], detail: string) {
		super(`git ${args[0] ?? ""} failed: ${detail}`);
	}
}
