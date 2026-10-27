import { type ChildProcess, spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { StdioServerConfig } from "./config.ts";

/** How much of a server's stderr is kept, from its end. */
export const STDERR_TAIL_CHARS = 4_000;
/** How long a server has to exit after SIGTERM before its process group gets SIGKILL. */
const TERM_GRACE_MS = 2_000;

/** Process groups still running, killed on exit if the session could not close them. */
const running = new Set<number>();
let exitHook = false;

/**
 * Talks to a stdio server started in its own process group, so closing stops what it started too: a server launched
 * through `npx` or `uvx` is a grandchild of Atelier. Closing ends stdin, sends SIGTERM to the group and, once the
 * server exits or the grace ends, SIGKILL to the group.
 */
export class ProcessGroupTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	#child: ChildProcess | undefined;
	#buffer = new ReadBuffer();
	#stderr = "";
	#exited: Promise<void> | undefined;

	readonly config: StdioServerConfig;

	constructor(config: StdioServerConfig) {
		this.config = config;
	}

	/** The end of what the server wrote to stderr, as written: the caller hides the secrets. */
	get stderr(): string {
		return this.#stderr;
	}

	start(): Promise<void> {
		const { command, args, env, cwd } = this.config;
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd,
				env: { ...process.env, ...env },
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			this.#child = child;
			this.#exited = new Promise((done) => child.once("close", () => done()));
			child.once("error", (error) => {
				reject(error);
				this.onerror?.(error);
			});
			child.once("spawn", () => {
				if (child.pid !== undefined) track(child.pid);
				resolve();
			});
			child.once("close", () => {
				if (child.pid !== undefined) running.delete(child.pid);
				this.onclose?.();
			});
			child.stdout?.on("data", (chunk: Buffer) => {
				this.#buffer.append(chunk);
				this.#drain();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
			});
			child.stdin?.on("error", (error) => this.onerror?.(error));
		});
	}

	#drain(): void {
		for (;;) {
			let message: JSONRPCMessage | null;
			try {
				message = this.#buffer.readMessage();
			} catch (error) {
				this.onerror?.(error as Error);
				continue;
			}
			if (message === null) return;
			this.onmessage?.(message);
		}
	}

	send(message: JSONRPCMessage): Promise<void> {
		return new Promise((resolve, reject) => {
			const stdin = this.#child?.stdin;
			if (!stdin?.writable) return reject(new Error("The server's stdin is closed"));
			stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		const child = this.#child;
		if (child === undefined || child.pid === undefined) return;
		const group = child.pid;
		child.stdin?.end();
		signal(group, "SIGTERM");
		await Promise.race([this.#exited, new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS).unref())]);
		// The group may outlive its leader: a wrapper's children ignore what reached it.
		signal(group, "SIGKILL");
		running.delete(group);
		this.#buffer.clear();
	}
}

function signal(group: number, name: NodeJS.Signals): void {
	try {
		process.kill(process.platform === "win32" ? group : -group, name);
	} catch {}
}

function track(group: number): void {
	running.add(group);
	if (exitHook) return;
	exitHook = true;
	process.once("exit", () => {
		for (const pid of running) signal(pid, "SIGKILL");
	});
}
