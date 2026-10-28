import { homedir } from "node:os";
import type { SecurityRunner } from "@atelier/core";
import type { LoginOption, LoginPorts } from "./login.ts";
import type { LineReader } from "./terminal-input.ts";

export interface LineLoginOptions {
	home?: string;
	env?: Record<string, string | undefined>;
	claudeCode?: string;
	/** What asks the macOS Keychain whether it has a key; tests pass a fake. */
	runSecurity?: SecurityRunner;
	/** Whether a person types the answers (a terminal); otherwise a piped key is read and nothing is chosen. */
	interactive: boolean;
	lines: LineReader;
	/** Turns the terminal's echo off for a secret, when `lines` reads a terminal that echoes by itself. */
	hideInput?: (on: boolean) => void;
	write: (text: string) => void;
	stderr: (text: string) => void;
	/** Gives the terminal to `task` (Claude Code's sign-in) and takes it back. */
	handOver: <T>(task: () => Promise<T>) => Promise<T>;
}

const CHOOSE_WITHOUT_TERMINAL =
	"choosing needs a terminal; give the method and the provider: atelier login api-key anthropic";

/** A numbered list, its state after each entry. */
const listing = (title: string, options: readonly LoginOption[]) =>
	`${title}\n${options.map(({ label, status }, i) => `  ${i + 1}. ${label}${status === undefined ? "" : `  ${status}`}`).join("\n")}\n`;

/** `/login` in the line-by-line session and `atelier login` in a shell: lists, questions and answers as lines. */
export function lineLoginPorts(options: LineLoginOptions): LoginPorts {
	const { lines, write } = options;
	/** Asks on a line of its own; only typed text answers, and an early line is dropped. */
	const ask = async (prompt: string, hidden = false): Promise<string | undefined> => {
		if (options.interactive) lines.discardTyped();
		write(prompt);
		const hide = hidden ? options.hideInput : undefined;
		hide?.(true);
		let answer: string | undefined;
		try {
			answer = await lines.next(prompt.length, { hidden });
		} finally {
			hide?.(false);
		}
		// A raw terminal does not echo Enter, and a piped answer is not echoed at all: end the question's line here.
		write("\n");
		return answer;
	};
	return {
		home: options.home ?? homedir(),
		env: options.env ?? process.env,
		...(options.claudeCode === undefined ? {} : { claudeCode: options.claudeCode }),
		...(options.runSecurity === undefined ? {} : { runSecurity: options.runSecurity }),
		interactive: options.interactive,
		async choose(title, list) {
			if (!options.interactive) {
				options.stderr(`error: ${CHOOSE_WITHOUT_TERMINAL}\n`);
				return undefined;
			}
			write(listing(title, list));
			const answer = await ask(`Choose 1-${list.length} (Enter to cancel): `);
			if (lines.pasted()) return undefined;
			const index = Number(answer?.trim()) - 1;
			return Number.isInteger(index) && index >= 0 && index < list.length ? index : undefined;
		},
		askSecret: (prompt) => ask(prompt, true),
		async confirm(question) {
			const answer = await ask(`${question} [y/N] `);
			return !lines.pasted() && /^y(es)?$/i.test(answer?.trim() ?? "");
		},
		handOver: options.handOver,
		say: (text) => write(`${text}\n`),
		fail: (text) => options.stderr(`error: ${text}\n`),
	};
}
