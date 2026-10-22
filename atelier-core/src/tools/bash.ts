import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_BYTES, takeTail } from "./limits.ts";
import { defineTool } from "./types.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
const KILL_GRACE_MS = 2000;

/**
 * Keeps a bounded tail of the output in memory. While the output is small it
 * also keeps all of it; once it grows, everything goes to a temporary file.
 * File errors never fail the command: the tail is still returned.
 */
class OutputSink {
	#tail: Buffer[] = [];
	#tailBytes = 0;
	#all: Buffer[] | undefined = [];
	#allBytes = 0;
	#spill: Promise<{ path: string; stream: WriteStream } | undefined> | undefined;

	write(chunk: Buffer): void {
		this.#tail.push(chunk);
		this.#tailBytes += chunk.length;
		while (this.#tail.length > 1 && this.#tailBytes - (this.#tail[0] as Buffer).length >= MAX_BYTES * 2)
			this.#tailBytes -= (this.#tail.shift() as Buffer).length;

		if (this.#all) {
			this.#all.push(chunk);
			this.#allBytes += chunk.length;
			if (this.#allBytes > MAX_BYTES * 2) {
				const pending = this.#all;
				this.#all = undefined;
				this.#spill = openSpillFile().then((file) => {
					for (const piece of pending) file?.stream.write(piece);
					return file;
				});
			}
		} else {
			void this.#spill?.then((file) => file?.stream.write(chunk));
		}
	}

	async finish(): Promise<{ tail: string; all: string | undefined; fullOutputPath: string | undefined }> {
		const tail = Buffer.concat(this.#tail).toString("utf8");
		if (this.#all) return { tail, all: Buffer.concat(this.#all).toString("utf8"), fullOutputPath: undefined };
		const file = await this.#spill;
		if (!file) return { tail, all: undefined, fullOutputPath: undefined };
		const closed = await new Promise<boolean>((resolve) => file.stream.end(() => resolve(!file.stream.errored)));
		return { tail, all: undefined, fullOutputPath: closed ? file.path : undefined };
	}
}

async function openSpillFile(): Promise<{ path: string; stream: WriteStream } | undefined> {
	try {
		const path = join(await mkdtemp(join(tmpdir(), "atelier-bash-")), "output.log");
		const stream = createWriteStream(path);
		stream.on("error", () => {});
		return { path, stream };
	} catch {
		return undefined;
	}
}

async function saveFullOutput(text: string): Promise<string | undefined> {
	try {
		const path = join(await mkdtemp(join(tmpdir(), "atelier-bash-")), "output.log");
		await writeFile(path, text);
		return path;
	} catch {
		return undefined;
	}
}

function firstLine(command: string): string {
	const line = command.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export const bashTool = defineTool({
	name: "bash",
	description: `Run a shell command with bash in the working directory. stdout and stderr are combined. Output is truncated to its tail; the full text is saved to a file. Default timeout: ${DEFAULT_TIMEOUT_SEC}s.`,
	inputShape: {
		command: z.string().min(1).describe("Command to run"),
		timeoutSec: z.number().int().min(1).max(3600).optional().describe("Timeout in seconds"),
	},
	approvalCommand: ({ command }) => command,
	async execute({ command, timeoutSec }, { cwd, signal }) {
		const timeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
		if (signal?.aborted)
			return { ok: false, output: "[command aborted]", summary: `${firstLine(command)} (aborted)`, truncated: false };

		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const sink = new OutputSink();
		child.stdout.on("data", (chunk: Buffer) => sink.write(chunk));
		child.stderr.on("data", (chunk: Buffer) => sink.write(chunk));

		let stopped: "timeout" | "aborted" | undefined;
		const killGroup = (sig: NodeJS.Signals) => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, sig);
			} catch {}
		};
		const stop = (reason: "timeout" | "aborted") => {
			if (stopped) return;
			stopped = reason;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
		};
		const timer = setTimeout(() => stop("timeout"), timeout * 1000);
		const onAbort = () => stop("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });

		const code = await new Promise<number | null>((resolve) => {
			child.on("error", (error) => {
				sink.write(Buffer.from(String(error.message)));
				resolve(null);
			});
			child.on("close", (exitCode) => resolve(exitCode));
		});
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if (stopped) killGroup("SIGKILL");

		const finished = await sink.finish();
		const { text, truncated: tailTruncated } = takeTail(finished.tail.replace(/\n$/, ""));
		const spilled = finished.all === undefined;
		let fullOutputPath = finished.fullOutputPath;
		if (tailTruncated && finished.all !== undefined) fullOutputPath = await saveFullOutput(finished.all);
		const truncated = tailTruncated || spilled;
		const status =
			stopped === "timeout"
				? `[command timed out after ${timeout}s]`
				: stopped === "aborted"
					? "[command aborted]"
					: `[exit code ${code ?? "unknown"}]`;
		const header = truncated
			? `[Output truncated; showing the end.${fullOutputPath ? ` Full output: ${fullOutputPath}` : ""}]\n`
			: "";
		const ok = !stopped && code === 0;
		const label = stopped === "timeout" ? "timed out" : stopped === "aborted" ? "aborted" : `exit ${code ?? "?"}`;
		return {
			ok,
			output: `${header}${text}${text ? "\n\n" : ""}${status}`,
			summary: `${firstLine(command)} (${label})`,
			truncated,
			...(fullOutputPath === undefined ? {} : { fullOutputPath }),
		};
	},
});
