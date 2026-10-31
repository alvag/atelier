import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, closeSync, constants, mkdtempSync, openSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MAX_BYTES, MAX_LINES, tailBytes } from "../../../atelier-core/src/tools/limits.ts";

/** How long a cancelled command gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

export interface UserShellOptions {
	cwd: string;
	/** Live output, stdout and stderr interleaved as they arrive. */
	onOutput?: (text: string) => void;
	signal?: AbortSignal;
	/** The environment the command inherits and `SHELL` is read from; the process's own by default. */
	env?: NodeJS.ProcessEnv;
}

export interface UserShellResult {
	/** The tail of the output, within the tools' limits. */
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	signal?: string;
	/** Every byte of the output, in a private temporary file; only when `truncated`. */
	fullOutputPath?: string;
	error?: string;
}

/** Check cwd separately: spawn can throw synchronously or name the shell for a directory failure. */
function cwdFailure(cwd: string): string | undefined {
	try {
		if (!statSync(cwd).isDirectory()) return `Working directory is not a directory: ${cwd}`;
		accessSync(cwd, constants.X_OK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return `Working directory does not exist: ${cwd}`;
		if (code === "ENOTDIR") return `Working directory is not a directory: ${cwd}`;
		if (code === "EACCES" || code === "EPERM") return `Working directory is not accessible: ${cwd} (${code})`;
		return `Cannot use working directory ${cwd}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}

/** Keeps the output's tail in memory and writes all of it to a private file once the tail starts dropping bytes. */
class OutputSink {
	private tail: Buffer = Buffer.alloc(0);
	private text = "";
	private fd: number | undefined;
	private path: string | undefined;
	private dropped = false;
	failure: string | undefined;

	push(chunk: Buffer): void {
		if (this.tail.length + chunk.length > MAX_BYTES) {
			if (this.fd === undefined && !this.failure) this.spill();
			this.dropped = true;
		}
		this.write(chunk);
		this.tail = Buffer.from(Buffer.concat([this.tail, chunk.subarray(-MAX_BYTES)]).subarray(-MAX_BYTES));
	}

	/** Display decoding is separate: the full-output file always receives the original buffers. */
	display(text: string): void {
		const combined = this.text + text;
		if (Buffer.byteLength(combined) > MAX_BYTES) this.dropped = true;
		this.text = tailBytes(combined, MAX_BYTES);
	}

	/** Creates the file with what was kept so far, which is everything because nothing was dropped yet. */
	private spill(): void {
		try {
			const dir = mkdtempSync(join(tmpdir(), "atelier-shell-"));
			const path = join(dir, "output.txt");
			this.fd = openSync(path, "wx", 0o600);
			this.path = path;
			this.write(this.tail);
		} catch (error) {
			this.failure = error instanceof Error ? error.message : String(error);
		}
	}

	private write(bytes: Buffer): void {
		if (this.fd === undefined) return;
		try {
			let offset = 0;
			while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
		} catch (error) {
			this.failure = error instanceof Error ? error.message : String(error);
		}
	}

	finish(): Pick<UserShellResult, "output" | "truncated" | "fullOutputPath"> {
		// A terminating newline closes the last line; it does not add an extra empty line to the limit.
		const ending = this.text.endsWith("\n") ? "\n" : "";
		const lines = (ending ? this.text.slice(0, -1) : this.text).split("\n");
		const truncated = this.dropped || lines.length > MAX_LINES;
		const text = lines.slice(-MAX_LINES).join("\n") + ending;
		if (this.fd === undefined && truncated && !this.failure) this.spill();
		try {
			if (this.fd !== undefined) closeSync(this.fd);
		} catch (error) {
			this.failure = error instanceof Error ? error.message : String(error);
		}
		const saved = { output: text, truncated: truncated || this.dropped };
		return this.path === undefined || this.failure ? saved : { ...saved, fullOutputPath: this.path };
	}
}

function groupAlive(child: ChildProcess): boolean {
	try {
		process.kill(-(child.pid as number), 0);
		return true;
	} catch {
		return false;
	}
}

/** Terminates the command's process group: SIGTERM now, SIGKILL after the grace period; `escalated` resolves then. */
function killGroup(child: ChildProcess, cutOutput: () => void): { escalated: Promise<void>; stop: () => void } {
	const send = (signal: NodeJS.Signals) => {
		try {
			process.kill(-(child.pid as number), signal);
		} catch {
			// The group is already gone.
		}
	};
	send("SIGTERM");
	let timer: NodeJS.Timeout | undefined;
	const escalated = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			send("SIGKILL");
			// A descendant may have left this group but still own a pipe. Never wait for that pipe forever.
			cutOutput();
			resolve();
		}, KILL_GRACE_MS);
	});
	return { escalated, stop: () => clearTimeout(timer) };
}

/**
 * Runs `command` as the user would in their shell, outside the agent: no guard, sandbox, permissions or model.
 * It has no stdin and its own session, so no controlling terminal; resolves once the shell has exited and its
 * output is drained, or cancellation's grace period closes pipes held by escaped descendants.
 */
export function runUserShell(command: string, options: UserShellOptions): Promise<UserShellResult> {
	const env = options.env ?? process.env;
	const sink = new OutputSink();
	const { signal } = options;
	if (signal?.aborted) return Promise.resolve({ output: "", exitCode: null, cancelled: true, truncated: false });
	const cwdError = cwdFailure(options.cwd);
	if (cwdError)
		return Promise.resolve({ output: "", exitCode: null, cancelled: false, truncated: false, error: cwdError });
	return new Promise((resolve) => {
		let cancelled = false;
		let killing: ReturnType<typeof killGroup> | undefined;
		let settled = false;
		const settle = (exitCode: number | null, killedBy?: string, error?: string) => {
			if (settled) return;
			settled = true;
			killing?.stop();
			signal?.removeEventListener("abort", cancel);
			const saved = sink.finish();
			const failure = error ?? sink.failure;
			resolve({
				...saved,
				exitCode,
				cancelled,
				...(killedBy ? { signal: killedBy } : {}),
				...(failure ? { error: failure } : {}),
			});
		};
		let child: ChildProcess;
		try {
			child = spawn(env.SHELL || "/bin/sh", ["-c", command], {
				cwd: options.cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
		} catch (error) {
			resolve({
				output: "",
				exitCode: null,
				cancelled: false,
				truncated: false,
				error: cwdFailure(options.cwd) ?? (error instanceof Error ? error.message : String(error)),
			});
			return;
		}
		const flushers: (() => void)[] = [];
		const cancel = () => {
			if (cancelled || child.pid === undefined) return;
			cancelled = true;
			killing = killGroup(child, () => {
				for (const flush of flushers) flush();
				child.stdout?.destroy();
				child.stderr?.destroy();
			});
		};
		const onText = (text: string) => {
			if (!text) return;
			sink.display(text);
			options.onOutput?.(text);
		};
		for (const stream of [child.stdout, child.stderr]) {
			const decoder = new StringDecoder("utf8");
			let flushed = false;
			const flush = () => {
				if (flushed) return;
				flushed = true;
				onText(decoder.end());
			};
			flushers.push(flush);
			stream?.on("data", (chunk: Buffer) => {
				sink.push(chunk);
				onText(decoder.write(chunk));
			});
			stream?.on("end", flush);
		}
		child.on("error", (error) => settle(null, undefined, cwdFailure(options.cwd) ?? error.message));
		child.on("close", async (code, killedBy) => {
			// Descendants that outlive the shell and ignore SIGTERM are still killed when the grace ends.
			if (killing && groupAlive(child)) await killing.escalated;
			settle(code, killedBy ?? undefined);
		});
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
	});
}
