import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { findDestructiveCommand } from "./destructive-guard.ts";
import { MAX_BYTES, takeTail } from "./limits.ts";
import {
	SANDBOX_OFF,
	type Sandbox,
	type SandboxPolicyName,
	type SandboxStatus,
	sandbox as sharedSandbox,
	verifierEnvironment,
} from "./sandbox.ts";
import { defineTool, ToolInputError } from "./types.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
const KILL_GRACE_MS = 2000;

/** The full-output file stops growing here; the tail is still kept. */
export const MAX_SPILL_BYTES = 50 * 1024 * 1024;

/** A new file path for full output: in the session scratch directory, or a fresh temporary directory. */
function spillPath(scratchDir: string | undefined): string {
	if (scratchDir !== undefined) return join(scratchDir, `bash-${randomBytes(6).toString("hex")}.log`);
	return join(mkdtempSync(join(tmpdir(), "atelier-bash-")), "output.log");
}

/**
 * Keeps a bounded tail of the output in memory. While the output is small it
 * also keeps all of it; once it grows, everything goes to a file, written
 * synchronously so a fast command is slowed down by the pipe instead of
 * filling memory, and capped at MAX_SPILL_BYTES. File errors never fail the
 * command: the tail is still returned.
 */
class OutputSink {
	#tail: Buffer[] = [];
	#tailBytes = 0;
	#all: Buffer[] | undefined = [];
	#allBytes = 0;
	#fd: number | undefined;
	#path: string | undefined;
	#fileBytes = 0;
	capped = false;
	readonly #scratchDir: string | undefined;

	constructor(scratchDir: string | undefined) {
		this.#scratchDir = scratchDir;
	}

	write(chunk: Buffer): void {
		this.#tail.push(chunk);
		this.#tailBytes += chunk.length;
		while (this.#tail.length > 1 && this.#tailBytes - (this.#tail[0] as Buffer).length >= MAX_BYTES * 2)
			this.#tailBytes -= (this.#tail.shift() as Buffer).length;

		if (!this.#all) {
			this.#writeFile(chunk);
			return;
		}
		this.#all.push(chunk);
		this.#allBytes += chunk.length;
		if (this.#allBytes <= MAX_BYTES * 2) return;
		const pending = this.#all;
		this.#all = undefined;
		try {
			this.#path = spillPath(this.#scratchDir);
			this.#fd = openSync(this.#path, "wx");
		} catch {
			this.#path = undefined;
			return;
		}
		for (const piece of pending) this.#writeFile(piece);
	}

	#writeFile(chunk: Buffer): void {
		if (this.#fd === undefined || this.capped) return;
		const room = MAX_SPILL_BYTES - this.#fileBytes;
		const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
		try {
			writeSync(this.#fd, piece);
			this.#fileBytes += piece.length;
			if (piece.length < chunk.length) this.capped = true;
		} catch {
			this.#closeFile();
			this.#path = undefined;
		}
	}

	#closeFile(): void {
		if (this.#fd === undefined) return;
		try {
			closeSync(this.#fd);
		} catch {}
		this.#fd = undefined;
	}

	finish(): { tail: string; all: string | undefined; fullOutputPath: string | undefined } {
		this.#closeFile();
		const tail = Buffer.concat(this.#tail).toString("utf8");
		return {
			tail,
			all: this.#all ? Buffer.concat(this.#all).toString("utf8") : undefined,
			fullOutputPath: this.#path,
		};
	}
}

function saveFullOutput(text: string, scratchDir: string | undefined): string | undefined {
	try {
		const path = spillPath(scratchDir);
		writeFileSync(path, text, { flag: "wx" });
		return path;
	} catch {
		return undefined;
	}
}

function firstLine(command: string): string {
	const line = command.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** Credentials the model could read with `echo $VAR` and leak; nothing else is removed. */
const HIDDEN_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

function commandEnv(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of HIDDEN_ENV) delete env[name];
	return { ...env, ...extra };
}

/** Not a destructive command, but a request the verifier never gets. */
const VERIFIER_UNSANDBOXED = "the verifier's bash cannot run outside the sandbox";

/** The sandbox's status, or "off" when the session turned it off. */
async function statusFor(sandbox: Sandbox, sandboxOff: boolean | undefined): Promise<SandboxStatus> {
	return sandboxOff ? { available: false, reason: SANDBOX_OFF } : sandbox.status();
}

/** What the model and the user are told when the guard refuses a command. */
function refusal(rule: string, command: string): { output: string; summary: string } {
	return { output: `Refused: ${rule} — ${command}`, summary: `Refused: ${rule} — ${firstLine(command)}` };
}

/** The causes shown for one command; the rest are counted. */
const MAX_CAUSES = 5;

/** The output of a command the sandbox refused tends to say so; those get a moment for the log the file denials come from. */
const LOOKS_BLOCKED = /not permitted|permission denied|denied|refused|forbidden|resolve host|unreachable/i;
const GRACE_MS = 400;

/** What the sandbox blocked in a failed run, at most MAX_CAUSES of them. */
async function blockedCauses(
	sandbox: Sandbox,
	runId: string,
	policy: SandboxPolicyName,
	output: string,
): Promise<string[]> {
	const causes = await sandbox.blocks(runId, { policy, graceMs: LOOKS_BLOCKED.test(output) ? GRACE_MS : 0 });
	if (causes.length <= MAX_CAUSES) return causes;
	return [...causes.slice(0, MAX_CAUSES), `and ${causes.length - MAX_CAUSES} more`];
}

export interface BashOptions {
	/** Runs commands without asking the user: for a tool whose working directory is a throwaway copy. */
	withoutApproval?: boolean;
	/** Set on top of the filtered environment, e.g. to make package managers refuse the network. */
	env?: Readonly<Record<string, string>>;
	/**
	 * Which sandbox policy the commands run under: "agent" for the main agent and
	 * its workers, "verifier" for the independent verifier. A command of the
	 * agent runs unsandboxed when there is no sandbox; the verifier's never does.
	 */
	policy?: SandboxPolicyName;
	/** Tests pass their own; the default is the one the process shares. */
	sandbox?: Sandbox;
}

export const bashTool = createBashTool();

export function createBashTool({
	withoutApproval = false,
	env = {},
	policy = "agent",
	sandbox = sharedSandbox,
}: BashOptions = {}) {
	return defineTool({
		name: "bash",
		description: `Run a shell command with bash in the working directory. stdout and stderr are combined. Output is truncated to its tail; the full text is saved to a file. Default timeout: ${DEFAULT_TIMEOUT_SEC}s.`,
		inputShape: {
			command: z.string().min(1).describe("Command to run"),
			timeoutSec: z.number().int().min(1).max(3600).optional().describe("Timeout in seconds"),
			unsandboxed: z
				.boolean()
				.optional()
				.describe(
					"Run this one command outside the sandbox, only when it cannot work inside it (for example to install dependencies). The user is asked unless the session runs in yolo mode; give the reason.",
				),
			reason: z.string().optional().describe("Required with unsandboxed: why this command must leave the sandbox"),
		},
		approvalCommand: ({ command }) => (withoutApproval ? undefined : command),
		async gate({ command, unsandboxed, reason }, { cwd, sandboxOff }) {
			const rule = findDestructiveCommand(command, { cwd, home: homedir() });
			if (rule !== undefined) return { refusal: refusal(rule, command) };
			if (unsandboxed) {
				if (policy === "verifier") return { refusal: refusal(VERIFIER_UNSANDBOXED, command) };
				if (reason === undefined || reason.trim() === "")
					throw new ToolInputError("reason is required with unsandboxed: say why this command must leave the sandbox.");
				return { approval: { command, reason: reason.trim() } };
			}
			if (withoutApproval) return {};
			// The sandbox contains the command: no mode asks about it.
			const status = await statusFor(sandbox, sandboxOff);
			if (status.available) return {};
			return { approval: { command }, warning: status.reason };
		},
		async execute({ command, timeoutSec, unsandboxed }, { cwd, signal, scratchDir, sandboxOff }) {
			// The session asks the gate first; this keeps a direct call from running what the guard refuses.
			const rule = findDestructiveCommand(command, { cwd, home: homedir() });
			if (rule !== undefined) return { ok: false, ...refusal(rule, command), truncated: false };
			const timeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
			if (signal?.aborted)
				return { ok: false, output: "[command aborted]", summary: `${firstLine(command)} (aborted)`, truncated: false };

			if (unsandboxed && policy === "verifier")
				return { ok: false, ...refusal(VERIFIER_UNSANDBOXED, command), truncated: false };
			const sandboxStatus: SandboxStatus = unsandboxed
				? { available: false, reason: "the agent asked to run this command outside the sandbox" }
				: await statusFor(sandbox, sandboxOff);
			if (!sandboxStatus.available && policy === "verifier")
				return {
					ok: false,
					output: `[bash is not available: ${sandboxStatus.reason}]`,
					summary: `${firstLine(command)} (not run)`,
					truncated: false,
				};
			let script = command;
			// Each run gets its own id, so its denials are not mixed with those of another run of the same text.
			const runId = randomUUID();
			if (sandboxStatus.available) {
				try {
					script = await sandbox.wrap(command, {
						policy,
						cwd,
						runId,
						...(scratchDir === undefined ? {} : { scratchDir }),
						...(signal === undefined ? {} : { signal }),
					});
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					return {
						ok: false,
						output: `[sandbox error: ${reason}]`,
						summary: `${firstLine(command)} (not run)`,
						truncated: false,
					};
				}
			}

			const child = spawn("bash", ["-c", script], {
				cwd,
				// The verifier's own git and temporary directory; its caller's variables win.
				env: commandEnv(
					policy === "verifier" && sandboxStatus.available ? { ...verifierEnvironment(cwd), ...env } : env,
				),
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const sink = new OutputSink(scratchDir);
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
			if (sandboxStatus.available) sandbox.cleanup();
			if (stopped) killGroup("SIGKILL");

			const finished = sink.finish();
			const { text, truncated: tailTruncated } = takeTail(finished.tail.replace(/\n$/, ""));
			const spilled = finished.all === undefined;
			let fullOutputPath = finished.fullOutputPath;
			if (tailTruncated && finished.all !== undefined) fullOutputPath = saveFullOutput(finished.all, scratchDir);
			const truncated = tailTruncated || spilled;
			const status =
				stopped === "timeout"
					? `[command timed out after ${timeout}s]`
					: stopped === "aborted"
						? "[command aborted]"
						: `[exit code ${code ?? "unknown"}]`;
			const header = truncated
				? `[Output truncated; showing the end.${fullOutputPath ? ` Full output${sink.capped ? " (first 50 MB)" : ""}: ${fullOutputPath}` : ""}]\n`
				: "";
			const ok = !stopped && code === 0;
			// Only a failed command is asked: the library also logs the denied probes of commands that worked.
			const blocked = sandboxStatus.available && !ok ? await blockedCauses(sandbox, runId, policy, finished.tail) : [];
			const label = stopped === "timeout" ? "timed out" : stopped === "aborted" ? "aborted" : `exit ${code ?? "?"}`;
			return {
				ok,
				output: `${header}${text}${text ? "\n\n" : ""}${status}${blocked.map((cause) => `\n[sandbox blocked: ${cause}]`).join("")}`,
				summary: `${firstLine(command)} (${label})`,
				truncated,
				...(fullOutputPath === undefined ? {} : { fullOutputPath }),
				...(blocked.length === 0 ? {} : { blocked }),
			};
		},
		async sandboxStatus({ sandboxOff }) {
			return statusFor(sandbox, sandboxOff);
		},
	});
}
