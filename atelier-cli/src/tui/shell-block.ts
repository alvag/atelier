import { visibleText } from "@atelier/core";
import type { UserShellResult } from "./user-shell.ts";

/** A command the user ran in the TUI, as the core saves it. */
export type ShellRecord = UserShellResult & { command: string; excludeFromContext: boolean };

/** The last lines of the output that show, and the most output kept while the command runs. */
const MAX_LINES = 40;
const MAX_LIVE_CHARS = 16_384;

/** The tail of `text` within `MAX_LINES` lines, with a line saying how many came before. */
function lastLines(text: string): string[] {
	const lines = visibleText(text.replace(/\r\n?/g, "\n")).text.replace(/\n$/, "").split("\n");
	if (lines.length <= MAX_LINES) return lines;
	return [`… ${lines.length - MAX_LINES} earlier lines`, ...lines.slice(-MAX_LINES)];
}

/** How a finished command ended, in a line. */
function ending(result: UserShellResult): string {
	if (result.cancelled) return "cancelled";
	if (result.error !== undefined) return `error: ${visibleText(result.error).text}`;
	if (result.signal !== undefined) return `killed by ${visibleText(result.signal).text}`;
	return `exit ${result.exitCode ?? "unknown"}`;
}

/**
 * The text of a command and its output: the command after `!` (`!!` when the model does not see it), the tail of its
 * output and, once it ended, how. `result` is absent while it runs.
 */
export function shellText(command: string, exclude: boolean, output: string, result?: UserShellResult): string {
	const head = `${exclude ? "!!" : "!"} ${visibleText(command).text}${exclude ? " · excluded from context" : ""}`;
	const lines = [head, ...(output === "" ? [] : lastLines(output))];
	if (result === undefined) return [...lines, "running… (Esc to cancel)"].join("\n");
	lines.push(ending(result));
	if (result.truncated)
		lines.push(
			result.fullOutputPath === undefined
				? "output truncated"
				: `output truncated; full output: ${visibleText(result.fullOutputPath).text}`,
		);
	return lines.join("\n");
}

/** The text of a saved result. */
export const savedShellText = (record: ShellRecord) =>
	shellText(record.command, record.excludeFromContext, record.output, record);

/** A running command's block: one Text that live output and the final result update in place. */
export class ShellLine {
	#output = "";
	#done = false;
	readonly #show: (text: string) => void;
	readonly #command: string;
	readonly #exclude: boolean;
	constructor(command: string, exclude: boolean, show: (text: string) => void) {
		this.#command = command;
		this.#exclude = exclude;
		this.#show = show;
		show(shellText(command, exclude, ""));
	}
	/** Live output, kept to its last characters. */
	output(text: string): void {
		if (this.#done) return;
		this.#output = `${this.#output}${text}`.slice(-MAX_LIVE_CHARS);
		this.#show(shellText(this.#command, this.#exclude, this.#output));
	}
	/** The command ended: its result replaces the live output. */
	finish(result: UserShellResult): void {
		this.#done = true;
		this.#show(shellText(this.#command, this.#exclude, result.output, result));
	}
}
