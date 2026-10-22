import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { type AgentBackend, ClaudeCodeBackend, coreTools, Session, VERSION } from "@atelier/core";
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
}

export type BackendFactory = () => AgentBackend;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

/** Byte-stable: Claude Code caches the prompt prefix across turns. */
export const SYSTEM_PROMPT_APPEND =
	"You are running inside Atelier. Use only the Atelier tools (read, edit, bash, grep). Paths are relative to the working directory. bash commands may need the user's approval; if one is denied, do not retry it.";

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
			const answer = await lines.next();
			renderer.write("\n");
			return /^y(es)?$/i.test(answer?.trim() ?? "");
		},
	});

	let interrupted = false;
	const removeInterrupt = io.onInterrupt?.(() => {
		if (!session.busy || interrupted) {
			io.stderr("\n");
			process.exit(EXIT_INTERRUPTED);
		}
		interrupted = true;
		io.stderr("\ninterrupting... (Ctrl+C again to quit)\n");
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
			if (line === undefined || line.trim() === "/exit") break;
			if (line.trim() === "") continue;
			await runTurn(line);
		}
		return EXIT_OK;
	} finally {
		removeInterrupt?.();
		lines.close();
		await session.close();
	}
}

/** Reads stdin line by line on demand; created lazily so a one-shot run without prompts never touches stdin. */
function createLineReader(stdin: Readable) {
	let iterator: AsyncIterator<string> | undefined;
	let close = () => {};
	return {
		async next(): Promise<string | undefined> {
			if (!iterator) {
				const rl = createInterface({ input: stdin, terminal: false });
				iterator = rl[Symbol.asyncIterator]();
				close = () => rl.close();
			}
			const result = await iterator.next();
			return result.done ? undefined : result.value;
		},
		close: () => close(),
	};
}
