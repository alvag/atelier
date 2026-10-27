import { type SimpleCommand, simpleCommands } from "./destructive-guard.ts";

/**
 * The rules the user can allow a `bash` command by: one per program and
 * subcommand (`open`, `npm install`, `ego-browser nodejs`), derived from what
 * the guard reads in the line. A rule with only the program covers every use
 * of it; one with a subcommand covers only that subcommand. A line is covered
 * when each of its commands is. What cannot be told from the words (a
 * substitution, `eval`, `sh -c`, a control structure, a program named by a
 * variable or a glob, a redirection to a file, any mention of `.atelier`) is
 * never covered, and asks.
 */

/** Programs that run whatever code they are given: never allowed always. */
const INTERPRETERS = new Set([
	"node",
	"nodejs",
	"deno",
	"bun",
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"mksh",
	"fish",
	"csh",
	"tcsh",
	"ruby",
	"irb",
	"perl",
	"php",
	"lua",
	"luajit",
	"osascript",
	"awk",
	"gawk",
	"mawk",
	"nawk",
	"tclsh",
	"expect",
	"pwsh",
	"Rscript",
	"npx",
	"pnpx",
	"bunx",
	"uvx",
	"sudo",
]);
const PYTHON = /^(?:python|pypy)[0-9.]*$/;
/**
 * Subcommands that download or run arbitrary code, by program: never allowed always, and never covered by the
 * program's own rule. Options can come before them (`pnpm -C . dlx`), so any of the program's words that is one counts.
 */
const LAUNCHERS: Record<string, readonly string[]> = {
	npm: ["exec", "x"],
	pnpm: ["dlx", "exec"],
	yarn: ["dlx", "exec"],
	pipx: ["run"],
	uv: ["run"],
};

/** Programs whose line is not one command the words show: they run a string, a file in this shell, or a structure. */
const NEVER = new Set([
	"eval",
	"source",
	".",
	"for",
	"case",
	"esac",
	"select",
	"function",
	"fi",
	"done",
	"}",
	"[[",
	"((",
	"coproc",
	// Builtins that change what later commands run: their PATH, functions or aliases.
	"export",
	"declare",
	"typeset",
	"local",
	"readonly",
	"alias",
	"set",
	"unset",
	"shopt",
	"trap",
	// Runners of another command the guard does not pass over as wrappers.
	"caffeinate",
	"stdbuf",
	"arch",
	"watch",
	"script",
	"parallel",
	"flock",
	"chroot",
	"unbuffer",
	"ionice",
	"taskset",
	"sandbox-exec",
]);

/** Options and subcommands with which a program runs other code: a command with one is never covered. */
const RUNS_CODE: Record<string, readonly string[]> = {
	find: ["-exec", "-execdir", "-ok", "-okdir"],
	git: [
		"-c",
		"--config-env",
		"--exec",
		"-x",
		"--upload-pack",
		"--receive-pack",
		"--extcmd",
		"foreach",
		"run",
		"filter-branch",
		"difftool",
		"mergetool",
	],
};

/** Whether a word is a long option of `options` with its value attached (`--exec=x`) or one of them as it is. */
const isOneOf = (value: string, options: readonly string[]) =>
	options.some((option) => value === option || (option.startsWith("--") && value.startsWith(`${option}=`)));
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh"]);

const PROGRAM = /^(?!-)(?!\.$)[A-Za-z0-9_./+@:-]+$/;
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
const MENTIONS_PROTECTED = /\.atelier|permissions\.json/i;

interface Key {
	program: string;
	subcommand?: string;
	/** Runs arbitrary code: an interpreter, a launcher, or a wrapper that becomes one. */
	runsCode: boolean;
	/** A launcher's subcommand: only the rule that names it (`pnpm dlx`) covers it, never the program's alone. */
	launcher: boolean;
}

const ruleOf = ({ program, subcommand }: Key) => (subcommand === undefined ? program : `${program} ${subcommand}`);

function isRunner(program: string, subcommand: string | undefined): boolean {
	const name = program.split("/").at(-1) ?? program;
	return INTERPRETERS.has(name) || PYTHON.test(name) || (subcommand !== undefined && isLauncher(name, subcommand));
}

/** Whether a word names an interpreter or a launcher program, by itself or as a path (`/bin/sh`). */
function isInterpreter(word: string): boolean {
	const name = word.split("/").at(-1) ?? word;
	return INTERPRETERS.has(name) || PYTHON.test(name);
}

const isLauncher = (name: string, subcommand: string) => LAUNCHERS[name]?.includes(subcommand) === true;

/** The first of the program's words that is one of its launchers, wherever options put it. */
function launcherOf(name: string, words: SimpleCommand["words"]): string | undefined {
	return words.slice(1).find(({ value }) => isLauncher(name, value))?.value;
}

/** The key of one command, or undefined when it can never be covered. */
function keyOf({ wrappers, words, writesFile, setsEnvironment }: SimpleCommand): Key | undefined {
	const [first, second] = words;
	if (writesFile || setsEnvironment || first === undefined || first.raw !== first.value || !PROGRAM.test(first.value))
		return undefined;
	const program = first.value;
	const name = program.split("/").at(-1) ?? program;
	if (NEVER.has(name)) return undefined;
	// A shell given a string runs it: nothing in the words says what that is.
	const shellString = ({ value }: { value: string }) => /^-[a-z]*c[a-z]*$/.test(value);
	if (SHELLS.has(name) && words.some(shellString)) return undefined;
	// Code the program runs on its own: its options for that, or an interpreter named after its subcommand (`find . -exec sh`).
	const runsCode = RUNS_CODE[name];
	if (runsCode !== undefined && words.slice(1).some(({ value }) => isOneOf(value, runsCode))) return undefined;
	if (words.slice(2).some(({ value }) => isInterpreter(value))) return undefined;
	// A subcommand named like an interpreter (`ego-browser nodejs`) is the program running code: only its own rule covers it.
	const runsInterpreter = second !== undefined && isInterpreter(second.value);
	if (runsInterpreter && SHELLS.has(second.value.split("/").at(-1) ?? "") && words.slice(2).some(shellString))
		return undefined;
	const launcher = launcherOf(name, words);
	const subcommand =
		launcher ??
		(second !== undefined && second.raw === second.value && SUBCOMMAND.test(second.value) ? second.value : undefined);
	return {
		program,
		...(subcommand === undefined ? {} : { subcommand }),
		runsCode: wrappers.includes("sudo") || isRunner(program, subcommand),
		launcher: launcher !== undefined || runsInterpreter,
	};
}

/** The keys of every command of a line, or undefined when one of them can never be covered. */
function keysOf(command: string): Key[] | undefined {
	if (MENTIONS_PROTECTED.test(command)) return undefined;
	const commands = simpleCommands(command);
	if (commands === undefined || commands.length === 0) return undefined;
	const keys: Key[] = [];
	for (const simple of commands) {
		const key = keyOf(simple);
		if (key === undefined) return undefined;
		keys.push(key);
	}
	return keys;
}

export interface CommandRules {
	/** The rule of each command of the line, in order and without repeats; undefined when the line can never be covered. */
	rules: string[] | undefined;
	/** Whether the rules may be allowed always: no command of the line runs arbitrary code. */
	always: boolean;
}

/** The rules that would cover `command`, as the question offers them. */
export function commandRules(command: string): CommandRules {
	const keys = keysOf(command);
	if (keys === undefined) return { rules: undefined, always: false };
	return { rules: [...new Set(keys.map(ruleOf))], always: keys.every((key) => !key.runsCode) };
}

/** Whether the allowed rules cover every command of the line. */
export function coveredBy(command: string, allowed: Iterable<string>): boolean {
	const rules = new Set(allowed);
	if (rules.size === 0) return false;
	const keys = keysOf(command);
	if (keys === undefined) return false;
	return keys.every(
		(key) => (!key.launcher && rules.has(key.program)) || (key.subcommand !== undefined && rules.has(ruleOf(key))),
	);
}

/** Whether `rule` is one `commandRules` could give; with `always`, also one that may be allowed always. */
export function isValidCommandRule(rule: string, { always }: { always: boolean }): boolean {
	const [program, subcommand, ...rest] = rule.split(" ");
	if (program === undefined || rest.length > 0 || !PROGRAM.test(program)) return false;
	if (subcommand !== undefined && !SUBCOMMAND.test(subcommand)) return false;
	if (NEVER.has(program.split("/").at(-1) ?? program)) return false;
	return !always || !isRunner(program, subcommand);
}
