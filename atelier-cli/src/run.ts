import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { type AgentBackend, ClaudeCodeBackend, coreTools, Session, SYSTEM_PROMPT_APPEND, VERSION } from "@atelier/core";
import { parseCliArgs, USAGE, UsageError } from "./args.ts";
import { Renderer } from "./render.ts";

export interface CliIO {
	stdin: Readable;
	/** Whether stdin is a terminal a person can answer prompts on. */
	isTTY: boolean;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	cwd: string;
	color: boolean;
	/** Registers a Ctrl+C handler; returns a function that removes it. */
	onInterrupt?: (handler: () => void) => () => void;
	/** Last resort when Claude Code does not stop after the session is closed. */
	exit?: (code: number) => void;
	/** Delay before that forced exit; defaults to FORCE_EXIT_MS. */
	forceExitMs?: number;
}

export type BackendFactory = () => AgentBackend;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;
const FORCE_EXIT_MS = 3000;

export async function run(
	argv: readonly string[],
	io: CliIO,
	createBackend: BackendFactory = () => new ClaudeCodeBackend(),
): Promise<number> {
	let args: ReturnType<typeof parseCliArgs>;
	try {
		args = parseCliArgs(argv, io.cwd);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		io.stderr(`error: ${error.message}\nRun atelier --help for usage.\n`);
		return EXIT_USAGE;
	}
	if (args.help) {
		io.stdout(USAGE);
		return EXIT_OK;
	}
	if (args.version) {
		io.stdout(`atelier ${VERSION}\n`);
		return EXIT_OK;
	}
	if (
		!(await stat(args.cwd).then(
			(s) => s.isDirectory(),
			() => false,
		))
	) {
		io.stderr(`error: Working directory does not exist: ${args.cwd}\n`);
		return EXIT_USAGE;
	}

	const renderer = new Renderer({ stdout: io.stdout, stderr: io.stderr, color: io.color });
	const lines = createLineReader(io.stdin);
	/** Cancels a pending approval question, answering no. */
	let cancelApproval: (() => void) | undefined;
	const session = await Session.start({
		backend: createBackend(),
		cwd: args.cwd,
		...(args.model === undefined ? {} : { model: args.model }),
		tools: coreTools,
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		autoApprove: args.yes,
		approve: async ({ command }) => {
			if (!io.isTTY) {
				renderer.endLine();
				io.stderr(`bash command needs approval; run with --yes to allow commands: ${command}\n`);
				return false;
			}
			renderer.endLine();
			renderer.write(`Run this command?\n  ${command}\n[y/N] `);
			const cancelled = new Promise<undefined>((resolve) => {
				cancelApproval = () => resolve(undefined);
			});
			const read = lines.next();
			const answer = await Promise.race([read.then((line) => ({ line })), cancelled]);
			cancelApproval = undefined;
			if (answer === undefined) {
				lines.abandon(read);
				renderer.write("\n");
				return false;
			}
			renderer.write("\n");
			return /^y(es)?$/i.test(answer.line?.trim() ?? "");
		},
	});

	// Ctrl+C: the first press interrupts the turn (and answers no to a pending
	// approval); a press with no turn running, or a second one, closes the
	// session so Claude Code exits; io.exit is only a fallback if that hangs.
	let interrupted = false;
	let quitting = false;
	let forceExit: NodeJS.Timeout | undefined;
	const quit = () => {
		if (quitting) return io.exit?.(EXIT_INTERRUPTED);
		quitting = true;
		interrupted = true;
		cancelApproval?.();
		lines.close();
		void session.close();
		if (io.exit) forceExit = setTimeout(() => io.exit?.(EXIT_INTERRUPTED), io.forceExitMs ?? FORCE_EXIT_MS).unref();
	};
	const removeInterrupt = io.onInterrupt?.(() => {
		renderer.endLine();
		if (!session.busy || interrupted) return quit();
		interrupted = true;
		io.stderr("interrupting... (Ctrl+C again to quit)\n");
		cancelApproval?.();
		void session.interrupt();
	});

	const runTurn = async (prompt: string) => {
		renderer.resetTurn();
		interrupted = false;
		for await (const event of session.send(prompt)) renderer.render(event);
		renderer.endLine();
	};

	try {
		if (args.prompt !== undefined) {
			await runTurn(args.prompt);
			if (interrupted) return EXIT_INTERRUPTED;
			return renderer.failed ? EXIT_FAILED : EXIT_OK;
		}
		while (true) {
			if (io.isTTY) renderer.write("> ");
			const line = await lines.next();
			if (quitting) return EXIT_INTERRUPTED;
			if (line === undefined || line.trim() === "/exit") break;
			if (line.trim() === "") continue;
			await runTurn(line);
			if (quitting) return EXIT_INTERRUPTED;
		}
		return EXIT_OK;
	} finally {
		lines.close();
		// Keep the forced exit and the Ctrl+C handler until the session is really closed.
		await session.close();
		clearTimeout(forceExit);
		removeInterrupt?.();
	}
}

/** Reads stdin line by line on demand; created lazily so a one-shot run without prompts never touches stdin. */
function createLineReader(stdin: Readable) {
	let iterator: AsyncIterator<string> | undefined;
	/** A read whose caller gave up (a cancelled approval); the next caller gets its line. */
	let abandoned: Promise<string | undefined> | undefined;
	let close = () => {};
	return {
		next(): Promise<string | undefined> {
			if (abandoned) {
				const read = abandoned;
				abandoned = undefined;
				return read;
			}
			if (!iterator) {
				const rl = createInterface({ input: stdin, terminal: false });
				iterator = rl[Symbol.asyncIterator]();
				close = () => rl.close();
			}
			return iterator.next().then((result) => (result.done ? undefined : result.value));
		},
		/** Gives back a read from next() that will not be consumed. */
		abandon(read: Promise<string | undefined>): void {
			abandoned = read;
		},
		close: () => close(),
	};
}
