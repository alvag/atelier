import { realpath, stat } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import {
	type AgentBackend,
	type AtelierEvent,
	type BackendName,
	BUILTIN_AGENTS,
	checkRoot,
	coreTools,
	createBackend as createNamedBackend,
	describeError,
	loadSandboxAdditions,
	type MemoryPort,
	type ReviewConsentRequest,
	SandboxConfigError,
	Session,
	SYSTEM_PROMPT_APPEND,
	type ToolDefinition,
	VERSION,
	visibleText,
} from "@atelier/core";
import { parseCliArgs, USAGE, UsageError } from "./args.ts";
import { Renderer } from "./render.ts";
import { createTerminalReader, type LineReader } from "./terminal-input.ts";

export interface CliIO {
	stdin: Readable;
	/** Whether stdin is a terminal a person can answer prompts on. */
	isTTY: boolean;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	cwd: string;
	/** The environment the switches (ATELIER_REVIEW) are read from; none set when absent. */
	env?: Record<string, string | undefined>;
	/** The user id of the process; Atelier does not start as root (0) without ATELIER_ALLOW_ROOT. Unknown when absent. */
	uid?: number;
	/** Where the walk up from `cwd` for AGENTS.md / CLAUDE.md stops (excluded); none are read when absent. */
	home?: string;
	color: boolean;
	/**
	 * Puts the terminal in raw mode or back; given only when stdin and stdout are both terminals.
	 * The CLI then edits lines itself and reads a bracketed paste as one prompt.
	 */
	setRawMode?: (on: boolean) => void;
	/** Registers a Ctrl+C handler; returns a function that removes it. */
	onInterrupt?: (handler: () => void) => () => void;
	/** Registers a handler for SIGTERM and SIGHUP, given the signal's number; returns a function that removes it. */
	onTerminate?: (handler: (signal: number) => void) => () => void;
	/** Last resort when Claude Code does not stop after the session is closed. */
	exit?: (code: number) => void;
	/** Delay before that forced exit; defaults to FORCE_EXIT_MS. */
	forceExitMs?: number;
	/** The tools sessions get; tests pass their own. Defaults to the core's. */
	tools?: readonly ToolDefinition[];
}

/** Connects long-term memory for the working directory; may fail, and then the session runs without it. */
export type MemoryConnector = (cwd: string) => Promise<MemoryPort>;

/** Builds the backend named by --backend; may fail, for example without an API key. */
export type BackendFactory = (name: BackendName) => AgentBackend | Promise<AgentBackend>;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;
/** A process ended by a signal exits with 128 plus its number. */
const SIGNAL_EXIT = 128;
const FORCE_EXIT_MS = 3000;
const PROMPT = "> ";
const ANSWER_PROMPT = "[y/N] ";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

export async function run(
	argv: readonly string[],
	io: CliIO,
	createBackend: BackendFactory = (name) => createNamedBackend(name),
	connectMemory?: MemoryConnector,
): Promise<number> {
	let args: ReturnType<typeof parseCliArgs>;
	try {
		args = parseCliArgs(argv, io.cwd, io.env);
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
	const root = checkRoot(io.uid, io.env ?? {});
	if (!root.allowed) {
		io.stderr(`error: ${root.message}\n`);
		return EXIT_FAILED;
	}
	if (root.warning) io.stderr(`${root.warning}\n`);
	if (
		!(await stat(args.cwd).then(
			(s) => s.isDirectory(),
			() => false,
		))
	) {
		io.stderr(`error: Working directory does not exist: ${args.cwd}\n`);
		return EXIT_USAGE;
	}

	// A broken file stops the start: ignoring it would silently widen or narrow what commands may do.
	if (!args.noSandbox && io.home !== undefined) {
		try {
			loadSandboxAdditions({ cwd: args.cwd, home: io.home });
		} catch (error) {
			if (!(error instanceof SandboxConfigError)) throw error;
			io.stderr(`error: ${error.message}\n`);
			return EXIT_FAILED;
		}
	}

	let backend: AgentBackend;
	try {
		backend = await createBackend(args.backend);
	} catch (error) {
		io.stderr(`error: ${describeError(error)}\n`);
		return EXIT_FAILED;
	}

	let memory: MemoryPort | undefined;
	let memoryUnavailable: string | undefined;
	if (connectMemory)
		memory = await Promise.resolve()
			.then(() => connectMemory(args.cwd))
			.catch((error: unknown) => {
				memoryUnavailable = describeError(error);
				return undefined;
			});

	const renderer = new Renderer({
		stdout: io.stdout,
		stderr: io.stderr,
		color: io.color,
		cwd: await realpath(args.cwd),
	});
	const setRawMode = io.isTTY ? io.setRawMode : undefined;
	/** Ctrl+C typed on a raw terminal, where it arrives as a key instead of a signal. */
	let onCtrlC = () => {};
	const lines: LineReader = setRawMode
		? createTerminalReader({ stdin: io.stdin, write: io.stdout, onInterrupt: () => onCtrlC() })
		: createLineReader(io.stdin);
	// On a terminal, read from the start so lines typed before a question are known to be early.
	if (io.isTTY && !setRawMode) lines.open();
	let rawMode = false;
	/** Leaves the terminal as it was; safe to call more than once. */
	const restoreTerminal = () => {
		if (!rawMode) return;
		rawMode = false;
		setRawMode?.(false);
		io.stdout(BRACKETED_PASTE_OFF);
	};
	const exit = (code: number) => {
		restoreTerminal();
		io.exit?.(code);
	};
	/** Cancels a pending yes/no question, answering no. */
	let cancelApproval: (() => void) | undefined;
	/** Asks a yes/no question on the terminal; only "y" or "yes" is a yes, and Ctrl+C is a no. */
	const askYesNo = async (question: string): Promise<boolean> => {
		renderer.endLine();
		// Only an answer typed after the question counts: an early line, such as the rest of a pasted prompt, could say yes.
		const early = lines.discardTyped();
		if (early > 0) renderer.write(`ignored ${early} ${early === 1 ? "line" : "lines"} typed before this question\n`);
		renderer.write(`${question}${ANSWER_PROMPT}`);
		const cancelled = new Promise<undefined>((resolve) => {
			cancelApproval = () => resolve(undefined);
		});
		const read = lines.next(ANSWER_PROMPT.length);
		const answer = await Promise.race([read.then((line) => ({ line })), cancelled]);
		cancelApproval = undefined;
		if (answer === undefined) {
			lines.abandon();
			renderer.write("\n");
			return false;
		}
		renderer.write("\n");
		// A paste can say "y" without anyone having decided anything: only typed text answers.
		if (lines.pasted()) {
			renderer.write("pasted text does not answer this question\n");
			return false;
		}
		return /^y(es)?$/i.test(answer.line?.trim() ?? "");
	};
	const consent = async ({
		level,
		reasons,
		lenses,
		lensesReason,
	}: ReviewConsentRequest): Promise<"granted" | "declined"> => {
		if (!io.isTTY) {
			renderer.endLine();
			io.stderr("review skipped: there is no terminal to ask; use /review in an interactive session to review it\n");
			return "declined";
		}
		// Let the risk line, which the same turn queued just before this question, print first.
		await new Promise((resolve) => setImmediate(resolve));
		// Reasons come from file paths and contents: show control characters instead of letting the terminal run them.
		const shown = reasons.map((reason) => visibleText(reason).text).join("; ");
		const why = lensesReason === undefined ? "" : ` (${visibleText(lensesReason).text})`;
		const answer = await askYesNo(
			`Review this change?\n  risk: ${level}\n  reasons: ${shown}\n  lenses: ${lenses.join(", ")}${why}\n`,
		);
		return answer ? "granted" : "declined";
	};
	// On a raw terminal, take the terminal over before the session starts, so what is typed meanwhile is known to be early.
	if (setRawMode) {
		setRawMode(true);
		rawMode = true;
		io.stdout(BRACKETED_PASTE_ON);
		lines.open();
	}
	// Until the session is up there is nothing to interrupt: Ctrl+C and SIGTERM/SIGHUP give the terminal back and exit.
	const leaveWhileStarting = (code: number) => {
		lines.close();
		exit(code);
	};
	onCtrlC = () => leaveWhileStarting(EXIT_INTERRUPTED);
	const removeStartupTerminate = io.onTerminate?.((signal) => leaveWhileStarting(SIGNAL_EXIT + signal));
	const session = await Session.start({
		backend,
		...(memory ? { memory } : {}),
		...(memoryUnavailable === undefined ? {} : { memoryUnavailable }),
		subagents: { agents: BUILTIN_AGENTS, createBackend: () => createBackend(args.backend) },
		...(args.review
			? { review: { createBackend: () => createBackend(args.backend), consent } }
			: { reviewUnavailable: "Review is off (--no-review or ATELIER_REVIEW=off)." }),
		odd: true,
		...(io.home === undefined ? {} : { projectInstructions: { home: io.home } }),
		cwd: args.cwd,
		...(args.model === undefined ? {} : { model: args.model }),
		tools: io.tools ?? coreTools,
		systemPromptAppend: SYSTEM_PROMPT_APPEND,
		autoApprove: args.yes,
		...(args.noSandbox ? { noSandbox: true } : {}),
		approve: async ({ command, reason, always, tool }) => {
			// The command and the reason come from the model: show escape sequences and bidi controls instead of letting the terminal run them.
			const shown = visibleText(command);
			const why = reason === undefined ? undefined : visibleText(reason);
			if (tool === "edit" || tool === "write") {
				// The command is `<tool> <real absolute path>`: the question shows the path alone.
				const path = visibleText(command.slice(`${tool} `.length));
				if (!io.isTTY) {
					renderer.endLine();
					const change = tool === "edit" ? "change a file" : "create or replace a file";
					io.stderr(
						`${tool} asks to ${change} outside the working directory and needs your approval, but there is no terminal to ask (--yes does not allow this): ${path.text}\n`,
					);
					return false;
				}
				const note = path.hadHidden
					? "warning: the path contains invisible or control characters, shown as markers.\n"
					: "";
				const verb = tool === "edit" ? "Edit" : "Write";
				return askYesNo(`${verb} a file outside the working directory?\n  ${path.text}\n${note}`);
			}
			if (!io.isTTY) {
				renderer.endLine();
				io.stderr(
					why
						? `bash command asks to run outside the sandbox and needs your approval, but there is no terminal to ask (--yes does not allow this): ${shown.text}\n  reason: ${why.text}\n`
						: always
							? `bash command needs approval and there is no terminal to ask; --yes does not apply because the sandbox is off or unavailable: ${shown.text}\n`
							: `bash command needs approval; run with --yes to allow commands: ${shown.text}\n`,
				);
				return false;
			}
			const warning =
				shown.hadHidden || why?.hadHidden
					? "warning: the command contains invisible or control characters, shown as markers.\n"
					: "";
			return askYesNo(
				why
					? `Run this command OUTSIDE the sandbox?\n  ${shown.text}\n  reason: ${why.text}\n${warning}`
					: `Run this command?\n  ${shown.text}\n${warning}`,
			);
		},
	})
		.catch((error: unknown) => {
			lines.close();
			restoreTerminal();
			throw error;
		})
		.finally(() => removeStartupTerminate?.());

	// Ctrl+C: the first press interrupts the turn (and answers no to a pending
	// approval); a press with no turn running, or a second one, closes the
	// session so Claude Code exits; io.exit is only a fallback if that hangs.
	let interrupted = false;
	let quitting = false;
	let quitCode = EXIT_INTERRUPTED;
	let forceExit: NodeJS.Timeout | undefined;
	const quit = (code = EXIT_INTERRUPTED) => {
		if (quitting) return exit(code);
		quitting = true;
		quitCode = code;
		interrupted = true;
		cancelApproval?.();
		lines.close();
		// Back in line mode, a further Ctrl+C is a signal again and reaches this handler.
		restoreTerminal();
		void session.close();
		if (io.exit) forceExit = setTimeout(() => exit(code), io.forceExitMs ?? FORCE_EXIT_MS).unref();
	};
	const interrupt = () => {
		renderer.endLine();
		if (!session.busy || interrupted) return quit();
		interrupted = true;
		io.stderr("interrupting... (Ctrl+C again to quit)\n");
		cancelApproval?.();
		void session.interrupt();
	};
	onCtrlC = interrupt;
	const removeInterrupt = io.onInterrupt?.(interrupt);
	// SIGTERM and SIGHUP end the session as a second Ctrl+C would, but exit with the signal's code.
	const removeTerminate = io.onTerminate?.((signal) => quit(SIGNAL_EXIT + signal));

	const runTurn = async (events: AsyncIterable<AtelierEvent>) => {
		renderer.resetTurn();
		interrupted = false;
		for await (const event of events) renderer.render(event);
		renderer.endLine();
	};

	try {
		if (args.prompt !== undefined) {
			await runTurn(session.send(args.prompt));
			if (quitting) return quitCode;
			if (interrupted) return EXIT_INTERRUPTED;
			return renderer.failed ? EXIT_FAILED : EXIT_OK;
		}
		while (true) {
			if (io.isTTY) renderer.write(PROMPT);
			const line = await lines.next(PROMPT.length);
			// A raw terminal does not echo Enter: end the prompt line here.
			if (rawMode) renderer.endLine();
			if (quitting) return quitCode;
			if (line === undefined || line.trim() === "/exit") break;
			if (line.trim() === "") continue;
			await runTurn(commandTurn(session, line) ?? session.send(line));
			if (quitting) return quitCode;
		}
		return EXIT_OK;
	} finally {
		lines.close();
		restoreTerminal();
		// Keep the forced exit and the Ctrl+C handler until the session is really closed.
		await session.close();
		clearTimeout(forceExit);
		removeInterrupt?.();
		removeTerminate?.();
	}
}

/** Reads stdin line by line on demand; opened lazily so a one-shot run without prompts never touches stdin. */
function createLineReader(stdin: Readable): LineReader {
	/** Lines read before anyone asked for them: type-ahead for the next prompt. */
	const typed: string[] = [];
	let waiting: ((line: string | undefined) => void) | undefined;
	/** The line handed to the last read, in case its caller gives it up. */
	let handed: string | undefined;
	let ended = false;
	let rl: Interface | undefined;
	const open = () => {
		if (rl) return;
		rl = createInterface({ input: stdin, terminal: false });
		rl.on("line", (line) => {
			const resolve = waiting;
			waiting = undefined;
			if (resolve) {
				handed = line;
				resolve(line);
			} else typed.push(line);
		});
		rl.on("close", () => {
			ended = true;
			const resolve = waiting;
			waiting = undefined;
			resolve?.(undefined);
		});
	};
	return {
		open,
		next(): Promise<string | undefined> {
			open();
			if (typed.length > 0) return Promise.resolve(typed.shift());
			if (ended) return Promise.resolve(undefined);
			handed = undefined;
			return new Promise((resolve) => {
				waiting = resolve;
			});
		},
		/** Stops waiting for a read that will not be consumed (a cancelled question); its line goes to the next caller. */
		abandon(): void {
			// A line can arrive in the same tick as the cancel: it belongs to the next caller.
			if (waiting === undefined && handed !== undefined) typed.unshift(handed);
			waiting = undefined;
			handed = undefined;
		},
		/** Nothing read without a terminal is pasted. */
		pasted: () => false,
		/** Drops the lines typed so far and says how many. */
		discardTyped(): number {
			open();
			return typed.splice(0).length;
		},
		close: () => rl?.close(),
	};
}

/** The interactive commands that are turns of their own: /review [ref], /undo-correction and /compact [instructions]. */
function commandTurn(session: Session, line: string): AsyncIterable<AtelierEvent> | undefined {
	const text = line.trim();
	if (text === "/undo-correction") return session.undoCorrection();
	const review = /^\/review(?:\s+(\S+))?$/.exec(text);
	if (review) return session.review(undefined, review[1]);
	const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text);
	if (compact) return session.compact(compact[1]?.trim() || undefined);
	return undefined;
}
