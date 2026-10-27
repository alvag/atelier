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
/** Subcommands that download or run arbitrary code: never allowed always. */
const LAUNCHERS = new Set([
	"npm exec",
	"npm x",
	"pnpm dlx",
	"pnpm exec",
	"yarn dlx",
	"yarn exec",
	"pipx run",
	"uv run",
]);

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
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh"]);

const PROGRAM = /^(?!-)(?!\.$)[A-Za-z0-9_./+@:-]+$/;
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
const MENTIONS_PROTECTED = /\.atelier|permissions\.json/i;

interface Key {
	program: string;
	subcommand?: string;
	/** Runs arbitrary code: an interpreter, a launcher, or a wrapper that becomes one. */
	runsCode: boolean;
}

const ruleOf = ({ program, subcommand }: Key) => (subcommand === undefined ? program : `${program} ${subcommand}`);

function isRunner(program: string, subcommand: string | undefined): boolean {
	const name = program.split("/").at(-1) ?? program;
	return INTERPRETERS.has(name) || PYTHON.test(name) || LAUNCHERS.has(`${name} ${subcommand ?? ""}`);
}

/** The key of one command, or undefined when it can never be covered. */
function keyOf({ wrappers, words, writesFile }: SimpleCommand): Key | undefined {
	const [first, second] = words;
	if (writesFile || first === undefined || first.raw !== first.value || !PROGRAM.test(first.value)) return undefined;
	const program = first.value;
	const name = program.split("/").at(-1) ?? program;
	if (NEVER.has(name)) return undefined;
	// A shell given a string runs it: nothing in the words says what that is.
	if (SHELLS.has(name) && words.some(({ value }) => /^-[a-z]*c[a-z]*$/.test(value))) return undefined;
	const subcommand =
		second !== undefined && second.raw === second.value && SUBCOMMAND.test(second.value) ? second.value : undefined;
	return {
		program,
		...(subcommand === undefined ? {} : { subcommand }),
		runsCode: wrappers.includes("sudo") || isRunner(program, subcommand),
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
		(key) => rules.has(key.program) || (key.subcommand !== undefined && rules.has(`${key.program} ${key.subcommand}`)),
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
