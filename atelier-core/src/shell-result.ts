import { MAX_BYTES, MAX_LINES } from "./tools/limits.ts";

/**
 * A shell command the user ran outside the sandbox (the TUI's `!` and `!!`), as the client reports it once it ended.
 * The core never runs the command or reads `fullOutputPath`; it only keeps and delivers what the client says.
 */
export interface ShellResult {
	executionId: string;
	command: string;
	/** `!!`: shown and saved, never given to the model. */
	excludeFromContext: boolean;
	/** The tail of the output the client kept: at most MAX_BYTES bytes and MAX_LINES lines. */
	output: string;
	/** Null when the command did not end by exiting: it was cancelled, killed by a signal or could not start. */
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	signal?: string;
	fullOutputPath?: string;
	/** Why the command could not start, or why capturing its output failed after it ran. */
	error?: string;
}

export const MAX_EXECUTION_ID_CHARS = 200;
export const MAX_SIGNAL_CHARS = 32;
export const MAX_PATH_CHARS = 4096;
export const MAX_ERROR_CHARS = 2000;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const fits = (value: unknown, chars: number): boolean => typeof value === "string" && value.length <= chars;

/** A final newline ends the last line instead of starting another, as in the runner's tail. */
function lineCount(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Why `value` is not a result this core keeps, or undefined when it is. */
export function shellResultProblem(value: unknown): string | undefined {
	if (!isObject(value)) return "the result is not an object";
	if (
		typeof value.executionId !== "string" ||
		value.executionId === "" ||
		value.executionId.length > MAX_EXECUTION_ID_CHARS
	)
		return `executionId must be 1 to ${MAX_EXECUTION_ID_CHARS} characters`;
	if (typeof value.command !== "string" || value.command === "" || Buffer.byteLength(value.command) > MAX_BYTES)
		return `command must be 1 to ${MAX_BYTES} bytes`;
	if (typeof value.output !== "string" || Buffer.byteLength(value.output) > MAX_BYTES)
		return `output must be at most ${MAX_BYTES} bytes`;
	if (lineCount(value.output) > MAX_LINES) return `output must be at most ${MAX_LINES} lines`;
	for (const flag of ["excludeFromContext", "cancelled", "truncated"])
		if (typeof value[flag] !== "boolean") return `${flag} must be true or false`;
	if (value.signal !== undefined && !fits(value.signal, MAX_SIGNAL_CHARS)) return "signal is not a short text";
	if (value.fullOutputPath !== undefined && !fits(value.fullOutputPath, MAX_PATH_CHARS))
		return "fullOutputPath is not a path";
	if (value.error !== undefined && !fits(value.error, MAX_ERROR_CHARS)) return "error is not a short text";
	if (value.exitCode === null) {
		if (value.cancelled !== true && value.signal === undefined && value.error === undefined)
			return "exitCode is null without cancelled, signal or error";
	} else if (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))
		return "exitCode must be an integer or null";
	return undefined;
}

/** Only the fields of a result that passed `shellResultProblem`, so nothing else a client sent is kept. */
export function pickShellResult(value: ShellResult): ShellResult {
	const { executionId, command, excludeFromContext, output, exitCode, cancelled, truncated } = value;
	return {
		executionId,
		command,
		excludeFromContext,
		output,
		exitCode,
		cancelled,
		truncated,
		...(value.signal === undefined ? {} : { signal: value.signal }),
		...(value.fullOutputPath === undefined ? {} : { fullOutputPath: value.fullOutputPath }),
		...(value.error === undefined ? {} : { error: value.error }),
	};
}

/** A fence longer than any run of backticks in `content`, so the content cannot close it. */
function fence(content: string): string {
	const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** A command that ended says how; `error` only means it never started when there is no exit code to report. */
function statusLine(result: ShellResult): string {
	const ended = result.cancelled || result.signal !== undefined || result.exitCode !== null;
	if (!ended) return `Command could not be started: ${result.error}.`;
	const status = result.cancelled
		? "(command cancelled)"
		: result.signal !== undefined
			? `Command terminated by signal ${result.signal}.`
			: `Command exited with code ${result.exitCode}.`;
	return result.error === undefined ? status : `${status}\nOutput capture failed: ${result.error}.`;
}

/** What the model is told about one result. */
export function shellResultText(result: ShellResult): string {
	const output = result.output === "" ? "(no output)" : result.output;
	const commandFence = fence(result.command);
	const outputFence = fence(output);
	const truncation = result.truncated
		? `\n\nOutput truncated.${result.fullOutputPath === undefined ? "" : ` Full output: ${result.fullOutputPath}.`}`
		: "";
	return `User ran this shell command outside Atelier's sandbox:\n\n${commandFence}sh\n${result.command}\n${commandFence}\n\nOutput:\n${outputFence}text\n${output}\n${outputFence}\n\n${statusLine(result)}${truncation}`;
}

/** The results joined for the start of a prompt. */
export function shellResultsText(results: readonly ShellResult[]): string {
	return results.map(shellResultText).join("\n\n");
}
